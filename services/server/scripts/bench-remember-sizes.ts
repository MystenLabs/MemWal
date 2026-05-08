#!/usr/bin/env bun
/**
 * bench-remember-sizes.ts — ENG-1407 size + content-type harness
 *
 * /api/remember is asynchronous as of ENG-1406 v3 (PR #121): POST returns
 * HTTP 202 with a job_id, and the embed/encrypt/Walrus pipeline runs in a
 * background worker. This harness drives each fixture from
 * bench-fixtures.json through the full async lifecycle:
 *
 *   1. POST /api/remember            → expect 202 (or 400 for boundary case)
 *   2. GET  /api/remember/:job_id    → poll until done | failed
 *   3. POST /api/recall              → sanity hit on the read path
 *
 * Three timings are tracked per fixture: enqueueMs (request → 202),
 * workerMs (202 → done, the actual ENG-1407 work), and recallMs. The
 * worker timing is the meaningful one for evaluating chunked
 * summarization at scale.
 *
 * Recall quality is intentionally NOT measured here — that's deferred
 * to dedicated benchmarks (Locomo, longmemeval).
 *
 * Usage:
 *   # Server: must be started with the rate limiter bypass on, otherwise
 *   # one fixture's POST + polls + recall exceeds the per-key budget and
 *   # subsequent fixtures 429 immediately.
 *   RATE_LIMIT_DISABLED=1 cargo run --release
 *
 *   # Bench:
 *   BENCH_DELEGATE_KEY=<hex> BENCH_ACCOUNT_ID=0x... \
 *     bun run bench-remember-sizes.ts [--fixtures path/to/fixtures.json]
 */

import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { decodeSuiPrivateKey } from "@mysten/sui/cryptography";
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";

const HERE = dirname(fileURLToPath(import.meta.url));
const DEFAULT_FIXTURES = resolve(HERE, "bench-fixtures.json");

const SERVER_URL = process.env.SERVER_URL ?? "http://localhost:8000";
const DELEGATE_KEY = process.env.BENCH_DELEGATE_KEY;
const ACCOUNT_ID = process.env.BENCH_ACCOUNT_ID;

if (!DELEGATE_KEY || !ACCOUNT_ID) {
  console.error("Set BENCH_DELEGATE_KEY (hex or suiprivkey) and BENCH_ACCOUNT_ID (0x…)");
  process.exit(1);
}

// Parse --fixtures flag
const argv = process.argv.slice(2);
let fixturesPath = DEFAULT_FIXTURES;
for (let i = 0; i < argv.length; i += 1) {
  if (argv[i] === "--fixtures" && argv[i + 1]) {
    fixturesPath = resolve(argv[i + 1]);
    i += 1;
  }
}

interface Fixture {
  name: string;
  category: string;
  size_bytes: number;
  source_ids: string[];
  expect_status: 202 | 400;
  text: string;
}

interface FixtureFile {
  schema_version: number;
  generated_at: string;
  generator: string;
  sources: Array<{ id: string; url: string; license: string; description: string }>;
  fixtures: Fixture[];
}

const fixtureFile: FixtureFile = JSON.parse(readFileSync(fixturesPath, "utf-8"));
console.log(`Loaded ${fixtureFile.fixtures.length} fixtures from ${fixturesPath}`);
console.log(`  generated_at: ${fixtureFile.generated_at}`);
console.log("");

// ============================================================
// Auth helpers
// ============================================================

const TEXT_ENCODER = new TextEncoder();

function keypairFrom(key: string): Ed25519Keypair {
  if (key.startsWith("suiprivkey")) {
    const { scheme, secretKey } = decodeSuiPrivateKey(key);
    if (scheme !== "ED25519") throw new Error(`expected Ed25519, got ${scheme}`);
    return Ed25519Keypair.fromSecretKey(secretKey);
  }
  const hex = key.startsWith("0x") ? key.slice(2) : key;
  if (!/^[0-9a-fA-F]{64}$/.test(hex)) throw new Error("delegate key must be 64-hex or suiprivkey");
  return Ed25519Keypair.fromSecretKey(Uint8Array.from(Buffer.from(hex, "hex")));
}

const keypair = keypairFrom(DELEGATE_KEY);
const PUBLIC_KEY_HEX = Buffer.from(keypair.getPublicKey().toRawBytes()).toString("hex");
const NAMESPACE = `bench-pr122-${Date.now()}`;

