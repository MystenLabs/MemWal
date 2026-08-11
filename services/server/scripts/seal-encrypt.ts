/**
 * SEAL Encrypt Sidecar Script
 *
 * Encrypts data using SEAL threshold encryption.
 * Called by the Rust server as a subprocess.
 *
 * Uses @mysten/seal SealClient.encrypt() with the key ID
 * `owner ‖ access_counter_version`, read from the account object — the same
 * identity the sidecar's POST /seal/encrypt builds. The counter is read fresh
 * per run and never taken from an argument: it exists to stop a removed
 * delegate from decrypting later memories, which a stale value would undo.
 *
 * Usage:
 *   npx tsx seal-encrypt.ts \
 *     --data <base64-encoded-plaintext> \
 *     --owner <0x-sui-address> \
 *     --package-id <0x-package-id> \
 *     --account-id <0x-memwal-account-id>
 *
 * Output (JSON to stdout):
 *   { "encryptedData": "<base64>" }
 *
 * Errors are written to stderr with non-zero exit code.
 */

import { SuiGrpcClient } from "@mysten/sui/grpc";
import { SealClient } from "@mysten/seal";
import {
  getSealServerConfigsFromEnv,
  getSealThresholdFromEnv,
} from "./seal-config.js";
import {
  buildSealEncryptId,
  fetchSealEncryptIdentity,
} from "./sidecar/seal-identity.js";

// Network config from env vars
const SUI_NETWORK = (process.env.SUI_NETWORK || "mainnet") as
  | "mainnet"
  | "testnet";
const SEAL_SERVER_CONFIGS = getSealServerConfigsFromEnv();
const SEAL_THRESHOLD = getSealThresholdFromEnv(SEAL_SERVER_CONFIGS);

// ============================================================
// Parse CLI arguments
// ============================================================

const USAGE =
  "usage: seal-encrypt.ts --data <base64> --owner <0x...> --package-id <0x...> --account-id <0x...>";

function parseArgs(): {
  data: Uint8Array;
  owner: string;
  packageId: string;
  accountId: string;
} {
  const args = process.argv.slice(2);
  let data: string | undefined;
  let owner: string | undefined;
  let packageId: string | undefined;
  let accountId: string | undefined;

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case "--data":
        data = args[++i];
        break;
      case "--owner":
        owner = args[++i];
        break;
      case "--package-id":
        packageId = args[++i];
        break;
      case "--account-id":
        accountId = args[++i];
        break;
      case "--help":
        console.log(USAGE);
        process.exit(0);
    }
  }

  if (!data || !owner || !packageId || !accountId) {
    console.error(
      `error: required args: ${USAGE.replace("usage: seal-encrypt.ts ", "")}`
    );
    process.exit(1);
  }

  return {
    data: Buffer.from(data, "base64"),
    owner,
    packageId,
    accountId,
  };
}

// ============================================================
// Main
// ============================================================

async function main() {
  const { data, owner, packageId, accountId } = parseArgs();

  const grpcUrl =
    process.env.SUI_GRPC_URL?.trim() ||
    `https://fullnode.${SUI_NETWORK}.sui.io`;
  const suiClient = new SuiGrpcClient({
    baseUrl: grpcUrl,
    network: SUI_NETWORK,
  });

  const sealClient = new SealClient({
    suiClient: suiClient as any,
    serverConfigs: SEAL_SERVER_CONFIGS,
    verifyKeyServers: true,
  });

  // Validate the immutable account type and caller-supplied owner while
  // reading the rotation counter fresh from chain, then build the id exactly
  // as `account::seal_approve` parses it back out.
  const identity = await fetchSealEncryptIdentity(
    accountId,
    owner,
    packageId,
    "normal",
    suiClient
  );
  const id = buildSealEncryptId(identity.owner, identity.accessCounterVersion);
  const result = await sealClient.encrypt({
    threshold: SEAL_THRESHOLD,
    packageId: identity.immutablePackageId,
    id,
    data: new Uint8Array(data),
  });

  // Output as JSON to stdout
  const encryptedBase64 = Buffer.from(result.encryptedObject).toString(
    "base64"
  );
  console.log(JSON.stringify({ encryptedData: encryptedBase64 }));
}

main().catch((err) => {
  console.error(`seal-encrypt error: ${err.message || err}`);
  process.exit(1);
});
