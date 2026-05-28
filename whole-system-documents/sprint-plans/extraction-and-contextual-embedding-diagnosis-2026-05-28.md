# WALM-56/WALM-57 Diagnosis Notes

Date: 2026-05-28

## Status

Implementation hooks are present and opt-in, but the benchmark failure-case diagnosis still needs to be run against the archived 2026-05-21 extract.v5 artifacts before either mechanism should be considered validated.

## WALM-56 - Two-Pass Extraction

Question to answer before merge:

- Of failing LOCOMO `multi_hop` cases, how many are under-extraction where the answer never reached stored facts?
- How many are retrieval misses where the fact exists but is not retrieved?
- How many are answer-model composition failures where relevant facts are retrieved but not combined?

Implementation now available for testing:

- Request flag: `extract_with_critique=true`
- Benchmark config: `benchmarks.extract_with_critique: true`
- Prompt asset: `services/server/src/services/prompts/critique.txt`

Expected success signal:

- Under-extraction bucket drops on re-diagnosis.
- LOCOMO `multi_hop` moves beyond judge noise.
- LOCOMO `single_hop` does not regress beyond judge noise.

## WALM-57 - Contextual Embeddings

Question to answer before merge:

- Of failing `multi_hop` cases, how many have the right facts in storage but outside top-10?
- How many have the right facts in top-10 but poorly ranked?
- How many are reasoning failures after correct retrieval?

Implementation now available for testing:

- Request flag: `contextual_embedding=true`
- Benchmark config: `benchmarks.contextual_embedding: true`
- Current variant: no extra LLM call; embed input is situated with `occurred_at` and nearest related memories while stored plaintext remains the extracted fact.

Expected success signal:

- Retrieval misses attributable to under-situated vectors drop.
- LOCOMO `multi_hop` and LongMemEval multi-session/assistant-side categories move beyond judge noise.
- No meaningful `single_hop` regression.

## Missing Input

The raw baseline artifacts referenced by WALM-54 were not present in this checkout. Re-run or restore:

- `whole-system-documents/benchmark-archive/2026-05-21-mem59-extract-v5/`

Without that archive, diagnosis can still be performed on fresh runs, but attribution to the phase-1 baseline is weaker.