async function signedFetch(
  method: "POST" | "GET",
  path: string,
  body?: object,
): Promise<{ status: number; ms: number; json: any }> {
  const bodyStr = method === "POST" && body !== undefined ? JSON.stringify(body) : "";
  const bodyHash = createHash("sha256").update(bodyStr).digest("hex");
  const ts = Math.floor(Date.now() / 1000).toString();
  const nonce = randomUUID();
  const message = `${ts}.${method}.${path}.${bodyHash}.${nonce}.${ACCOUNT_ID}`;
  const signature = await keypair.sign(TEXT_ENCODER.encode(message));

  const headers: Record<string, string> = {
    "x-public-key": PUBLIC_KEY_HEX,
    "x-signature": Buffer.from(signature).toString("hex"),
    "x-timestamp": ts,
    "x-nonce": nonce,
    "x-account-id": ACCOUNT_ID!,
    "x-delegate-key": DELEGATE_KEY!.startsWith("0x") ? DELEGATE_KEY!.slice(2) : DELEGATE_KEY!,
  };
  const init: RequestInit = { method, headers };
  if (method === "POST") {
    headers["Content-Type"] = "application/json";
    init.body = bodyStr;
  }

  const t0 = performance.now();
  const resp = await fetch(`${SERVER_URL}${path}`, init);
  const ms = performance.now() - t0;
  const text = await resp.text();
  let json: any = null;
  try { json = JSON.parse(text); } catch { json = { raw: text }; }
  return { status: resp.status, ms, json };
}

const signedRequest = (path: string, body: object) => signedFetch("POST", path, body);
const signedGet = (path: string) => signedFetch("GET", path);

// 500ms gives sub-second resolution on quick fixtures. The bench refuses
// to start unless the server has rate limiting disabled, so cadence isn't
// constrained by per-key budget.
const POLL_INTERVAL_MS = 500;
const POLL_TIMEOUT_MS = 120_000;

async function pollJobUntilTerminal(jobId: string): Promise<{
  status: "done" | "failed" | "timeout";
  workerMs: number;
  blobId?: string;
  error?: string;
}> {
  const start = performance.now();
  while (performance.now() - start < POLL_TIMEOUT_MS) {
    const r = await signedGet(`/api/remember/${jobId}`);
    if (r.status !== 200) {
      return {
        status: "failed",
        workerMs: performance.now() - start,
        error: `poll got HTTP ${r.status}: ${JSON.stringify(r.json).slice(0, 200)}`,
      };
    }
    const s = r.json?.status;
    if (s === "done") {
      return { status: "done", workerMs: performance.now() - start, blobId: r.json?.blob_id };
    }
    if (s === "failed") {
      return {
        status: "failed",
        workerMs: performance.now() - start,
        error: r.json?.error ?? "(no error message)",
      };
    }
    await new Promise((rs) => setTimeout(rs, POLL_INTERVAL_MS));
  }
  return { status: "timeout", workerMs: POLL_TIMEOUT_MS };
}

// ============================================================
// Run
// ============================================================

interface Result {
  name: string;
  category: string;
  bytes: number;
  expectStatus: number;
  status: number;
  enqueueMs: number;
  jobId?: string;
  jobFinalStatus?: "done" | "failed" | "timeout";
  workerMs?: number;
  blobId?: string;
  recallStatus?: number;
  recallMs?: number;
  err?: string;
}

