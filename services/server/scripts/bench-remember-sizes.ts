#!/usr/bin/env bun
/**
 * bench-remember-sizes.ts — ENG-1407 size + content-type harness
 *
 * Hits /api/remember with each fixture from bench-fixtures.json and asserts
 * the HTTP status matches the fixture's expect_status. Each successful
 * remember is followed by one /api/recall to confirm the read path doesn't
 * crash — recall quality is intentionally NOT measured here (real-benchmark
 * coverage like Locomo / longmemeval lands separately).
 *
 * The fixture file pairs realistic public-domain content (Wikipedia,
 * Project Gutenberg) with synthetic structured + mixed payloads, sized to
 * stress different points along the size × tokenization-density curve.
 *
 * Usage:
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
  expect_status: 200 | 400;
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

async function signedRequest(path: string, body: object): Promise<{ status: number; ms: number; json: any }> {
  const bodyStr = JSON.stringify(body);
  const bodyHash = createHash("sha256").update(bodyStr).digest("hex");
  const ts = Math.floor(Date.now() / 1000).toString();
  const nonce = randomUUID();
  const message = `${ts}.POST.${path}.${bodyHash}.${nonce}.${ACCOUNT_ID}`;
  const signature = await keypair.sign(TEXT_ENCODER.encode(message));

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "x-public-key": PUBLIC_KEY_HEX,
    "x-signature": Buffer.from(signature).toString("hex"),
    "x-timestamp": ts,
    "x-nonce": nonce,
    "x-account-id": ACCOUNT_ID,
    "x-delegate-key": DELEGATE_KEY!.startsWith("0x") ? DELEGATE_KEY!.slice(2) : DELEGATE_KEY!,
  };

  const t0 = performance.now();
  const resp = await fetch(`${SERVER_URL}${path}`, { method: "POST", headers, body: bodyStr });
  const ms = performance.now() - t0;
  const text = await resp.text();
  let json: any = null;
  try { json = JSON.parse(text); } catch { json = { raw: text }; }
  return { status: resp.status, ms, json };
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
  ms: number;
  memoryId?: string;
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
  console.log("");

  const results: Result[] = [];

  for (const f of fixtureFile.fixtures) {
    const r: Result = {
      name: f.name,
      category: f.category,
      bytes: f.size_bytes,
      expectStatus: f.expect_status,
      status: 0,
      ms: 0,
    };

    process.stdout.write(`▶ ${f.name.padEnd(28)} (${f.category.padEnd(15)}) ${f.size_bytes.toString().padStart(8)} B ... `);
    try {
      const remResp = await signedRequest("/api/remember", {
        text: f.text,
        namespace: NAMESPACE,
      });
      r.status = remResp.status;
      r.ms = remResp.ms;

      if (remResp.status !== f.expect_status) {
        r.err = `expected ${f.expect_status}, got ${remResp.status}: ${JSON.stringify(remResp.json).slice(0, 200)}`;
        console.log(`❌ ${remResp.status} (${r.ms.toFixed(0)} ms)`);
      } else if (remResp.status === 200) {
        r.memoryId = remResp.json?.id;
        // Recall to confirm the read path works. We do NOT assert on
        // recall quality (rank, distance, content) — that's deferred to
        // dedicated benchmarks (Locomo, longmemeval).
        const recResp = await signedRequest("/api/recall", {
          query: f.name, // any query suffices for a sanity hit; namespace scopes results
          limit: 1,
          namespace: NAMESPACE,
        });
        r.recallStatus = recResp.status;
        r.recallMs = recResp.ms;
        const recallSym = recResp.status === 200 ? "✅" : "❌";
        console.log(
          `✅ remember (${r.ms.toFixed(0)} ms) | recall ${recallSym} ${recResp.status} (${recResp.ms.toFixed(0)} ms)`,
        );
      } else {
        // Expected non-200 (e.g. 400 for over-limit)
        console.log(`✅ ${remResp.status} as expected (${r.ms.toFixed(0)} ms)`);
      }
    } catch (e: any) {
      r.err = e?.message ?? String(e);
      console.log(`💥 ${r.err}`);
    }
    results.push(r);
    // Pause so rate-limiter doesn't trip
    await new Promise((rs) => setTimeout(rs, 500));
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
    "remember ms": r.ms.toFixed(0),
    "recall": r.recallStatus ? `${r.recallStatus} (${r.recallMs?.toFixed(0)} ms)` : "—",
    error: r.err ?? "",
  })));

  // Aggregate pass/fail signal
  const failed = results.filter((r) => r.status !== r.expectStatus);
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
