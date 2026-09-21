import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { computeMetrics, percentile, formatTable } from '../src/metrics.js';

describe('percentile', () => {
  it('returns p50/p95 on a tiny sorted list', () => {
    const xs = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    assert.equal(percentile(xs, 0.5), 5);
    assert.equal(percentile(xs, 0.95), 10);
  });
});

describe('computeMetrics', () => {
  it('computes hit and route accuracy', () => {
    const cases = [
      {
        id: 'c1',
        lang: /** @type {const} */ ('EN'),
        category: 'exact_dupe',
        query: 'q',
        candidates: [
          { id: 'm1', text: 'a', distance: 0.1, gold_relevant: true },
          { id: 'm2', text: 'b', distance: 0.5, gold_relevant: false },
        ],
        gold_answerable: true,
        gold_route: /** @type {const} */ ('answer_from_memory'),
        gold_top1_id: 'm1',
      },
    ];
    const results = [
      {
        caseId: 'c1',
        mode: 'without_jev',
        rankedIds: ['m1', 'm2'],
        top1Id: 'm1',
        predictedAnswerable: true,
        predictedRoute: /** @type {const} */ ('answer_from_memory'),
        latencyMs: 1,
        estCostUsd: 0,
        fallback: false,
        usedMock: false,
      },
    ];
    const m = computeMetrics(cases, results);
    assert.equal(m.hit_at_1, 1);
    assert.equal(m.route_accuracy, 1);
    assert.equal(m.false_context_rate, 0);
  });
});

describe('formatTable', () => {
  it('includes required metric rows', () => {
    const table = formatTable(
      {
        without_jev: {
          n: 1,
          hit_at_1: 1,
          hit_at_3: 1,
          false_context_rate: 0,
          answerability_accuracy: 1,
          route_accuracy: 1,
          p50_latency_ms: 1,
          p95_latency_ms: 2,
          est_cost_usd: 0,
          fallback_rate: 0,
        },
      },
      'test',
    );
    assert.match(table, /hit@1/);
    assert.match(table, /false_context_rate/);
    assert.match(table, /est_cost_usd/);
  });
});
