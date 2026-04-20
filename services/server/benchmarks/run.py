#!/usr/bin/env python3
"""
MemWal Retrieval Quality Benchmark — CLI Entry Point.

Usage:
    python run.py download <benchmark>
    python run.py ingest <benchmark> [--run-id ID]
    python run.py eval <benchmark> --preset <name> [--run-id ID] [--mode retrieval|e2e]
    python run.py compare <benchmark> --presets <p1,p2,...> [--run-id ID]
    python run.py full <benchmark> --presets <p1,p2,...>
    python run.py report [--run-id ID] [--benchmark <name>]
    python run.py cleanup --run-id <ID>

Examples:
    python run.py download locomo
    python run.py full locomo --presets baseline,default,recency_heavy
    python run.py report --benchmark locomo
"""

from __future__ import annotations

import argparse
import json
import logging
import subprocess
import sys
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timezone
from pathlib import Path

import yaml
from tqdm import tqdm

from core.types import (
    ScoringWeights, IngestionStats, CategoryMetrics, RunArtifact, QueryResult,
)
from core.client import MemWalClient
from core.judge import LLMJudge
from core.metrics import (
    compute_recall_at_k, compute_mrr, compute_ndcg, compute_f1,
    aggregate_metrics, aggregate_by_category,
)
from core.report import generate_comparison_table, generate_report
from benchmarks import BENCHMARKS

logger = logging.getLogger(__name__)

ROOT = Path(__file__).parent
DATASETS_DIR = ROOT / "datasets"
RESULTS_DIR = ROOT / "results"
PRESETS_DIR = ROOT / "presets"


# ============================================================
# Config loading
# ============================================================

def load_config() -> dict:
    config_path = ROOT / "config.yaml"
    if not config_path.exists():
        print(f"ERROR: {config_path} not found. Copy config.example.yaml and fill in credentials.")
        sys.exit(1)
    return yaml.safe_load(config_path.read_text())


def load_preset(name: str) -> ScoringWeights:
    preset_path = PRESETS_DIR / f"{name}.yaml"
    if not preset_path.exists():
        available = [p.stem for p in PRESETS_DIR.glob("*.yaml")]
        print(f"ERROR: Preset '{name}' not found. Available: {available}")
        sys.exit(1)
    data = yaml.safe_load(preset_path.read_text())
    w = data["weights"]
    return ScoringWeights(
        semantic=w["semantic"],
        importance=w["importance"],
        recency=w["recency"],
        frequency=w["frequency"],
    )


def get_git_commit() -> str:
    try:
        return subprocess.check_output(
            ["git", "rev-parse", "--short", "HEAD"],
            cwd=ROOT, stderr=subprocess.DEVNULL,
        ).decode().strip()
    except Exception:
        return "unknown"


def generate_run_id() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%d-%H%M%S")


# ============================================================
# Pipeline stages
# ============================================================

def stage_download(benchmark_name: str):
    """Download a benchmark dataset."""
    adapter_cls = BENCHMARKS.get(benchmark_name)
    if not adapter_cls:
        print(f"ERROR: Unknown benchmark '{benchmark_name}'. Available: {list(BENCHMARKS.keys())}")
        sys.exit(1)

    adapter = adapter_cls()
    print(f"Downloading {adapter.name}...")
    adapter.download(DATASETS_DIR)
    print(f"Done. Dataset cached at {DATASETS_DIR}/{benchmark_name}/")


def stage_ingest(
    benchmark_name: str,
    client: MemWalClient,
    run_id: str,
    config: dict,
) -> IngestionStats:
    """Ingest benchmark conversations into MemWal via /api/analyze."""
    adapter_cls = BENCHMARKS[benchmark_name]
    adapter = adapter_cls()
    conversations, _ = adapter.load(DATASETS_DIR)

    stats = IngestionStats()
    stats.conversations_processed = len(conversations)
    start = time.time()

    concurrency = config.get("benchmarks", {}).get("concurrency", 10)

    # Build the full list of ingest tasks: (namespace, label, text)
    tasks: list[tuple[str, str, str]] = []
    for conv in conversations:
        namespace = f"bench-{benchmark_name}-{conv.conversation_id}-{run_id}"
        for label, text in adapter.build_ingest_text(conv):
            tasks.append((namespace, label, text))

    def ingest_one(task):
        ns, label, text = task
        try:
            result = client.analyze(text, ns)
            return result.total
        except Exception as e:
            logger.error("Ingestion failed for %s: %s", label, e)
            return 0

    # Parallel ingestion. analyze is independent per session; MemWal serializes
    # dedup via advisory locks on content hash, so concurrent duplicates are safe.
    with ThreadPoolExecutor(max_workers=concurrency) as pool:
        futures = [pool.submit(ingest_one, t) for t in tasks]
        for fut in tqdm(as_completed(futures), total=len(futures), desc="Ingesting sessions"):
            stats.memories_stored += fut.result()

    stats.duration_seconds = time.time() - start
    print(f"Ingestion complete: {stats.memories_stored} memories from {stats.conversations_processed} conversations ({stats.duration_seconds:.0f}s)")
    return stats


