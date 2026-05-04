#!/usr/bin/env npx tsx
/**
 * bench-recall-latency.ts — ENG-1405
 *
 * End-to-end latency benchmark for POST /api/recall.
 * Measures warm (repeated queries) vs cold (first call) behaviour separately.
 *
 * Usage:
 *   npx tsx bench-recall-latency.ts \
 *     --server-url   http://localhost:8000 \
 *     --account-id   <0x...> \
 *     --delegate-key <suiprivkey1... or 64-hex> \
 *     --query        "what do I prefer?" \
 *     --namespace    default \
 *     --limit        5 \
 *     --cold-runs    3 \
 *     --warm-runs    10 \
 *     --output       bench-recall-results.json
 *
 * The script runs `--cold-runs` calls first (server has not cached any blobs),
 * then `--warm-runs` calls with the same query (server LRU cache should be hot).
 *
 * Output:
 *   • ANSI table with p50/p95/p99 per phase parsed from server logs (if available)
 *   • JSON file with raw per-request timings at --output
 */

import { createHash, randomUUID } from "crypto";
import { decodeSuiPrivateKey } from "@mysten/sui/cryptography";
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";

// ============================================================
// CLI
// ============================================================

const RECALL_METHOD = "POST";
const RECALL_PATH = "/api/recall";
const TEXT_ENCODER = new TextEncoder();

interface Auth {
  delegateKey: string;
  keypair: Ed25519Keypair;
  publicKeyHex: string;
}

interface Args {
  serverUrl: string;
  accountId: string;
  auth: Auth;
  bodyStr: string;
  bodyHash: string;
  query: string;
  namespace: string;
  limit: number;
  coldRuns: number;
  warmRuns: number;
  output: string;
  color: boolean;
}

function printHelp(): void {
  console.log(`
bench-recall-latency.ts — ENG-1405: recall latency benchmark

Usage:
  npx tsx bench-recall-latency.ts [options]

Required auth options:
  --account-id   <0x...>        x-account-id header value
  --delegate-key <key>          suiprivkey1... or 64-hex delegate private key

Optional:
  --server-url   <url>          Server URL          [default: http://localhost:8000]
  --query        <text>         Recall query text   [default: "test query"]
  --namespace    <ns>           Namespace           [default: default]
  --limit        <n>            Top-K results       [default: 5]
  --cold-runs    <n>            Cold-path runs      [default: 3]
  --warm-runs    <n>            Warm-path runs      [default: 10]
  --output       <file>         JSON output path    [default: bench-recall-results.json]
  --no-color                    Disable ANSI colors
  --help                        Show this help
`);
}

function parseArgs(): Args {
  const argv = process.argv.slice(2);
  if (argv.includes("--help") || argv.includes("-h")) {
    printHelp();
    process.exit(0);
  }

  const get = (flag: string, def?: string): string | undefined => {
    const idx = argv.indexOf(flag);
    if (idx !== -1 && idx + 1 < argv.length) return argv[idx + 1];
    return def;
  };

  const required = (flag: string, env?: string): string => {
    const v = get(flag) ?? (env ? process.env[env] : undefined);
    if (!v) {
      console.error(`error: ${flag} is required`);
      process.exit(1);
    }
    return v;
  };

  const delegateKey = normalizeDelegateKey(required("--delegate-key", "BENCH_DELEGATE_KEY"));
  const query = get("--query", "test query")!;
  const namespace = get("--namespace", "default")!;
  const limit = parseInt(get("--limit", "5")!, 10);
  const bodyStr = JSON.stringify({ query, namespace, limit });

  return {
    serverUrl: get("--server-url", "http://localhost:8000")!,
    accountId: required("--account-id", "BENCH_ACCOUNT_ID"),
    auth: buildAuth(delegateKey),
    bodyStr,
    bodyHash: sha256Hex(bodyStr),
    query,
    namespace,
    limit,
    coldRuns: parseInt(get("--cold-runs", "3")!, 10),
    warmRuns: parseInt(get("--warm-runs", "10")!, 10),
    output: get("--output", "bench-recall-results.json")!,
    color: !argv.includes("--no-color"),
  };
}

