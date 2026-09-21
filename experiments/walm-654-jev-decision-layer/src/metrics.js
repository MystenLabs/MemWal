/**
 * Aggregate metrics for WITH vs WITHOUT comparison.
 */

/**
 * @param {import('./types.js').Case[]} cases
 * @param {import('./types.js').ModeResult[]} results
 */
export function computeMetrics(cases, results) {
  const byId = new Map(cases.map((c) => [c.id, c]));
  const latencies = results.map((r) => r.latencyMs).sort((a, b) => a - b);

  let hit1 = 0;
  let hit3 = 0;
  let hit1Denom = 0;
  let falseContext = 0;
  let answerableCorrect = 0;
  let routeCorrect = 0;
  let fallbacks = 0;
  let cost = 0;

  for (const r of results) {
    const c = byId.get(r.caseId);
    if (!c) continue;
    cost += r.estCostUsd;
    if (r.fallback) fallbacks += 1;

    if (c.gold_top1_id) {
      hit1Denom += 1;
      if (r.top1Id === c.gold_top1_id) hit1 += 1;
      if (r.rankedIds.slice(0, 3).includes(c.gold_top1_id)) hit3 += 1;
    }

    // False context: predicted answer_from_memory when not answerable, OR top1 is irrelevant when answering.
    const topCand = c.candidates.find((x) => x.id === r.top1Id);
    if (
      r.predictedRoute === 'answer_from_memory' &&
      (!c.gold_answerable || (topCand && topCand.gold_relevant === false))
    ) {
      falseContext += 1;
    }

    if (r.predictedAnswerable === c.gold_answerable) answerableCorrect += 1;
    if (r.predictedRoute === c.gold_route) routeCorrect += 1;
  }

  const n = results.length || 1;
  return {
    n,
    hit_at_1: hit1Denom ? hit1 / hit1Denom : null,
    hit_at_3: hit1Denom ? hit3 / hit1Denom : null,
    false_context_rate: falseContext / n,
    answerability_accuracy: answerableCorrect / n,
    route_accuracy: routeCorrect / n,
    p50_latency_ms: percentile(latencies, 0.5),
    p95_latency_ms: percentile(latencies, 0.95),
    est_cost_usd: cost,
    fallback_rate: fallbacks / n,
  };
}

/**
 * @param {import('./types.js').Case[]} cases
 * @param {import('./types.js').ModeResult[]} results
 * @param {'EN'|'VI'|null} lang
 */
export function computeMetricsForLang(cases, results, lang) {
  const filteredCases = lang ? cases.filter((c) => c.lang === lang) : cases;
  const ids = new Set(filteredCases.map((c) => c.id));
  const filteredResults = results.filter((r) => ids.has(r.caseId));
  return computeMetrics(filteredCases, filteredResults);
}

/** @param {number[]} sorted @param {number} p */
export function percentile(sorted, p) {
  if (!sorted.length) return 0;
  const idx = Math.min(sorted.length - 1, Math.ceil(p * sorted.length) - 1);
  return sorted[Math.max(0, idx)];
}

/**
 * Format a comparison table across modes, optionally split by language.
 * @param {Record<string, ReturnType<typeof computeMetrics>>} byMode
 * @param {string} [title]
 */
export function formatTable(byMode, title = 'Benchmark') {
  const modes = Object.keys(byMode);
  const rows = [
    ['metric', ...modes],
    ['n', ...modes.map((m) => String(byMode[m].n))],
    ['hit@1', ...modes.map((m) => fmtRate(byMode[m].hit_at_1))],
    ['hit@3', ...modes.map((m) => fmtRate(byMode[m].hit_at_3))],
    ['false_context_rate', ...modes.map((m) => fmtRate(byMode[m].false_context_rate))],
    [
      'answerability_accuracy',
      ...modes.map((m) => fmtRate(byMode[m].answerability_accuracy)),
    ],
    ['route_accuracy', ...modes.map((m) => fmtRate(byMode[m].route_accuracy))],
    ['p50_latency_ms', ...modes.map((m) => byMode[m].p50_latency_ms.toFixed(2))],
    ['p95_latency_ms', ...modes.map((m) => byMode[m].p95_latency_ms.toFixed(2))],
    ['est_cost_usd', ...modes.map((m) => byMode[m].est_cost_usd.toFixed(6))],
    ['fallback_rate', ...modes.map((m) => fmtRate(byMode[m].fallback_rate))],
  ];

  const widths = rows[0].map((_, col) =>
    Math.max(...rows.map((r) => String(r[col]).length)),
  );

  const lines = [];
  lines.push(`## ${title}`);
  lines.push('');
  for (let i = 0; i < rows.length; i++) {
    const line =
      '| ' +
      rows[i].map((cell, col) => String(cell).padEnd(widths[col])).join(' | ') +
      ' |';
    lines.push(line);
    if (i === 0) {
      lines.push('| ' + widths.map((w) => '-'.repeat(w)).join(' | ') + ' |');
    }
  }
  return lines.join('\n');
}

/** @param {number|null} x */
function fmtRate(x) {
  if (x === null || Number.isNaN(x)) return 'n/a';
  return (x * 100).toFixed(1) + '%';
}
