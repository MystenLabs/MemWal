#!/usr/bin/env bun
/**
 * bench-remember-sizes.ts — ENG-1407 size-boundary harness
 *
 * Sweeps /api/remember across payload sizes to validate the summarize-before
 * -embed path end-to-end. Each successful remember is followed by a recall
 * on a unique marker so we can verify the original full text round-trips
 * (not the summary).
 *
 * Sizes tested (boundary-bracketing, prose-like content):
 *   4 KiB, 9 KiB, 64 KiB, 256 KiB, 384 KiB, 480 KiB, 512 KiB, 768 KiB,
 *   1 MiB, 1 MiB + 1 (over MAX_REMEMBER_TEXT_BYTES, must reject)
 *
 * Each case asserts an expected HTTP status. Any deviation surfaces a
 * regression or an unintended behavior change in the relayer chain
 * (auth body cap, route layer, summarize path, sidecar, SEAL, Walrus).
 *
 * Usage:
 *   BENCH_DELEGATE_KEY=<hex> BENCH_ACCOUNT_ID=0x... bun run bench-remember-sizes.ts
 */

import { createHash, randomUUID } from "node:crypto";
import { decodeSuiPrivateKey } from "@mysten/sui/cryptography";
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";

const SERVER_URL = process.env.SERVER_URL ?? "http://localhost:8000";
const DELEGATE_KEY = process.env.BENCH_DELEGATE_KEY;
const ACCOUNT_ID = process.env.BENCH_ACCOUNT_ID;

if (!DELEGATE_KEY || !ACCOUNT_ID) {
  console.error("Set BENCH_DELEGATE_KEY (hex or suiprivkey) and BENCH_ACCOUNT_ID (0x…)");
  process.exit(1);
}

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

function makeText(bytes: number, marker: string): string {
  // Marker at start so we can verify the original is recalled (not summary)
  const prefix = `MARKER=${marker} | `;
  const filler = "The quick brown fox jumps over the lazy dog. ".repeat(Math.ceil(bytes / 45));
  return (prefix + filler).slice(0, bytes);
}

interface Case {
  name: string;
  bytes: number;
  expectStatus: number;
  expectSummarize: boolean;
}

const cases: Case[] = [
  { name: "4 KiB (no summarize)",        bytes: 4 * 1024,        expectStatus: 200, expectSummarize: false },
  { name: "9 KiB (summarize ON)",        bytes: 9 * 1024,        expectStatus: 200, expectSummarize: true  },
  { name: "64 KiB (summarize)",          bytes: 64 * 1024,       expectStatus: 200, expectSummarize: true  },
  { name: "256 KiB (summarize)",         bytes: 256 * 1024,      expectStatus: 200, expectSummarize: true  },
  { name: "384 KiB (summarize)",         bytes: 384 * 1024,      expectStatus: 200, expectSummarize: true  },
  { name: "480 KiB (summarize)",         bytes: 480 * 1024,      expectStatus: 200, expectSummarize: true  },
  { name: "512 KiB (boundary on 1a290fb)", bytes: 512 * 1024,    expectStatus: 200, expectSummarize: true  },
  { name: "768 KiB (above old boundary)", bytes: 768 * 1024,     expectStatus: 200, expectSummarize: true  },
  { name: "1 MiB (max)",                 bytes: 1024 * 1024,     expectStatus: 200, expectSummarize: true  },
  { name: "1 MiB + 1 (over limit)",      bytes: 1024 * 1024 + 1, expectStatus: 400, expectSummarize: false },
];

interface Result {
  name: string;
  bytes: number;
  status: number;
  ms: number;
  memoryId?: string;
  recalledOk?: boolean;
  recalledMatches?: boolean;
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

  for (const c of cases) {
    const marker = randomUUID().slice(0, 8);
    const text = makeText(c.bytes, marker);
    const r: Result = { name: c.name, bytes: c.bytes, status: 0, ms: 0 };

    process.stdout.write(`▶ ${c.name.padEnd(32)} ... `);
    try {
      const remResp = await signedRequest("/api/remember", {
        text,
        namespace: NAMESPACE,
      });
      r.status = remResp.status;
      r.ms = remResp.ms;

      if (remResp.status !== c.expectStatus) {
        r.err = `expected ${c.expectStatus}, got ${remResp.status}: ${JSON.stringify(remResp.json).slice(0, 200)}`;
        console.log(`❌ ${remResp.status} (${r.ms.toFixed(0)} ms)`);
        results.push(r);
        continue;
      }

      if (remResp.status === 200) {
        r.memoryId = remResp.json?.id;
        // Recall by marker so we know we're getting THIS specific record
        const recResp = await signedRequest("/api/recall", {
          query: `MARKER=${marker}`,
          limit: 1,
          namespace: NAMESPACE,
        });
        r.recallMs = recResp.ms;
        if (recResp.status !== 200) {
          r.err = `recall failed: ${recResp.status} ${JSON.stringify(recResp.json).slice(0, 200)}`;
          console.log(`✅ remember (${r.ms.toFixed(0)} ms) | ❌ recall ${recResp.status}`);
          results.push(r);
          continue;
        }
        const top = recResp.json?.results?.[0];
        r.recalledOk = !!top;
        // Match: original full text contains the marker AND length matches input
        r.recalledMatches = top && top.text === text;
        const matchSym = r.recalledMatches ? "✅" : (top?.text?.includes(`MARKER=${marker}`) ? "⚠️ partial" : "❌");
        console.log(
          `✅ remember (${r.ms.toFixed(0)} ms) | recall ${matchSym} (${r.recallMs.toFixed(0)} ms, len=${top?.text?.length ?? "?"}/${text.length})`,
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
    // Pause between requests so rate-limiter doesn't trip
    await new Promise((r) => setTimeout(r, 500));
  }

  console.log("");
  console.log("─".repeat(80));
  console.log("Summary:");
  console.table(results.map((r) => ({
    case: r.name,
    bytes: r.bytes,
    status: r.status,
    "remember ms": r.ms.toFixed(0),
    "recall ms": r.recallMs?.toFixed(0) ?? "—",
    "recall matches original": r.recalledMatches ?? "—",
    error: r.err ?? "",
  })));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