// ============================================================
// Helpers
// ============================================================

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, Math.min(idx, sorted.length - 1))];
}

function ms(n: number): string {
  return `${n.toFixed(0)} ms`;
}

const C = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  red: "\x1b[31m",
  cyan: "\x1b[36m",
  magenta: "\x1b[35m",
};

function color(enabled: boolean, code: string, s: string): string {
  return enabled ? `${code}${s}${C.reset}` : s;
}

function buildAuth(delegateKey: string): Auth {
  const keypair = keypairFromDelegateKey(delegateKey);
  return {
    delegateKey,
    keypair,
    publicKeyHex: Buffer.from(keypair.getPublicKey().toRawBytes()).toString("hex"),
  };
}

function keypairFromDelegateKey(delegateKey: string): Ed25519Keypair {
  if (delegateKey.startsWith("suiprivkey")) {
    const { scheme, secretKey } = decodeSuiPrivateKey(delegateKey);
    if (scheme !== "ED25519") {
      throw new Error(`delegate key must be Ed25519, got ${scheme}`);
    }
    return Ed25519Keypair.fromSecretKey(secretKey);
  }

  const hex = delegateKey.startsWith("0x") ? delegateKey.slice(2) : delegateKey;
  if (!/^[0-9a-fA-F]{64}$/.test(hex)) {
    throw new Error("delegate key must be 64-char hex or suiprivkey bech32");
  }
  return Ed25519Keypair.fromSecretKey(Uint8Array.from(Buffer.from(hex, "hex")));
}

function normalizeDelegateKey(delegateKey: string): string {
  if (delegateKey.startsWith("0x") && delegateKey.length === 66) {
    return delegateKey.slice(2);
  }
  return delegateKey;
}

function sha256Hex(data: string): string {
  return createHash("sha256").update(data).digest("hex");
}

async function buildSignedRecallHeaders(args: Args): Promise<Record<string, string>> {
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const nonce = randomUUID();
  const message = `${timestamp}.${RECALL_METHOD}.${RECALL_PATH}.${args.bodyHash}.${nonce}.${args.accountId}`;
  const signature = await args.auth.keypair.sign(TEXT_ENCODER.encode(message));

  return {
    "Content-Type": "application/json",
    "x-public-key": args.auth.publicKeyHex,
    "x-signature": Buffer.from(signature).toString("hex"),
    "x-timestamp": timestamp,
    "x-nonce": nonce,
    "x-account-id": args.accountId,
    "x-delegate-key": args.auth.delegateKey,
  };
}

function stats(samples: number[]): {
  p50: number; p95: number; p99: number; min: number; max: number; mean: number;
} {
  if (samples.length === 0) return { p50: 0, p95: 0, p99: 0, min: 0, max: 0, mean: 0 };
  const sorted = [...samples].sort((a, b) => a - b);
  const mean = sorted.reduce((a, b) => a + b, 0) / sorted.length;
  return {
    p50: percentile(sorted, 50),
    p95: percentile(sorted, 95),
    p99: percentile(sorted, 99),
    min: sorted[0],
    max: sorted[sorted.length - 1],
    mean,
  };
}

// ============================================================
// Single recall call
// ============================================================

interface RecallRunResult {
  ok: boolean;
  latencyMs: number;
  resultCount?: number;
  droppedCount?: number;
  statusCode?: number;
  error?: string;
}

