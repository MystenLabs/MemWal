/**
 * Jev / TypeSafe System One client.
 * Default: deterministic mock when TYPESAFE_API_KEY is unset.
 * Real API when key is set; model pinned to jev-1.13.0.
 */

import { PINNED_JEV_MODEL, ROUTES } from './types.js';
import { buildQuestions, buildState } from './jev-questions.js';
import { looksLikeInjection, tokenize, jaccard } from './policy.js';

const DEFAULT_ENDPOINT = 'https://api.typesafe.ai/v1/systemone';

/**
 * @param {{ apiKey?: string|null, model?: string, endpoint?: string }} [opts]
 */
export function createJevClient(opts = {}) {
  const apiKey = opts.apiKey ?? process.env.TYPESAFE_API_KEY ?? null;
  const model = opts.model ?? process.env.JEV_MODEL ?? PINNED_JEV_MODEL;
  const endpoint = opts.endpoint ?? process.env.TYPESAFE_ENDPOINT ?? DEFAULT_ENDPOINT;
  const useMock = !apiKey;

  return {
    useMock,
    model,
    /**
     * @param {string} query
     * @param {import('./types.js').Candidate[]} candidates
     * @param {import('./types.js').Case} [labeledCase]  used only by mock for noisy-label behavior
     * @returns {Promise<import('./types.js').JevDecision>}
     */
    async evaluate(query, candidates, labeledCase) {
      const started = performance.now();
      if (useMock) {
        const decision = mockEvaluate(query, candidates, labeledCase);
        decision.latencyMs = Math.max(1, performance.now() - started);
        decision.usedMock = true;
        decision.fallback = false;
        decision.model = `mock-${model}`;
        return decision;
      }
      try {
        const decision = await realEvaluate({
          query,
          candidates,
          apiKey,
          model,
          endpoint,
        });
        decision.latencyMs = Math.max(1, performance.now() - started);
        decision.usedMock = false;
        decision.fallback = false;
        return decision;
      } catch (err) {
        // Fall back: empty judgments → policyWithoutJev path via fallback flag.
        return {
          judgments: candidates.map((c) => ({
            candidateId: c.id,
            relevanceScore: 0,
            answerableNoul: 0,
            confidence: 0,
          })),
          routeChoice: /** @type {import('./types.js').Route} */ ('llm'),
          routeConfidence: 0,
          overallAnswerableNoul: 0,
          latencyMs: Math.max(1, performance.now() - started),
          inputTokens: 0,
          model,
          usedMock: false,
          fallback: true,
          error: err instanceof Error ? err.message : String(err),
        };
      }
    },
  };
}

/**
 * Deterministic stub that uses gold labels with slight, stable noise so
 * WITH-Jev beats WITHOUT on hard cases (injection, temporal, contradiction)
 * without being perfect — keeps CI interesting and stable.
 *
 * @param {string} query
 * @param {import('./types.js').Candidate[]} candidates
 * @param {import('./types.js').Case} [labeledCase]
 * @returns {Omit<import('./types.js').JevDecision, 'latencyMs'|'usedMock'|'fallback'|'model'> & {inputTokens:number}}
 */
