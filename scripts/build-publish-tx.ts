#!/usr/bin/env tsx
/**
 * Build the UNSIGNED transaction bytes (base64) to PUBLISH the memwal contract,
 * using @mysten/sui over gRPC (no JSON-RPC). Output is signed later (multisig /
 * ledger / offline) and submitted separately — nothing here executes.
 *
 *   tsx scripts/build-publish-tx.ts
 *   tsx scripts/build-publish-tx.ts --self-test   # pure-logic check, no network
 *
 * Gas is auto-selected by build(): if the sender's aggregate address balance
 * covers the budget it pays from there (adding a ValidDuring expiration),
 * otherwise it selects an owned SUI coin. No gas flag needed.
 *
 * Env (parsed up front; missing required ones throw before any work):
 *   GRPC_URL      grpc-web base url of a fullnode              (required)
 *   SENDER        0x.. signer address (gets AdminCap)               (required)
 *   UPGRADE_CAP_RECIPIENT 0x.. separate cold/timelocked UpgradeCap custodian
 *                                                               (required)
 *   NETWORK       mainnet|testnet          (default mainnet)
 *   GAS_BUDGET    MIST                     (default 500000000 = 0.5 SUI)
 *   EPOCH         epoch the address-balance expiration window starts at; the tx
 *                 is valid during EPOCH..EPOCH+1. Only applies when build() pays
 *                 from the address balance — ignored when it picks a SUI coin.
 *                 (default: whatever epoch is live when this runs, which is wrong
 *                 if signing/submitting happens an epoch or more later.)
 *   CONTRACT_DIR  Move package path        (default services/contract)
 *   BUILD_ENV     testnet|mainnet          (default NETWORK) — which network's
 *                 dependency addresses `sui move build` resolves against. Required
 *                 to match NETWORK.
 *   OUT           file to write base64 to  (default: stdout)
 */

import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Transaction } from "@mysten/sui/transactions";
import { SuiGrpcClient } from "@mysten/sui/grpc";
import { toBase64 } from "@mysten/sui/utils";
import {
  assertAddress,
  assertChainIdentifier,
  env,
  GOVERNANCE_CHAIN_IDENTIFIERS,
  governanceNetwork,
  type GovernanceNetwork,
  requireEnv,
} from "./assertions.js";

function buildEnvironment(
  network: GovernanceNetwork,
  value: string
): GovernanceNetwork {
  const parsedBuildEnv = governanceNetwork(value, "BUILD_ENV");
  if (parsedBuildEnv !== network)
    throw new Error(
      `BUILD_ENV must match NETWORK (${network}), got ${JSON.stringify(
        parsedBuildEnv
      )}`
    );
  return parsedBuildEnv;
}

export function assertSeparateCapabilityCustody(
  sender: string,
  upgradeCapRecipient: string
): void {
  if (sender === upgradeCapRecipient) {
    throw new Error("UPGRADE_CAP_RECIPIENT must differ from SENDER");
  }
}