async function recallOnce(args: Args): Promise<RecallRunResult> {
  const start = performance.now();
  try {
    const headers = await buildSignedRecallHeaders(args);

    const resp = await fetch(`${args.serverUrl}${RECALL_PATH}`, {
      method: RECALL_METHOD,
      headers,
      body: args.bodyStr,
    });

    const latencyMs = performance.now() - start;

    if (!resp.ok) {
      const body = await resp.text().catch(() => "");
      return { ok: false, latencyMs, statusCode: resp.status, error: body.slice(0, 300) };
    }

    const json = (await resp.json()) as { results?: unknown[]; total?: number; dropped_count?: number };
    return {
      ok: true,
      latencyMs,
      statusCode: resp.status,
      resultCount: json.total ?? json.results?.length ?? 0,
      droppedCount: json.dropped_count ?? 0,
    };
  } catch (err: any) {
    const latencyMs = performance.now() - start;
    return { ok: false, latencyMs, error: err?.message ?? String(err) };
  }
}

// ============================================================
// Run a batch of recalls
// ============================================================

interface BatchResult {
  label: string;
  runs: number;
  successCount: number;
  failCount: number;
  rawMs: number[];
  errors: string[];
}

async function runBatch(args: Args, label: string, runs: number): Promise<BatchResult> {
  const rawMs: number[] = [];
  const errors: string[] = [];
  let successCount = 0;
  let failCount = 0;

  for (let i = 0; i < runs; i++) {
    process.stdout.write(`  [${label}] run ${i + 1}/${runs}... `);
    const result = await recallOnce(args);
    if (result.ok) {
      rawMs.push(result.latencyMs);
      successCount++;
      console.log(`ok ${ms(result.latencyMs)} (${result.resultCount} results)`);
    } else {
      failCount++;
      const errMsg = result.error ?? `HTTP ${result.statusCode}`;
      errors.push(errMsg);
      console.log(`FAILED: ${errMsg.slice(0, 120)}`);
    }

    // Small delay between runs to avoid saturating the server
    if (i < runs - 1) {
      await new Promise((r) => setTimeout(r, 100));
    }
  }

  return { label, runs, successCount, failCount, rawMs, errors };
}

// ============================================================
// Reporting
// ============================================================

function printBatchTable(batches: BatchResult[], col: boolean): void {
  const h = (s: string) => color(col, C.bold + C.cyan, s);
  const ok = (s: string) => color(col, C.green, s);

  const colW = [10, 8, 8, 8, 10, 8, 8];
  const cols = ["phase", "p50", "p95", "p99", "mean", "min", "max"];

  function row(cells: string[]): string {
    return cells.map((c, i) => c.padStart(colW[i])).join("  ");
  }

  console.log();
  console.log(h(row(cols)));
  console.log(color(col, C.dim, row(cols.map((_, i) => "─".repeat(colW[i])))));

  for (const b of batches) {
    const s = stats(b.rawMs);
    const cells = [
      b.label,
      ms(s.p50),
      ms(s.p95),
      ms(s.p99),
      ms(s.mean),
      ms(s.min),
      ms(s.max),
    ];
    console.log(ok(row(cells)));
  }
  console.log();
}

function buildMarkdown(batches: BatchResult[]): string {
  const lines = [
    "## /api/recall Latency Benchmark — ENG-1405",
    "",
    "| phase | runs | p50 | p95 | p99 | mean | min | max | fail% |",
    "|-------|------|-----|-----|-----|------|-----|-----|-------|",
  ];
  for (const b of batches) {
    const s = stats(b.rawMs);
    const failPct = ((b.failCount / b.runs) * 100).toFixed(1);
    lines.push(
      `| ${b.label} | ${b.runs} | ${ms(s.p50)} | ${ms(s.p95)} | ${ms(s.p99)} | ${ms(s.mean)} | ${ms(s.min)} | ${ms(s.max)} | ${failPct}% |`
    );
  }
  return lines.join("\n");
}

// ============================================================
// Main
// ============================================================

