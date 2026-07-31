#!/usr/bin/env tsx
/**
 * Build the UNSIGNED transaction bytes (base64) that BURN a spent MigrationCap —
 * `account::burn_migration_cap(MigrationCap)`, which deletes the cap so no import
 * authority survives finalize. Uses @mysten/sui over gRPC (no JSON-RPC). Output is
 * signed later (multisig / ledger / offline) and submitted separately — nothing
 * here executes.
 *
 *   tsx scripts/build-burn-cap-tx.ts
 *   tsx scripts/build-burn-cap-tx.ts --self-test   # pure-logic check, no network
 *
 * Unlike the mint/finalize builders this is NOT an AdminCap action: the cap is
 * taken by value, so SENDER is the hot wallet that OWNS the cap (the controller's),
 * and that wallet signs. Run this once per cap — the mint builder gives each wallet
 * exactly one, so one burn tx per wallet covers the batch.
 *
 * Burn every cap before `finalize_migration` (see build-finalize-tx.ts), which is
 * the separate AdminCap-signed latch.
 *
 * Gas is auto-selected by build(): if the sender's aggregate address balance
 * covers the budget it pays from there (adding a ValidDuring expiration),
 * otherwise it selects an owned SUI coin. No gas flag needed.
 *
 * Env (parsed up front; missing required ones throw before any work):
 *   GRPC_URL          grpc-web base url of a fullnode              (required)
 *   SENDER            0x.. wallet that owns the cap / signer       (required)
 *   PACKAGE_ID        0x.. published memwal package                (required)
 *   MIGRATION_CAP_ID  0x.. MigrationCap owned by SENDER, to burn   (required)
 *   NETWORK           mainnet|testnet          (default mainnet)
 *   GAS_BUDGET        MIST                     (default 500000000 = 0.5 SUI)
 *   OUT               file to write base64 to  (default: stdout)
 */

import { writeFileSync } from "node:fs";
import { Transaction } from "@mysten/sui/transactions";
import { SuiGrpcClient } from "@mysten/sui/grpc";
import { toBase64 } from "@mysten/sui/utils";
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

async function main() {
  if (process.argv.includes("--self-test")) return selfTest();

  // 1. parse env → strings (throws early if a required var is missing).
  const grpcUrlStr = requireEnv("GRPC_URL");
  const senderStr = requireEnv("SENDER");
  const packageIdStr = requireEnv("PACKAGE_ID");
  const migrationCapIdStr = requireEnv("MIGRATION_CAP_ID");
  const networkStr = env("NETWORK", "mainnet")!;
  const gasBudgetStr = env("GAS_BUDGET", "500000000")!;
  const outStr = env("OUT");

  // 2. validate → fully-typed values.
  const sender = assertAddress(senderStr, "SENDER");
  const packageId = assertObjectId(packageIdStr, "PACKAGE_ID");
  const migrationCapId = assertObjectId(migrationCapIdStr, "MIGRATION_CAP_ID");
  const network = governanceNetwork(networkStr);
  const gasBudget = BigInt(gasBudgetStr);

  // 3. logic.
  const client = new SuiGrpcClient({ network, baseUrl: grpcUrlStr });
  const { chainIdentifier } = await client.core.getChainIdentifier();
  assertChainIdentifier(network, chainIdentifier);

  await assertObjectTypes(client, packageId, [
    { id: migrationCapId, struct: "MigrationCap", what: "MIGRATION_CAP_ID" },
  ]);

  const tx = new Transaction();
  // burn_migration_cap(MigrationCap) — by value, so the client resolves the cap as
  // an owned object ref during build(); it must be owned by SENDER or build() fails.
  tx.moveCall({
    target: `${packageId}::account::burn_migration_cap`,
    arguments: [tx.object(migrationCapId)],
  });
  console.error(
    `burn_migration_cap on cap ${migrationCapId} (package ${packageId}), owner/sender ${sender}`
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
  const ID = "0x" + "1".repeat(64);

  assert(assertAddress(ID, "x") === ID, "valid address accepted");
  assert(assertObjectId(ID, "x") === ID, "valid object id accepted");
  assert(
    threw(() => assertAddress("0x123", "x")),
    "short address rejected"
  );
  assert(
    threw(() => assertObjectId("not-an-id", "x")),
    "non-id rejected"
  );
  assert(
    threw(() => requireEnv("WM_BURN_SELFTEST_MISSING")),
    "missing required env rejected"
  );

  assert(
    accountType(ID, "MigrationCap") === `${ID}::account::MigrationCap`,
    "migration cap type built"
  );
  assert(
    accountType("0x2", "MigrationCap") ===
      accountType("0x" + "0".repeat(63) + "2", "MigrationCap"),
    "type address padded"
  );
  console.log("self-test OK");
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
