import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createJevClient } from './jev-client.js';
import { runWithoutJev } from './modes/without_jev.js';
import { runWithJev } from './modes/with_jev.js';
import { runWithLlmStub } from './modes/with_llm_stub.js';
import { computeMetricsForLang, formatTable } from './metrics.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const DEFAULT_DATASET_PATH = path.join(
  __dirname,
  '..',
  'data',
  'synthetic-dataset.json',
);

/**
 * @param {{ datasetPath?: string, apiKey?: string|null }} [opts]
 */
export async function runBenchmark(opts = {}) {
  const datasetPath = opts.datasetPath ?? DEFAULT_DATASET_PATH;
  const raw = JSON.parse(await readFile(datasetPath, 'utf8'));
  /** @type {import('./types.js').Case[]} */
  const cases = raw.cases;
  const distanceThreshold = raw.distance_threshold ?? 0.35;

  const client = createJevClient({ apiKey: opts.apiKey });

  /** @type {import('./types.js').ModeResult[]} */
  const without = [];
  /** @type {import('./types.js').ModeResult[]} */
  const withJev = [];
  /** @type {import('./types.js').ModeResult[]} */
  const withStub = [];

  for (const c of cases) {
    without.push(runWithoutJev(c, { distanceThreshold }));
    withStub.push(runWithLlmStub(c, { distanceThreshold }));
    withJev.push(await runWithJev(c, client, { distanceThreshold }));
  }

  const modeResults = {
    without_jev: without,
    with_jev: withJev,
    with_llm_stub: withStub,
  };

  /** @type {Record<string, Record<string, ReturnType<typeof computeMetricsForLang>>>} */
  const tables = {
    ALL: {},
    EN: {},
    VI: {},
  };

  for (const [mode, results] of Object.entries(modeResults)) {
    tables.ALL[mode] = computeMetricsForLang(cases, results, null);
    tables.EN[mode] = computeMetricsForLang(cases, results, 'EN');
    tables.VI[mode] = computeMetricsForLang(cases, results, 'VI');
  }

  const report = [
    formatTable(tables.ALL, 'ALL languages'),
    '',
    formatTable(tables.EN, 'EN only'),
    '',
    formatTable(tables.VI, 'VI only'),
    '',
    `Mock mode: ${client.useMock ? 'yes (TYPESAFE_API_KEY unset)' : 'no (live API)'}`,
    `Model: ${client.model}`,
    `Cases: ${cases.length}`,
    `Dataset: ${datasetPath}`,
    `Distance threshold: ${distanceThreshold}`,
  ].join('\n');

  return {
    cases,
    modeResults,
    tables,
    report,
    useMock: client.useMock,
    model: client.model,
  };
}
