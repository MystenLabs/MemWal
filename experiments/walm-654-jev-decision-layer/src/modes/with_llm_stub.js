import { policyWithLlmStub } from '../policy.js';

/**
 * @param {import('../types.js').Case} c
 * @param {{ distanceThreshold: number }} opts
 * @returns {import('../types.js').ModeResult}
 */
export function runWithLlmStub(c, opts) {
  const started = performance.now();
  const decision = policyWithLlmStub(c.query, c.candidates, {
    distanceThreshold: opts.distanceThreshold,
  });
  return {
    caseId: c.id,
    mode: 'with_llm_stub',
    ...decision,
    latencyMs: Math.max(0.1, performance.now() - started),
    estCostUsd: 0,
    fallback: false,
    usedMock: false,
  };
}
