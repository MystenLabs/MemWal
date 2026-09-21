/**
 * Deterministic application policy.
 * Combines semantic distance with optional Jev signals. Never deletes/overwrites memory.
 */

import { ROUTES } from './types.js';

/** @typedef {import('./types.js').Route} Route */
/** @typedef {import('./types.js').Candidate} Candidate */
/** @typedef {import('./types.js').JevDecision} JevDecision */

export const DEFAULT_DISTANCE_THRESHOLD = 0.35;
export const DEFAULT_ANSWERABLE_NOUL_THRESHOLD = 0.55;
export const DEFAULT_ROUTE_CONFIDENCE_THRESHOLD = 0.45;

/**
 * Baseline: order by semantic distance only; route by top-1 distance threshold.
 * @param {Candidate[]} candidates
 * @param {{ distanceThreshold?: number }} [opts]
 */
export function policyWithoutJev(candidates, opts = {}) {
  const distanceThreshold = opts.distanceThreshold ?? DEFAULT_DISTANCE_THRESHOLD;
  const ranked = [...candidates].sort((a, b) => a.distance - b.distance);
  const top1 = ranked[0] ?? null;
  const answerable = Boolean(top1 && top1.distance < distanceThreshold);
  /** @type {Route} */
  const route = answerable ? 'answer_from_memory' : 'llm';
  return {
    rankedIds: ranked.map((c) => c.id),
    top1Id: top1?.id ?? null,
    predictedAnswerable: answerable,
    predictedRoute: route,
  };
}

/**
 * Keyword/heuristic stub baseline (dumb third column).
 * Boosts candidates that share query tokens; penalizes injection-like strings.
 * @param {string} query
 * @param {Candidate[]} candidates
 * @param {{ distanceThreshold?: number }} [opts]
 */
export function policyWithLlmStub(query, candidates, opts = {}) {
  const distanceThreshold = opts.distanceThreshold ?? DEFAULT_DISTANCE_THRESHOLD;
  const qTokens = tokenize(query);
  const scored = candidates.map((c) => {
    const tTokens = tokenize(c.text);
    const overlap = jaccard(qTokens, tTokens);
    const injectionPenalty = looksLikeInjection(c.text) ? 0.5 : 0;
    // Lower composite = better (align with distance semantics).
    const composite = c.distance - 0.4 * overlap + injectionPenalty;
    return { c, composite, overlap };
  });
  scored.sort((a, b) => a.composite - b.composite);
  const top1 = scored[0]?.c ?? null;
  const answerable = Boolean(
    top1 && top1.distance < distanceThreshold + 0.05 && !looksLikeInjection(top1.text),
  );
  /** @type {Route} */
  let route = 'llm';
  if (answerable) route = 'answer_from_memory';
  else if (scored.some((s) => s.overlap > 0.15 && looksLikeInjection(s.c.text))) route = 'review';
  else if (scored.some((s) => s.overlap > 0.2) && !answerable) route = 'clarify';

  return {
    rankedIds: scored.map((s) => s.c.id),
    top1Id: top1?.id ?? null,
    predictedAnswerable: answerable,
    predictedRoute: route,
  };
}

/**
 * Combine WM distances with Jev judgments into a reranked list + route.
 * @param {Candidate[]} candidates
 * @param {JevDecision} jev
 * @param {{
 *   distanceThreshold?: number,
 *   answerableNoulThreshold?: number,
 *   routeConfidenceThreshold?: number,
 * }} [opts]
 */
export function policyWithJev(candidates, jev, opts = {}) {
  const distanceThreshold = opts.distanceThreshold ?? DEFAULT_DISTANCE_THRESHOLD;
  const answerableNoulThreshold =
    opts.answerableNoulThreshold ?? DEFAULT_ANSWERABLE_NOUL_THRESHOLD;
  const routeConfidenceThreshold =
    opts.routeConfidenceThreshold ?? DEFAULT_ROUTE_CONFIDENCE_THRESHOLD;

  if (jev.fallback) {
    // Jev unavailable → fall back to current WM behavior.
    const base = policyWithoutJev(candidates, { distanceThreshold });
    return { ...base, fallback: true };
  }

  const byId = new Map(jev.judgments.map((j) => [j.candidateId, j]));

  const scored = candidates.map((c) => {
    const j = byId.get(c.id);
    const relevance = j?.relevanceScore ?? 0; // 0..3 expected
    const ans = j?.answerableNoul ?? 0;
    // Lower composite = better.
    // Distance in [0,1], relevance boost up to ~0.45, answerable boost up to ~0.2.
    const composite = c.distance - 0.15 * relevance - 0.2 * ans;
    return { c, composite, relevance, ans };
  });
  scored.sort((a, b) => a.composite - b.composite);

  const top1 = scored[0]?.c ?? null;
  const topJudgment = top1 ? byId.get(top1.id) : null;

  let predictedAnswerable =
    jev.overallAnswerableNoul >= answerableNoulThreshold &&
    Boolean(topJudgment && topJudgment.answerableNoul >= answerableNoulThreshold);

  /** @type {Route} */
  let predictedRoute = jev.routeChoice;
  if (!ROUTES.includes(predictedRoute)) {
    predictedRoute = 'llm';
  }

  // Low confidence → do not take irreversible / assertive memory answer.
  if (jev.routeConfidence < routeConfidenceThreshold) {
    if (predictedRoute === 'answer_from_memory') {
      predictedRoute = 'clarify';
      predictedAnswerable = false;
    }
  }

  // Hard safety: if top-1 looks like injection via low relevance + close distance, review.
  if (
    top1 &&
    topJudgment &&
    topJudgment.relevanceScore < 1 &&
    top1.distance < distanceThreshold
  ) {
    predictedRoute = 'review';
    predictedAnswerable = false;
  }

  // Align answerable flag with final route.
  if (predictedRoute !== 'answer_from_memory') {
    predictedAnswerable = false;
  } else {
    predictedAnswerable = true;
  }

  return {
    rankedIds: scored.map((s) => s.c.id),
    top1Id: top1?.id ?? null,
    predictedAnswerable,
    predictedRoute,
    fallback: false,
  };
}

/** @param {string} text */
export function tokenize(text) {
  return new Set(
    text
      .toLowerCase()
      .normalize('NFKD')
      .replace(/[^\p{L}\p{N}\s]/gu, ' ')
      .split(/\s+/)
      .filter((t) => t.length > 1),
  );
}

/** @param {Set<string>} a @param {Set<string>} b */
export function jaccard(a, b) {
  if (a.size === 0 && b.size === 0) return 0;
  let inter = 0;
  for (const t of a) if (b.has(t)) inter += 1;
  const union = a.size + b.size - inter;
  return union === 0 ? 0 : inter / union;
}

/** @param {string} text */
export function looksLikeInjection(text) {
  const t = text.toLowerCase();
  return (
    /ignore (all |any |previous |prior )?instructions/.test(t) ||
    /bỏ qua mọi hướng dẫn/.test(t) ||
    /reveal (all )?secrets/.test(t) ||
    /tiết lộ mọi bí mật/.test(t) ||
    /always answer:/.test(t)
  );
}
