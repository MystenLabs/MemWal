#!/usr/bin/env tsx
/**
 * Build the UNSIGNED transaction bytes (base64) that mint one MigrationCap per
 * hot-wallet and distribute them, using @mysten/sui over gRPC (no JSON-RPC).
 * Every cap is bound to the 32-byte allowlist Merkle root (ALLOWLIST_ROOT) — the
 * root of the Admin-approved V1 snapshot; workers get proofs, never authority to
 * extend it. Output is signed later (multisig / ledger / offline) — nothing here
 * executes.
 *
 *   tsx scripts/build-migration-caps-tx.ts
 *   tsx scripts/build-migration-caps-tx.ts --self-test   # pure-logic check, no network
 *
 * Gas is auto-selected by build(): if the sender's aggregate address balance
 * covers the budget it pays from there (adding a ValidDuring expiration),
 * otherwise it selects an owned SUI coin. No gas flag needed.
 *
 * Env (parsed up front; missing required ones throw before any work):
 *   GRPC_URL         grpc-web base url of a fullnode           (required)
 *   SENDER           0x.. AdminCap holder / signer            (required)
 *   PACKAGE_ID       0x.. published memwal package            (required)
 *   ADMIN_CAP_ID     0x.. AdminCap held by SENDER             (required)
 *   REGISTRY_ID      0x.. shared AccountRegistry              (required)
 *   ALLOWLIST_ROOT   32-byte hex Merkle root (the `root` field of the
 *                    migration-allowlist manifest) baked into every cap. The
 *                    registry must already have this exact root pinned: no pin
 *                    aborts EAllowlistRootNotPinned, a different pinned root
 *                    aborts EAllowlistRootMismatch. (required)
 *   RECIPIENTS_JSON  JSON array of hot-wallet addresses (inline, or a path to a
 *                    .json file) — one MigrationCap minted + transferred to each.
 *                    Max 1000 per tx.
 *   NETWORK          mainnet|testnet          (default mainnet)
 *   GAS_BUDGET       MIST                     (default 5000000000 = 5 SUI)
 *   OUT              file to write base64 to  (default: stdout)
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { Transaction } from "@mysten/sui/transactions";
import { SuiGrpcClient } from "@mysten/sui/grpc";
import { fromHex, toBase64 } from "@mysten/sui/utils";
import {
  accountType,
  assertAddress,
  assertChainIdentifier,
  assertObjectId,
  assertObjectTypes,
  env,
  governanceNetwork,
  requireEnv,
} from "./assertions.js";

/** One MigrationCap is minted per recipient; cap the batch at 1000 per tx. */
const MAX_CAPS = 1000;

/** Parse the allowlist Merkle root: exactly 32 bytes, hex, optional 0x prefix. */
function parseAllowlistRoot(v: string): Uint8Array {
  const hex = v.replace(/^0x/i, "");
  if (!/^[0-9a-fA-F]{64}$/.test(hex))
    throw new Error(
      `ALLOWLIST_ROOT must be a 32-byte hex string (64 hex chars), got ${JSON.stringify(
        v
      )}`
    );
  return fromHex(hex);
}

/** Load RECIPIENTS_JSON (inline JSON or a path to a .json file) → validated addresses. */
function parseRecipients(spec: string): string[] {
  const text = existsSync(spec) ? readFileSync(spec, "utf8") : spec;
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (e) {
    throw new Error(
      `RECIPIENTS_JSON: not valid JSON (inline or file path): ${
        (e as Error).message
      }`
    );
  }
  if (!Array.isArray(json) || json.length === 0)
    throw new Error(
      "RECIPIENTS_JSON must be a non-empty JSON array of addresses"
    );
  const recipients = json.map((a, i) =>
    assertAddress(String(a).trim(), `RECIPIENTS_JSON[${i}]`)
  );
  const dup = recipients.find((a, i) => recipients.indexOf(a) !== i);
  if (dup)
    throw new Error(
      `duplicate recipient ${dup} — one MigrationCap per address`
    );
  if (recipients.length > MAX_CAPS)
    throw new Error(
      `too many recipients (${recipients.length}); max ${MAX_CAPS} MigrationCaps per tx`
    );
  return recipients;
}