def stage_eval(
    benchmark_name: str,
    client: MemWalClient,
    judge: LLMJudge,
    run_id: str,
    preset_name: str,
    weights: ScoringWeights,
    config: dict,
    mode: str = "e2e",
) -> RunArtifact:
    """Run evaluation: recall with preset weights, then judge answers."""
    adapter_cls = BENCHMARKS[benchmark_name]
    adapter = adapter_cls()
    _, queries = adapter.load(DATASETS_DIR)

    recall_limit = config.get("benchmarks", {}).get("recall_limit", 10)
    eval_runs = config.get("benchmarks", {}).get("eval_runs", 1) if mode == "e2e" else 1
    eval_concurrency = config.get("benchmarks", {}).get("eval_concurrency", 20)

    def process_query(query):
        """Full per-query pipeline: recall → answer → judge. Thread-safe."""
        namespace = f"bench-{benchmark_name}-{query.conversation_id}-{run_id}"

        try:
            recall_result = client.recall(
                query=query.question,
                namespace=namespace,
                limit=recall_limit,
                scoring_weights=weights,
            )
        except Exception as e:
            logger.error("Recall failed for %s: %s", query.query_id, e)
            return None

        memories = recall_result.memories
        memory_texts = [m.text for m in memories]
        memory_ids = [m.memory_id for m in memories]

        relevant = set(query.evidence_turn_ids) if query.evidence_turn_ids else set()
        query_metric = {
            "query_id": query.query_id,
            "category": query.category,
            "recall_at_5": compute_recall_at_k(memory_ids, relevant, 5),
            "recall_at_10": compute_recall_at_k(memory_ids, relevant, 10),
            "mrr": compute_mrr(memory_ids, relevant),
            "ndcg_at_10": compute_ndcg(memory_ids, relevant, 10),
        }

        judgment = None
        generated_answer = ""
        if mode == "e2e":
            try:
                generated_answer = judge.generate_answer(query.question, memory_texts)
                j_scores = []
                last_j = None
                for _ in range(eval_runs):
                    last_j = judge.judge(query.question, query.ground_truth_answer, generated_answer)
                    j_scores.append(last_j.j_score)
                judgment = last_j
                query_metric["j_score"] = sum(j_scores) / len(j_scores)
            except Exception as e:
                logger.error("Answer/judge failed for %s: %s", query.query_id, e)
                return None

        return QueryResult(
            query=query,
            retrieved_memories=memories,
            generated_answer=generated_answer,
            judgment=judgment,
            retrieval_metrics=query_metric,
        )

    all_query_results: list[QueryResult] = []
    per_query_metrics: list[dict] = []

    # Parallel execution — each query is fully independent.
    # HTTP client (httpx) and OpenAI client are thread-safe for concurrent calls.
    with ThreadPoolExecutor(max_workers=eval_concurrency) as pool:
        futures = [pool.submit(process_query, q) for q in queries]
        for fut in tqdm(as_completed(futures), total=len(futures), desc=f"Eval ({preset_name})"):
            result = fut.result()
            if result is None:
                continue
            all_query_results.append(result)
            per_query_metrics.append(result.retrieval_metrics)

    # Aggregate metrics (defensive: never let aggregation failure lose the raw data)
    try:
        overall = aggregate_metrics(per_query_metrics)
        by_category = aggregate_by_category(per_query_metrics, adapter.categories)
    except Exception as e:
        logger.error("Metric aggregation failed: %s. Saving raw results only.", e)
        overall = {}
        by_category = {}

    # Build artifact
    artifact = RunArtifact(
        run_id=run_id,
        timestamp=datetime.now(timezone.utc).isoformat(),
        git_commit=get_git_commit(),
        benchmark=benchmark_name,
        preset=preset_name,
        config={
            "server_url": config.get("server", {}).get("url", ""),
            "scoring_weights": weights.to_dict(),
            "recall_limit": recall_limit,
            "eval_runs": eval_runs,
            "mode": mode,
            "judge_model": config.get("judge", {}).get("model", ""),
            "answer_model": config.get("answer", {}).get("model", ""),
        },
        metrics_overall=_dict_to_category_metrics(overall),
        metrics_by_category={cat: _dict_to_category_metrics(m) for cat, m in by_category.items()},
        query_results=all_query_results,
    )

    # Save artifact
    RESULTS_DIR.mkdir(parents=True, exist_ok=True)
    artifact_path = RESULTS_DIR / f"{run_id}-{benchmark_name}-{preset_name}.json"
    artifact_path.write_text(_serialize_artifact(artifact))
    print(f"Results saved to {artifact_path}")

    # Print summary
    if "j_score" in overall:
        j = overall["j_score"]
        print(f"J-score: {j['mean']:.1f} +/- {j['std']:.1f}")
    if "recall_at_5" in overall:
        r = overall["recall_at_5"]
        print(f"Recall@5: {r['mean']:.3f} +/- {r['std']:.3f}")

    return artifact


