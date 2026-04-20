"""
Report generation for benchmark results.

Produces markdown comparison tables suitable for:
- Terminal output
- Notion/GitHub documentation
- Assessment documents
"""

from __future__ import annotations

import json
from pathlib import Path
from tabulate import tabulate


# Published baselines for comparison
PUBLISHED_BASELINES = {
    "locomo": {
        "Mem0 Base": {
            "single_hop": 67.13,
            "multi_hop": 51.15,
            "temporal": 55.51,
            "open_domain": 72.93,
        },
        "Mem0 Graph": {
            "single_hop": 65.71,
            "multi_hop": 47.19,
            "temporal": 58.13,
            "open_domain": 75.71,
        },
    },
    "longmemeval": {
        "Supermemory": {"overall": 85.4},
        "Zep": {"overall": 63.8},
        "Mem0": {"overall": 49.0},
    },
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
        benchmark: "locomo", "longmemeval", or "convomem"
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
    baselines = PUBLISHED_BASELINES.get(benchmark, {})
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