async function main() {
  console.log(`Server : ${SERVER_URL}`);
  console.log(`Account: ${ACCOUNT_ID}`);
  console.log(`Pubkey : ${PUBLIC_KEY_HEX}`);
  console.log(`NS     : ${NAMESPACE}`);
  console.log("─".repeat(80));

  // Health check
  const health = await fetch(`${SERVER_URL}/health`).then((r) => r.json()).catch(() => null);
  console.log("health :", health);

  // Pre-flight: rate limiter must be off, otherwise this run will 429
  // partway through (one fixture's POST + ~25 polls + recall already
  // exceeds the per-delegate-key budget). /config exposes the flag so
  // we fail loudly here instead of midway through a 10-minute run.
  const cfg = await fetch(`${SERVER_URL}/config`).then((r) => r.json()).catch(() => null);
  if (!cfg?.rateLimitDisabled) {
    console.error(
      "\n❌ Rate limiter is ACTIVE on the server. This bench will 429 partway through.\n" +
      "   Restart the server with RATE_LIMIT_DISABLED=1 and retry.\n",
    );
    process.exit(1);
  }
  console.log("config :", cfg);
  console.log("");

  const results: Result[] = [];

  for (const f of fixtureFile.fixtures) {
    const r: Result = {
      name: f.name,
      category: f.category,
      bytes: f.size_bytes,
      expectStatus: f.expect_status,
      status: 0,
      enqueueMs: 0,
    };

    process.stdout.write(`▶ ${f.name.padEnd(28)} (${f.category.padEnd(15)}) ${f.size_bytes.toString().padStart(8)} B ... `);
    try {
      const remResp = await signedRequest("/api/remember", {
        text: f.text,
        namespace: NAMESPACE,
      });
      r.status = remResp.status;
      r.enqueueMs = remResp.ms;

      if (remResp.status !== f.expect_status) {
        r.err = `expected ${f.expect_status}, got ${remResp.status}: ${JSON.stringify(remResp.json).slice(0, 200)}`;
        console.log(`❌ ${remResp.status} (${r.enqueueMs.toFixed(0)} ms)`);
      } else if (remResp.status === 202) {
        // ENG-1406 v3: poll the job until the worker finishes the
        // embed/encrypt/Walrus pipeline. workerMs is the meaningful
        // ENG-1407 timing — enqueueMs is just request acceptance.
        r.jobId = remResp.json?.job_id;
        if (!r.jobId) {
          r.err = `202 with no job_id: ${JSON.stringify(remResp.json).slice(0, 200)}`;
          console.log(`❌ 202 missing job_id`);
        } else {
          process.stdout.write(`enq ${r.enqueueMs.toFixed(0)} ms ▸ poll … `);
          const poll = await pollJobUntilTerminal(r.jobId);
          r.jobFinalStatus = poll.status;
          r.workerMs = poll.workerMs;
          r.blobId = poll.blobId;
          if (poll.status !== "done") {
            r.err = poll.error ?? `worker ${poll.status} after ${poll.workerMs.toFixed(0)} ms`;
            console.log(`❌ ${poll.status} (${poll.workerMs.toFixed(0)} ms): ${(r.err ?? "").slice(0, 80)}`);
          } else {
            // Recall sanity hit. Quality is NOT asserted here —
            // that's deferred to Locomo / longmemeval.
            const recResp = await signedRequest("/api/recall", {
              query: f.name, // any query suffices; namespace scopes results
              limit: 1,
              namespace: NAMESPACE,
            });
            r.recallStatus = recResp.status;
            r.recallMs = recResp.ms;
            const recallSym = recResp.status === 200 ? "✅" : "❌";
            console.log(
              `✅ done (worker ${poll.workerMs.toFixed(0)} ms) | recall ${recallSym} ${recResp.status} (${recResp.ms.toFixed(0)} ms)`,
            );
          }
        }
      } else {
        // Expected non-202 (e.g. 400 for over-limit)
        console.log(`✅ ${remResp.status} as expected (${r.enqueueMs.toFixed(0)} ms)`);
      }
    } catch (e: any) {
      r.err = e?.message ?? String(e);
      console.log(`💥 ${r.err}`);
    }
    results.push(r);
  }

  console.log("");
  console.log("─".repeat(80));
  console.log("Summary:");
  console.table(results.map((r) => ({
    fixture: r.name,
    category: r.category,
    bytes: r.bytes,
    expect: r.expectStatus,
    got: r.status,
    "enqueue ms": r.enqueueMs.toFixed(0),
    "worker ms": r.workerMs !== undefined ? r.workerMs.toFixed(0) : "—",
    "job": r.jobFinalStatus ?? "—",
    "recall": r.recallStatus ? `${r.recallStatus} (${r.recallMs?.toFixed(0)} ms)` : "—",
    error: r.err ?? "",
  })));

  // Aggregate pass/fail signal: HTTP status must match, and for 202s the
  // worker must reach `done` (recall result is informational only).
  const failed = results.filter(
    (r) =>
      r.status !== r.expectStatus ||
      (r.status === 202 && r.jobFinalStatus !== "done"),
  );
  console.log("");
  console.log(`${results.length - failed.length}/${results.length} fixtures passed`);
  if (failed.length > 0) {
    console.log(`Failed: ${failed.map((r) => r.name).join(", ")}`);
    process.exit(1);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