def stage_compare(
    benchmark_name: str,
    client: MemWalClient,
    judge: LLMJudge,
    run_id: str,
    preset_names: list[str],
    config: dict,
    mode: str = "e2e",
):
    """Run evaluation for multiple presets, then print comparison table."""
    results = []
    for preset_name in preset_names:
        print(f"\n{'='*60}")
        print(f"  Preset: {preset_name}")
        print(f"{'='*60}")
        weights = load_preset(preset_name)
        artifact = stage_eval(
            benchmark_name, client, judge, run_id,
            preset_name, weights, config, mode,
        )
        # Reload the saved JSON for the comparison table
        artifact_path = RESULTS_DIR / f"{run_id}-{benchmark_name}-{preset_name}.json"
        results.append(json.loads(artifact_path.read_text()))

    print(f"\n{'='*60}")
    print(f"  Comparison: {benchmark_name.upper()}")
    print(f"{'='*60}\n")

    metric = "j_score" if mode == "e2e" else "recall_at_5"
    table = generate_comparison_table(results, benchmark_name, metric)
    print(table)


def stage_cleanup(client: MemWalClient, run_id: str, benchmark_name: str | None = None):
    """Clean up benchmark namespaces for a run."""
    print(f"Cleaning up namespaces for run {run_id}...")

    benchmarks_to_clean = [benchmark_name] if benchmark_name else list(BENCHMARKS.keys())
    for bname in benchmarks_to_clean:
        adapter_cls = BENCHMARKS.get(bname)
        if not adapter_cls:
            continue
        adapter = adapter_cls()
        try:
            conversations, _ = adapter.load(DATASETS_DIR)
        except FileNotFoundError:
            continue

        for conv in conversations:
            ns = f"bench-{bname}-{conv.conversation_id}-{run_id}"
            try:
                client.forget_namespace(ns)
                logger.debug("Cleaned up %s", ns)
            except Exception as e:
                logger.warning("Failed to clean %s: %s", ns, e)

    print("Cleanup complete.")


# ============================================================
# Helpers
# ============================================================

def _dict_to_category_metrics(d: dict) -> CategoryMetrics:
    """Convert aggregate_metrics output dict to CategoryMetrics dataclass."""
    cm = CategoryMetrics()
    if "j_score" in d:
        cm.j_score_mean = d["j_score"].get("mean", 0)
        cm.j_score_std = d["j_score"].get("std", 0)
    if "recall_at_5" in d:
        cm.recall_at_5 = d["recall_at_5"].get("mean", 0)
    if "recall_at_10" in d:
        cm.recall_at_10 = d["recall_at_10"].get("mean", 0)
    if "mrr" in d:
        cm.mrr = d["mrr"].get("mean", 0)
    if "ndcg_at_10" in d:
        cm.ndcg_at_10 = d["ndcg_at_10"].get("mean", 0)
    return cm


def _serialize_artifact(artifact: RunArtifact) -> str:
    """Serialize RunArtifact to JSON, handling dataclasses."""
    import dataclasses

    def default(obj):
        if dataclasses.is_dataclass(obj) and not isinstance(obj, type):
            return dataclasses.asdict(obj)
        raise TypeError(f"Object of type {type(obj)} is not JSON serializable")

    return json.dumps(dataclasses.asdict(artifact), indent=2, default=default)


# ============================================================
# CLI
# ============================================================

