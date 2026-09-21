import { policyWithoutJev } from '../policy.js';

/**
 * @param {import('../types.js').Case} c
 * @param {{ distanceThreshold: number }} opts
 * @returns {import('../types.js').ModeResult}
 */
export function runWithoutJev(c, opts) {
  const started = performance.now();
  const decision = policyWithoutJev(c.candidates, {
    distanceThreshold: opts.distanceThreshold,
  });
  return {
    caseId: c.id,
    mode: 'without_jev',
    ...decision,
    latencyMs: Math.max(0.1, performance.now() - started),
    estCostUsd: 0,
    fallback: false,
    usedMock: false,
  };
}
