#!/usr/bin/env node
import { writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runBenchmark } from './benchmark.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, '..');

async function main() {
  const result = await runBenchmark();
  console.log(result.report);

  const resultsDir = path.join(root, 'results');
  await mkdir(resultsDir, { recursive: true });

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const mdName = result.useMock ? 'mock-run.md' : `live-run-${stamp}.md`;
  const mdPath = path.join(resultsDir, mdName);

  const md = [
    '# WALM-654 benchmark run',
    '',
    `- Generated (UTC): ${new Date().toISOString()}`,
    `- Mock mode: ${result.useMock}`,
    `- Model: ${result.model}`,
    `- Cases: ${result.cases.length}`,
    '',
    result.report,
    '',
    '## How to interpret',
    '',
    '- **without_jev**: semantic distance only (current WM-style baseline).',
    '- **with_jev**: WM candidates → Jev Score/Noul/Choice → deterministic policy.',
    '- **with_llm_stub**: dumb keyword overlap heuristic (third baseline).',
    '- Higher hit@k / answerability_accuracy / route_accuracy is better.',
    '- Lower false_context_rate / fallback_rate / latency / cost is better.',
    '',
  ].join('\n');

  await writeFile(mdPath, md, 'utf8');
  console.log(`\nWrote ${mdPath}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