def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="MemWal Retrieval Quality Benchmark",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=__doc__,
    )
    parser.add_argument("-v", "--verbose", action="store_true", help="Debug logging")
    sub = parser.add_subparsers(dest="command", required=True)

    # download
    dl = sub.add_parser("download", help="Download benchmark dataset")
    dl.add_argument("benchmark", choices=list(BENCHMARKS.keys()))

    # ingest
    ing = sub.add_parser("ingest", help="Ingest benchmark conversations into MemWal")
    ing.add_argument("benchmark", choices=list(BENCHMARKS.keys()))
    ing.add_argument("--run-id", default=None)

    # eval
    ev = sub.add_parser("eval", help="Evaluate retrieval with a single preset")
    ev.add_argument("benchmark", choices=list(BENCHMARKS.keys()))
    ev.add_argument("--preset", required=True)
    ev.add_argument("--run-id", default=None)
    ev.add_argument("--mode", choices=["retrieval", "e2e"], default="e2e")

    # compare
    cmp = sub.add_parser("compare", help="Compare multiple presets")
    cmp.add_argument("benchmark", choices=list(BENCHMARKS.keys()))
    cmp.add_argument("--presets", required=True, help="Comma-separated preset names")
    cmp.add_argument("--run-id", default=None)
    cmp.add_argument("--mode", choices=["retrieval", "e2e"], default="e2e")

    # full
    full = sub.add_parser("full", help="Ingest + compare in one go")
    full.add_argument("benchmark", choices=list(BENCHMARKS.keys()))
    full.add_argument("--presets", required=True, help="Comma-separated preset names")
    full.add_argument("--mode", choices=["retrieval", "e2e"], default="e2e")
    full.add_argument("--run-id", default=None, help="Reuse an existing ingestion")
    full.add_argument("--skip-ingest", action="store_true", help="Skip ingestion stage (assumes run-id already ingested)")

    # report
    rpt = sub.add_parser("report", help="View results")
    rpt.add_argument("--benchmark", default=None)
    rpt.add_argument("--run-id", default=None)

    # cleanup
    cl = sub.add_parser("cleanup", help="Clean up benchmark data from MemWal")
    cl.add_argument("--run-id", required=True)
    cl.add_argument("--benchmark", default=None)

    return parser


def main():
    parser = build_parser()
    args = parser.parse_args()

    logging.basicConfig(
        level=logging.DEBUG if args.verbose else logging.INFO,
        format="%(asctime)s %(levelname)s %(name)s: %(message)s",
        datefmt="%H:%M:%S",
    )

    # Commands that don't need config/client
    if args.command == "download":
        stage_download(args.benchmark)
        return

    if args.command == "report":
        benchmark = args.benchmark
        if benchmark:
            print(generate_report(RESULTS_DIR, benchmark))
        else:
            for bname in BENCHMARKS:
                report = generate_report(RESULTS_DIR, bname)
                if "No results" not in report:
                    print(report)
                    print()
        return

    # Commands that need config + client
    config = load_config()
    server_cfg = config["server"]

    client = MemWalClient(
        server_url=server_cfg["url"],
        delegate_key_hex=server_cfg["delegate_key"],
        account_id=server_cfg["account_id"],
    )

    # Verify server is reachable
    try:
        health = client.health()
        print(f"Server: {server_cfg['url']} ({health.get('version', '?')})")
    except Exception as e:
        print(f"ERROR: Cannot reach server at {server_cfg['url']}: {e}")
        sys.exit(1)

    judge_cfg = config.get("judge", {})
    answer_cfg = config.get("answer", {})
    judge = LLMJudge(
        judge_model=judge_cfg.get("model", "gpt-4o"),
        answer_model=answer_cfg.get("model", "gpt-4o-mini"),
        api_key=judge_cfg.get("api_key", ""),
        api_base=judge_cfg.get("api_base", "https://api.openai.com/v1"),
    )

    run_id = getattr(args, "run_id", None) or generate_run_id()
    print(f"Run ID: {run_id}")

    try:
        if args.command == "ingest":
            stage_ingest(args.benchmark, client, run_id, config)

        elif args.command == "eval":
            weights = load_preset(args.preset)
            stage_eval(args.benchmark, client, judge, run_id, args.preset, weights, config, args.mode)

        elif args.command == "compare":
            preset_names = [p.strip() for p in args.presets.split(",")]
            stage_compare(args.benchmark, client, judge, run_id, preset_names, config, args.mode)

        elif args.command == "full":
            preset_names = [p.strip() for p in args.presets.split(",")]
            if not getattr(args, "skip_ingest", False):
                stage_ingest(args.benchmark, client, run_id, config)
            else:
                print(f"Skipping ingestion — reusing run {run_id}")
            stage_compare(args.benchmark, client, judge, run_id, preset_names, config, args.mode)

        elif args.command == "cleanup":
            stage_cleanup(client, args.run_id, getattr(args, "benchmark", None))

    finally:
        client.close()


if __name__ == "__main__":
    main()
