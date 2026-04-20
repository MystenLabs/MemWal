# MemWal Benchmark Runs

Each subfolder in this directory is a **complete benchmark run** — the scoring artifacts, the analysis reports, and the reproduction instructions. Runs are archived separately so we can compare across time (e.g., before/after a scoring fix, before/after extraction improvements).

---

## Runs so far

| Date | Benchmark | Folder | Overall Score | vs Baseline |
|---|---|---|---|---|
| 2026-04-20 | LOCOMO | [2026-04-20-locomo/](./2026-04-20-locomo/) | 52.01 (baseline) | — |
| _planned_ | LongMemEval | _pending_ | — | — |

---

## Folder convention

Each run folder is named `YYYY-MM-DD-<benchmark>/` and contains:

```
YYYY-MM-DD-<benchmark>/
  README.md              # Run metadata, TL;DR, reading order
  summary.md             # 2-page concise overview
  detailed-report.md     # Full analysis (what the benchmark is, per-category results)
  root-cause.md          # Why results look the way they do (with code references)
  results/
    <preset>.json        # Raw artifact per scoring preset
```

Optional files in specific runs:
- `comparison.md` — if a run compares multiple branches/commits side by side
- `notebooks/` — if ad-hoc analysis was done in Jupyter

---

## Reading any run

1. **Start at the run's `README.md`** — it has the headline table and links to the deeper reports
2. **Pick depth based on goal**:
   - Sharing with stakeholders → `summary.md`
   - Understanding the findings → `detailed-report.md`
   - Planning fixes → `root-cause.md`
3. **The `results/*.json` files** are the ground-truth evidence. If any number in a report looks wrong, check the JSON.

---

## Adding a new run

When a new benchmark run finishes:

1. Create `<date>-<benchmark>/` folder
2. Copy the artifact JSONs from `benchmarks/results/` into `<folder>/results/`
3. Write the three report files (summary + detailed + root cause)
4. Add a row to the table above in this README
5. Link from the run's README to any relevant previous runs for comparison

Result artifacts are kept in git (not gitignored in this folder) as evidence — they're referenced directly from the analysis reports. The `benchmarks/results/` folder is gitignored for the running framework; this folder is for archival.
