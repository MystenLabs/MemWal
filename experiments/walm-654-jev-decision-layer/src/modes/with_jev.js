import { policyWithJev } from '../policy.js';
import { JEV_INPUT_USD_PER_MTOKEN } from '../types.js';

/**
 * @param {import('../types.js').Case} c
 * @param {ReturnType<import('../jev-client.js').createJevClient>} client
 * @param {{ distanceThreshold: number }} opts
 * @returns {Promise<import('../types.js').ModeResult>}
 */
export async function runWithJev(c, client, opts) {
  const started = performance.now();
  const jev = await client.evaluate(c.query, c.candidates, c);
  const decision = policyWithJev(c.candidates, jev, {
    distanceThreshold: opts.distanceThreshold,
  });
  const estCostUsd = (jev.inputTokens / 1_000_000) * JEV_INPUT_USD_PER_MTOKEN;
  return {
    caseId: c.id,
    mode: 'with_jev',
    rankedIds: decision.rankedIds,
    top1Id: decision.top1Id,
    predictedAnswerable: decision.predictedAnswerable,
    predictedRoute: decision.predictedRoute,
    latencyMs: Math.max(0.1, performance.now() - started),
    estCostUsd,
    fallback: Boolean(decision.fallback || jev.fallback),
    usedMock: jev.usedMock,
  };
}