async function main() {
  if (process.argv.includes("--self-test")) return selfTest();

  // 1. parse env → strings (throws early if a required var is missing).
  const grpcUrlStr = requireEnv("GRPC_URL");
  const senderStr = requireEnv("SENDER");
  const packageIdStr = requireEnv("PACKAGE_ID");
  const adminCapIdStr = requireEnv("ADMIN_CAP_ID");
  const registryIdStr = requireEnv("REGISTRY_ID");
  const allowlistRootStr = requireEnv("ALLOWLIST_ROOT");
  const recipientsStr = requireEnv("RECIPIENTS_JSON");
  const networkStr = env("NETWORK", "mainnet")!;
  const gasBudgetStr = env("GAS_BUDGET", "5000000000")!;
  const outStr = env("OUT");

  // 2. validate → fully-typed values.
  const sender = assertAddress(senderStr, "SENDER");
  const packageId = assertObjectId(packageIdStr, "PACKAGE_ID");
  const adminCapId = assertObjectId(adminCapIdStr, "ADMIN_CAP_ID");
  const registryId = assertObjectId(registryIdStr, "REGISTRY_ID");
  const allowlistRoot = parseAllowlistRoot(allowlistRootStr);
  const recipients = parseRecipients(recipientsStr);
  const network = governanceNetwork(networkStr);
  const gasBudget = BigInt(gasBudgetStr);

  // 3. logic.
  const client = new SuiGrpcClient({ network, baseUrl: grpcUrlStr });
  const { chainIdentifier } = await client.core.getChainIdentifier();
  assertChainIdentifier(network, chainIdentifier);

  await assertObjectTypes(client, packageId, [
    { id: adminCapId, struct: "AdminCap", what: "ADMIN_CAP_ID" },
    { id: registryId, struct: "AccountRegistry", what: "REGISTRY_ID" },
  ]);

  const tx = new Transaction();
  // AdminCap (owned, by-ref), registry (shared, by-ref) and the root are the same
  // for every cap — build the inputs once. mint_migration_cap requires a pinned
  // root: it aborts EAllowlistRootNotPinned if none is pinned yet, and
  // EAllowlistRootMismatch if the pinned root differs from this one.
  const adminCap = tx.object(adminCapId);
  const registry = tx.object(registryId);
  const rootArg = tx.pure.vector("u8", allowlistRoot);
  for (const addr of recipients) {
    const cap = tx.moveCall({
      target: `${packageId}::account::mint_migration_cap`,
      arguments: [adminCap, registry, rootArg],
    });
    // MigrationCap is `key`-only, so the PTB TransferObjects command (which
    // needs key + store) cannot move it — hand it over through the module's
    // own `public entry` transfer instead.
    tx.moveCall({
      target: `${packageId}::account::transfer_migration_cap`,
      arguments: [cap, tx.pure.address(addr)],
    });
  }
  console.error(
    `caps: ${recipients.length}, allowlist_root: ${allowlistRootStr}`
  );

  tx.setSender(sender);
  tx.setGasBudget(gasBudget);
  // Gas payment is left unset on purpose: build() pays from the sender's address
  // balance if it covers the budget (adding a ValidDuring expiration), else picks
  // an owned SUI coin.
  const b64 = toBase64(await tx.build({ client }));
  if (outStr) {
    writeFileSync(outStr, b64);
    console.error(`wrote unsigned tx bytes -> ${outStr}`);
  } else {
    process.stdout.write(b64 + "\n");
  }
}

function selfTest() {
  const assert = (c: unknown, m: string) => {
    if (!c) throw new Error("self-test failed: " + m);
  };
  const threw = (fn: () => unknown) => {
    try {
      fn();
      return false;
    } catch {
      return true;
    }
  };
  const A = "0x" + "1".repeat(64);
  const B = "0x" + "2".repeat(64);

  assert(
    parseRecipients(JSON.stringify([A, B])).length === 2,
    "two recipients parsed"
  );
  assert(
    threw(() => parseRecipients(JSON.stringify([A, A]))),
    "duplicate recipient rejected"
  );
  assert(
    threw(() => parseRecipients(JSON.stringify([]))),
    "empty recipients rejected"
  );
  assert(
    threw(() => parseRecipients(JSON.stringify([A, "0x123"]))),
    "bad address rejected"
  );
  assert(
    threw(() => parseRecipients("not json")),
    "non-JSON rejected"
  );
  const many = Array.from(
    { length: MAX_CAPS + 1 },
    (_, i) => "0x" + i.toString(16).padStart(64, "0")
  );
  assert(
    parseRecipients(JSON.stringify(many.slice(0, MAX_CAPS))).length ===
      MAX_CAPS,
    `${MAX_CAPS} allowed`
  );
  assert(
    threw(() => parseRecipients(JSON.stringify(many))),
    `over ${MAX_CAPS} rejected`
  );

  assert(
    accountType(A, "AdminCap") === `${A}::account::AdminCap`,
    "admin cap type built"
  );
  assert(
    accountType("0x2", "AdminCap") ===
      accountType("0x" + "0".repeat(63) + "2", "AdminCap"),
    "type address padded"
  );

  const root = "a".repeat(64);
  assert(
    parseAllowlistRoot("0x" + root).length === 32,
    "root (0x) parsed to 32 bytes"
  );
  assert(
    parseAllowlistRoot(root).length === 32,
    "root (no 0x) parsed to 32 bytes"
  );
  assert(
    threw(() => parseAllowlistRoot("0x" + "a".repeat(62))),
    "short root rejected"
  );
  assert(
    threw(() => parseAllowlistRoot("0x" + "z".repeat(64))),
    "non-hex root rejected"
  );
  console.log("self-test OK");
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
