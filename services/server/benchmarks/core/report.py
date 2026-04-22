"""
Report generation for benchmark results.

Produces markdown comparison tables suitable for:
- Terminal output
- Notion/GitHub documentation
- Assessment documents

Published baselines are loaded from YAML files in the reference_scores/
directory at import time. To add a baseline for a new benchmark, drop a
file named <benchmark>.yaml alongside the existing ones — no code change.
"""

from __future__ import annotations

import json
import logging
from functools import lru_cache
from pathlib import Path

import yaml
from tabulate import tabulate

logger = logging.getLogger(__name__)

# Reference scores live in benchmarks/reference_scores/<benchmark>.yaml
# (two directories up from this file: core/report.py → benchmarks/ → reference_scores/).
_REFERENCE_SCORES_DIR = Path(__file__).resolve().parent.parent / "reference_scores"


@lru_cache(maxsize=None)
def _load_reference_scores(benchmark: str) -> dict[str, dict]:
    """
    Load published baseline scores for a benchmark from its YAML file.

    Returns a dict shaped like:
        {
          "Mem0 Base": {
              "scores": {"single_hop": 67.13, ...},
              "source": "...",
              "version": "...",
              "notes": "...",
          },
          ...
        }

    Returns an empty dict if the benchmark has no reference file yet.
    """
    path = _REFERENCE_SCORES_DIR / f"{benchmark}.yaml"
    if not path.exists():
        logger.debug("No reference_scores file for benchmark '%s' at %s", benchmark, path)
        return {}

    try:
        raw = yaml.safe_load(path.read_text()) or {}
    except yaml.YAMLError as e:
        logger.warning("Malformed reference_scores/%s.yaml: %s", benchmark, e)
        return {}

    if not isinstance(raw, dict):
        logger.warning("reference_scores/%s.yaml must be a mapping at top level", benchmark)
        return {}

    # Validate each entry has a `scores` dict; drop anything malformed rather
    # than crashing the whole report on one bad entry.
    cleaned: dict[str, dict] = {}
    for system_name, entry in raw.items():
        if not isinstance(entry, dict) or "scores" not in entry:
            logger.warning(
                "reference_scores/%s.yaml: entry '%s' missing 'scores' key, skipping",
                benchmark, system_name,
            )
            continue
        if not isinstance(entry["scores"], dict):
            logger.warning(
                "reference_scores/%s.yaml: entry '%s' has non-dict scores, skipping",
                benchmark, system_name,
            )
            continue
        cleaned[system_name] = entry
    return cleaned


def _baseline_scores_dict(benchmark: str) -> dict[str, dict[str, float]]:
    """
    Backward-compatible view: {system_name: {category: score}}.
    Used by the table rendering below.
    """
    return {
        name: entry.get("scores", {})
        for name, entry in _load_reference_scores(benchmark).items()
    }


def generate_comparison_table(
    results: list[dict],
    benchmark: str,
    metric: str = "j_score",
) -> str:
    """
    Generate a markdown comparison table across presets and baselines.

    Args:
        results: list of run artifacts (dicts loaded from JSON)
        benchmark: "locomo" or "longmemeval"
        metric: which metric to display ("j_score", "recall_at_5", etc.)

    Returns:
        Markdown table string.
    """
    if not results:
        return "No results to compare."

    # Collect all categories across results
    all_categories = set()
    for r in results:
        by_cat = r.get("metrics", {}).get("by_category", {})
        all_categories.update(by_cat.keys())
    categories = sorted(all_categories)

    # Build header: Category | Preset1 | Preset2 | ... | Baseline1 | ...
    presets = [r.get("preset", "unknown") for r in results]
    baselines = _baseline_scores_dict(benchmark)
    headers = ["Category"] + presets + list(baselines.keys())

    # Build rows
    rows = []
    for cat in categories:
        row = [cat]
        # MemWal presets
        for r in results:
            by_cat = r.get("metrics", {}).get("by_category", {})
            cat_metrics = by_cat.get(cat, {})
            value = cat_metrics.get(metric, {})
            if isinstance(value, dict):
                mean = value.get("mean", 0)
                std = value.get("std", 0)
                row.append(f"{mean:.1f} +/-{std:.1f}")
            elif isinstance(value, (int, float)):
                row.append(f"{value:.1f}")
            else:
                row.append("-")
        # Published baselines
        for baseline_name, baseline_scores in baselines.items():
            score = baseline_scores.get(cat)
            row.append(f"{score:.2f}" if score is not None else "-")
        rows.append(row)

    # Overall row
    overall_row = ["**Overall**"]
    for r in results:
        overall = r.get("metrics", {}).get("overall", {})
        value = overall.get(metric, {})
        if isinstance(value, dict):
            mean = value.get("mean", 0)
            std = value.get("std", 0)
            overall_row.append(f"**{mean:.1f} +/-{std:.1f}**")
        elif isinstance(value, (int, float)):
            overall_row.append(f"**{value:.1f}**")
        else:
            overall_row.append("-")
    for baseline_name, baseline_scores in baselines.items():
        score = baseline_scores.get("overall")
        overall_row.append(f"**{score:.2f}**" if score is not None else "-")
    rows.append(overall_row)

    return tabulate(rows, headers=headers, tablefmt="github")


def generate_report(results_dir: str | Path, benchmark: str) -> str:
    """
    Generate a full markdown report from all results for a benchmark.

    Loads all JSON artifacts in results_dir matching the benchmark name,
    groups by preset, and produces comparison tables.
    """
    results_dir = Path(results_dir)
    artifacts = []

    for f in sorted(results_dir.glob("*.json")):
        try:
            data = json.loads(f.read_text())
            if data.get("benchmark") == benchmark:
                artifacts.append(data)
        except (json.JSONDecodeError, KeyError):
            continue

    if not artifacts:
        return f"No results found for benchmark: {benchmark}"

    # Group by preset, take latest run per preset
    by_preset: dict[str, dict] = {}
    for a in artifacts:
        preset = a.get("preset", "unknown")
        by_preset[preset] = a  # last wins (sorted by filename = chronological)

    latest = list(by_preset.values())

    lines = [
        f"# {benchmark.upper()} Benchmark Results",
        "",
        f"Presets compared: {', '.join(by_preset.keys())}",
        "",
        "## J-Score Comparison",
        "",
        generate_comparison_table(latest, benchmark, "j_score"),
        "",
        "## Recall@5 Comparison",
        "",
        generate_comparison_table(latest, benchmark, "recall_at_5"),
        "",
        "## Cost Summary",
        "",
    ]

    for r in latest:
        preset = r.get("preset", "?")
        cost = r.get("cost_usd", 0)
        lines.append(f"- **{preset}**: ${cost:.2f}")

    return "\n".join(lines)