async function main(): Promise<void> {
  const args = parseArgs();
  const col = args.color && process.stdout.isTTY;

  console.log(color(col, C.bold, "\n⚡ bench-recall-latency — ENG-1405\n"));
  console.log(`  server:      ${args.serverUrl}`);
  console.log(`  namespace:   ${args.namespace}`);
  console.log(`  limit:       ${args.limit}`);
  console.log(`  query:       "${args.query.slice(0, 60)}"`);
  console.log(`  cold runs:   ${args.coldRuns}`);
  console.log(`  warm runs:   ${args.warmRuns}`);
  console.log();

  // ── Sanity check: health ────────────────────────────────────────
  process.stdout.write(color(col, C.dim, "  health check... "));
  const healthResp = await fetch(`${args.serverUrl}/health`).catch((e) => { throw new Error(`health check failed: ${e.message}`); });
  if (!healthResp.ok) throw new Error(`health check failed: HTTP ${healthResp.status}`);
  console.log(color(col, C.green, "ok\n"));

  const batches: BatchResult[] = [];

  // ── Cold runs ───────────────────────────────────────────────────
  console.log(color(col, C.magenta, `  ── Cold path (${args.coldRuns} runs) ──`));
  const coldBatch = await runBatch(args, "cold", args.coldRuns);
  batches.push(coldBatch);

  // ── Warm runs ───────────────────────────────────────────────────
  console.log(color(col, C.magenta, `\n  ── Warm path (${args.warmRuns} runs) ──`));
  const warmBatch = await runBatch(args, "warm", args.warmRuns);
  batches.push(warmBatch);

  // ── Results table ────────────────────────────────────────────────
  printBatchTable(batches, col);

  const md = buildMarkdown(batches);
  console.log(md);
  console.log();

  // ── Verdict ─────────────────────────────────────────────────────
  const warmStats = stats(warmBatch.rawMs);
  const TARGET_P50_MS = 500;
  const totalFailures = batches.reduce((sum, b) => sum + b.failCount, 0);
  if (totalFailures > 0) {
    console.log(color(col, C.red, `✘ Benchmark had ${totalFailures} failed request(s)`));
  }
  if (warmStats.p50 < TARGET_P50_MS) {
    console.log(
      color(col, C.green, `✔ Warm p50 = ${ms(warmStats.p50)} — below ${TARGET_P50_MS}ms target ✓`)
    );
  } else {
    console.log(
      color(col, C.red, `✘ Warm p50 = ${ms(warmStats.p50)} — still above ${TARGET_P50_MS}ms target`)
    );
    console.log("  → Check server logs for per-phase breakdown (embed / vector_search / walrus_fetch / seal_batch_decrypt)");
  }
  console.log();

  // ── JSON output ──────────────────────────────────────────────────
  const jsonOut = {
    timestamp: new Date().toISOString(),
    config: {
      serverUrl: args.serverUrl,
      namespace: args.namespace,
      limit: args.limit,
      query: args.query,
      coldRuns: args.coldRuns,
      warmRuns: args.warmRuns,
    },
    target: { warmP50Ms: TARGET_P50_MS },
    batches: batches.map((b) => {
      const s = stats(b.rawMs);
      return {
        label: b.label,
        runs: b.runs,
        successCount: b.successCount,
        failCount: b.failCount,
        failureRate: +(b.failCount / b.runs).toFixed(4),
        p50Ms: +s.p50.toFixed(1),
        p95Ms: +s.p95.toFixed(1),
        p99Ms: +s.p99.toFixed(1),
        meanMs: +s.mean.toFixed(1),
        minMs: +s.min.toFixed(1),
        maxMs: +s.max.toFixed(1),
        rawMs: b.rawMs.map((n) => +n.toFixed(1)),
        errors: b.errors,
      };
    }),
    markdownTable: md,
  };

  const { writeFileSync } = await import("fs");
  writeFileSync(args.output, JSON.stringify(jsonOut, null, 2));
  console.log(color(col, C.dim, `  Results written to ${args.output}\n`));

  if (totalFailures > 0) {
    process.exit(1);
  }
}

main().catch((err: unknown) => {
  const msg = err instanceof Error ? err.message : String(err);
  console.error(`\nFatal error: ${msg}`);
  process.exit(1);
});