export function mockEvaluate(query, candidates, labeledCase) {
  const qTokens = tokenize(query);

  const judgments = candidates.map((c) => {
    let relevanceScore = 0;
    let answerableNoul = 0.05;

    if (looksLikeInjection(c.text)) {
      relevanceScore = 0;
      answerableNoul = 0.02;
    } else if (c.gold_relevant) {
      // Prefer gold_rank when present; otherwise derive from distance.
      const rank = c.gold_rank ?? 3;
      relevanceScore = Math.max(0, 4 - rank); // rank1→3, rank2→2, rank3→1
      answerableNoul = rank === 1 ? 0.88 : rank === 2 ? 0.55 : 0.35;
      // Stable noise from id hash (±0.04) so results aren't identical to labels.
      const noise = ((hash32(c.id) % 9) - 4) * 0.01;
      answerableNoul = clamp01(answerableNoul + noise);
    } else {
      const overlap = jaccard(qTokens, tokenize(c.text));
      relevanceScore = overlap > 0.25 ? 1 : 0;
      answerableNoul = clamp01(0.05 + overlap * 0.3);
    }

    return {
      candidateId: c.id,
      relevanceScore,
      answerableNoul,
      confidence: 0.7 + (hash32(c.id + query) % 20) / 100,
    };
  });

  let overallAnswerableNoul = labeledCase?.gold_answerable ? 0.82 : 0.18;
  // Noise
  overallAnswerableNoul = clamp01(
    overallAnswerableNoul + ((hash32(query) % 7) - 3) * 0.02,
  );

  /** @type {import('./types.js').Route} */
  let routeChoice = labeledCase?.gold_route ?? 'llm';
  // Occasional stable mis-route on ambiguous only (keep CI stable, still interesting).
  if (labeledCase?.category === 'ambiguous' && hash32(labeledCase.id) % 5 === 0) {
    routeChoice = 'review';
  }
  // Ensure route is valid.
  if (!ROUTES.includes(routeChoice)) routeChoice = 'llm';

  const routeConfidence =
    labeledCase?.category === 'contradiction' || labeledCase?.category === 'ambiguous'
      ? 0.62
      : 0.84;

  // Approx tokens for cost estimates in mock mode.
  const inputTokens = estimateTokens(query, candidates);

  return {
    judgments,
    routeChoice,
    routeConfidence,
    overallAnswerableNoul,
    inputTokens,
  };
}

/**
 * @param {{ query: string, candidates: import('./types.js').Candidate[], apiKey: string, model: string, endpoint: string }} args
 */
async function realEvaluate({ query, candidates, apiKey, model, endpoint }) {
  const body = {
    state: buildState(query, candidates),
    model,
    questions: buildQuestions(candidates),
  };

  const res = await fetch(endpoint, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });

  if (res.status === 429 || res.status === 529) {
    throw new Error(`TypeSafe rate/overload ${res.status}`);
  }
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`TypeSafe HTTP ${res.status}: ${text.slice(0, 200)}`);
  }

  const json = await res.json();
  return parseJevResponse(json, candidates);
}

/**
 * @param {any} json
 * @param {import('./types.js').Candidate[]} candidates
 * @returns {Omit<import('./types.js').JevDecision, 'latencyMs'|'usedMock'|'fallback'>}
 */
export function parseJevResponse(json, candidates) {
  const answers = json?.answers ?? {};
  const judgments = candidates.map((c) => {
    const scoreAns = answers[`rel_${c.id}`];
    const noulAns = answers[`ans_${c.id}`];
    return {
      candidateId: c.id,
      relevanceScore: typeof scoreAns?.score === 'number' ? scoreAns.score : 0,
      answerableNoul: typeof noulAns?.noul === 'number' ? noulAns.noul : 0,
      confidence:
        typeof scoreAns?.confidence === 'number' ? scoreAns.confidence : undefined,
    };
  });

  const routeAns = answers.route;
  /** @type {import('./types.js').Route} */
  let routeChoice = 'llm';
  if (routeAns?.choice && ROUTES.includes(routeAns.choice)) {
    routeChoice = routeAns.choice;
  }

  return {
    judgments,
    routeChoice,
    routeConfidence: typeof routeAns?.confidence === 'number' ? routeAns.confidence : 0,
    overallAnswerableNoul:
      typeof answers.overall_answerable?.noul === 'number'
        ? answers.overall_answerable.noul
        : 0,
    inputTokens: Number(json?.usage?.input_tokens ?? 0),
    model: String(json?.model ?? PINNED_JEV_MODEL),
  };
}

/** @param {number} x */
function clamp01(x) {
  return Math.min(1, Math.max(0, x));
}

/** @param {string} s */
function hash32(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/** @param {string} query @param {import('./types.js').Candidate[]} candidates */
function estimateTokens(query, candidates) {
  const chars =
    query.length + candidates.reduce((n, c) => n + c.text.length + c.id.length, 0) + 400;
  return Math.ceil(chars / 4);
}
