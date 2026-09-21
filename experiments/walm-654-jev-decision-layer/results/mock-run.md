# WALM-654 benchmark run

- Generated (UTC): 2026-09-21T14:55:14.186Z
- Mock mode: true
- Model: jev-1.13.0
- Cases: 14

## ALL languages

| metric                 | without_jev | with_jev | with_llm_stub |
| ---------------------- | ----------- | -------- | ------------- |
| n                      | 14          | 14       | 14            |
| hit@1                  | 63.6%       | 100.0%   | 81.8%         |
| hit@3                  | 100.0%      | 100.0%   | 100.0%        |
| false_context_rate     | 42.9%       | 0.0%     | 28.6%         |
| answerability_accuracy | 71.4%       | 100.0%   | 71.4%         |
| route_accuracy         | 71.4%       | 92.9%    | 71.4%         |
| p50_latency_ms         | 0.10        | 0.10     | 0.10          |
| p95_latency_ms         | 0.10        | 0.64     | 1.28          |
| est_cost_usd           | 0.000000    | 0.000093 | 0.000000      |
| fallback_rate          | 0.0%        | 0.0%     | 0.0%          |

## EN only

| metric                 | without_jev | with_jev | with_llm_stub |
| ---------------------- | ----------- | -------- | ------------- |
| n                      | 8           | 8        | 8             |
| hit@1                  | 66.7%       | 100.0%   | 83.3%         |
| hit@3                  | 100.0%      | 100.0%   | 100.0%        |
| false_context_rate     | 50.0%       | 0.0%     | 37.5%         |
| answerability_accuracy | 62.5%       | 100.0%   | 62.5%         |
| route_accuracy         | 62.5%       | 87.5%    | 62.5%         |
| p50_latency_ms         | 0.10        | 0.10     | 0.10          |
| p95_latency_ms         | 0.10        | 0.64     | 1.28          |
| est_cost_usd           | 0.000000    | 0.000052 | 0.000000      |
| fallback_rate          | 0.0%        | 0.0%     | 0.0%          |

## VI only

| metric                 | without_jev | with_jev | with_llm_stub |
| ---------------------- | ----------- | -------- | ------------- |
| n                      | 6           | 6        | 6             |
| hit@1                  | 60.0%       | 100.0%   | 80.0%         |
| hit@3                  | 100.0%      | 100.0%   | 100.0%        |
| false_context_rate     | 33.3%       | 0.0%     | 16.7%         |
| answerability_accuracy | 83.3%       | 100.0%   | 83.3%         |
| route_accuracy         | 83.3%       | 100.0%   | 83.3%         |
| p50_latency_ms         | 0.10        | 0.10     | 0.10          |
| p95_latency_ms         | 0.10        | 0.12     | 0.59          |
| est_cost_usd           | 0.000000    | 0.000040 | 0.000000      |
| fallback_rate          | 0.0%        | 0.0%     | 0.0%          |

Mock mode: yes (TYPESAFE_API_KEY unset)
Model: jev-1.13.0
Cases: 14
Dataset: /workspace/MemWal/experiments/walm-654-jev-decision-layer/data/synthetic-dataset.json
Distance threshold: 0.35

## How to interpret

- **without_jev**: semantic distance only (current WM-style baseline).
- **with_jev**: WM candidates → Jev Score/Noul/Choice → deterministic policy.
- **with_llm_stub**: dumb keyword overlap heuristic (third baseline).
- Higher hit@k / answerability_accuracy / route_accuracy is better.
- Lower false_context_rate / fallback_rate / latency / cost is better.