async function main() {
  if (process.argv.includes("--self-test")) return selfTest();

  // 1. parse env → strings (throws early if a required var is missing).
  const grpcUrlStr = requireEnv("GRPC_URL");
  const senderStr = requireEnv("SENDER");
  const upgradeCapRecipientStr = requireEnv("UPGRADE_CAP_RECIPIENT");
  const networkStr = env("NETWORK", "mainnet")!;
  const gasBudgetStr = env("GAS_BUDGET", "500000000")!;
  const epochStr = env("EPOCH");
  const contractDirStr = env(
    "CONTRACT_DIR",
    resolve(
      fileURLToPath(new URL(".", import.meta.url)),
      "../services/contract"
    )
  )!;
  const buildEnvStr = env("BUILD_ENV", networkStr)!;
  const outStr = env("OUT");

  // 2. validate → fully-typed values.
  const sender = assertAddress(senderStr, "SENDER");
  const upgradeCapRecipient = assertAddress(
    upgradeCapRecipientStr,
    "UPGRADE_CAP_RECIPIENT"
  );
  assertSeparateCapabilityCustody(sender, upgradeCapRecipient);
  const network = governanceNetwork(networkStr);
  const gasBudget = BigInt(gasBudgetStr);
  const epoch = epochStr === undefined ? undefined : BigInt(epochStr);
  const contractDir = resolve(contractDirStr);
  const buildEnv = buildEnvironment(network, buildEnvStr);

  // 3. logic.
  const client = new SuiGrpcClient({ network, baseUrl: grpcUrlStr });
  const { chainIdentifier } = await client.core.getChainIdentifier();
  assertChainIdentifier(network, chainIdentifier);

  // Compile via the CLI (the only reliable source of bytecode; no network).
  console.error(`sui move build --dump-bytecode-as-base64 (${contractDir})`);
  let built: string;
  try {
    built = execFileSync(
      "sui",
      [
        "move",
        "build",
        "--dump-bytecode-as-base64",
        "--build-env",
        buildEnv,
        "--path",
        contractDir,
      ],
      {
        encoding: "utf8",
        maxBuffer: 64 * 1024 * 1024,
      }
    );
  } catch (e) {
    // sui prints the compile error to stdout/stderr; surface both instead of a bare "Command failed".
    const { stdout, stderr } = e as { stdout?: string; stderr?: string };
    throw new Error(
      `sui move build failed:\n${[stderr, stdout]
        .filter(Boolean)
        .join("\n")
        .trim()}`
    );
  }
  const { modules, dependencies } = JSON.parse(built) as {
    modules: string[];
    dependencies: string[];
  };

  const tx = new Transaction();
  const [upgradeCap] = tx.publish({ modules, dependencies });
  // init() transfers the AdminCap to the sender. Keep package upgrade authority
  // in a distinct cold/timelocked custodian so one compromised principal cannot
  // both exercise application administration and replace the package code.
  tx.transferObjects([upgradeCap], tx.pure.address(upgradeCapRecipient));

  tx.setSender(sender);
  tx.setGasBudget(gasBudget);
  // Gas payment is left unset on purpose: build() pays from the sender's address
  // balance if it covers the budget (adding a ValidDuring expiration), else picks
  // an owned SUI coin.
  if (epoch !== undefined) {
    // A ValidDuring expiration is the SDK's tell for address-balance gas — it only
    // attaches one once gas payment resolved to []. Await next() so this runs after
    // the resolver, then rewrite the window it derived from the live epoch. Nothing
    // to touch on a coin-paying tx, so EPOCH is ignored there for free.
    tx.addBuildPlugin(async (data, _options, next) => {
      await next();
      if (data.expiration?.$kind !== "ValidDuring") return;
      data.expiration.ValidDuring.minEpoch = String(epoch);
      data.expiration.ValidDuring.maxEpoch = String(epoch + 1n);
    });
  }
  const b64 = toBase64(await tx.build({ client }));
  const expiration = tx.getData().expiration;
  if (expiration?.$kind === "ValidDuring") {
    const { minEpoch, maxEpoch } = expiration.ValidDuring;
    console.error(
      `gas: sender address balance, valid during epochs ${minEpoch}..${maxEpoch}`
    );
  } else {
    console.error("gas: owned SUI coin (EPOCH unused)");
  }
  if (outStr) {
    writeFileSync(outStr, b64);
    console.error(`wrote unsigned tx bytes -> ${outStr}`);
  } else {
    process.stdout.write(b64 + "\n");
  }
}

function selfTest() {
  const assert = (condition: unknown, message: string) => {
    if (!condition) throw new Error(`self-test failed: ${message}`);
  };
  const threw = (fn: () => unknown) => {
    try {
      fn();
      return false;
    } catch {
      return true;
    }
  };

  assert(governanceNetwork("mainnet") === "mainnet", "mainnet accepted");
  assert(governanceNetwork("testnet") === "testnet", "testnet accepted");
  assert(
    threw(() => governanceNetwork("devnet")),
    "devnet rejected"
  );
  assert(
    buildEnvironment("testnet", "testnet") === "testnet",
    "matching build environment accepted"
  );
  assert(
    threw(() => buildEnvironment("mainnet", "testnet")),
    "cross-network build environment rejected"
  );
  assertSeparateCapabilityCustody("0x1", "0x2");
  assert(
    threw(() => assertSeparateCapabilityCustody("0x1", "0x1")),
    "shared AdminCap/UpgradeCap custody rejected"
  );
  assertChainIdentifier("mainnet", GOVERNANCE_CHAIN_IDENTIFIERS.mainnet);
  assert(
    threw(() =>
      assertChainIdentifier("mainnet", GOVERNANCE_CHAIN_IDENTIFIERS.testnet)
    ),
    "wrong chain rejected"
  );
  console.log("self-test OK");
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
