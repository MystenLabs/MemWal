#!/usr/bin/env tsx
/**
 * Pay every wallet listed in scripts/distribute-funds.<network>.json the same
 * amount of SUI and WAL, in one atomic transaction, using @mysten/sui over gRPC
 * (no JSON-RPC). NETWORK picks the file, so a mainnet run cannot read the
 * testnet list. The manifest maps each stable Kubernetes writer pod id to the
 * exact ordered wallet addresses reported by that pod's /ready endpoint.
 *
 *   tsx scripts/distribute-funds.ts              # dry run: simulate only
 *   DRY_RUN=false tsx scripts/distribute-funds.ts   # actually send it
 *   tsx scripts/distribute-funds.ts --self-test  # pure-logic check, no network
 *
 * Unlike the other tx:* scripts, this one signs and executes rather than
 * emitting unsigned bytes: the sender is a hot key held in a GitHub secret, not
 * the AdminCap multisig, so there is nothing to sign offline. SENDER is derived
 * from that key — it is never passed in, so funds can only ever leave the wallet
 * the secret actually controls.
 *
 * Funds arrive AS ADDRESS BALANCES via `0x2::balance::send_funds<T>`, not as
 * owned Coin objects: the upload writers fail closed before submission if either
 * currency would fall back to a coin, so coin objects would leave every wallet
 * funded on paper and unable to register a blob.
 *
 * Before building, the sender's SUI and WAL balances are checked against the
 * totals (recipients x per-address amount, plus GAS_BUDGET for SUI) and it
 * aborts naming the shortfall if either falls short.
 *
 * The payout is one PTB, so it is all-or-nothing: a failure funds nobody, and a
 * failed run cannot half-pay the list.
 *
 * Env (parsed up front; missing required ones throw before any work):
 *   SUI_FUNDER_KEY     sender's Ed25519 private key, bech32 `suiprivkey1...`
 *                      (what `sui keytool export` prints)          (required)
 *   GRPC_URL           grpc-web base url of a fullnode             (required)
 *   MIST_PER_ADDRESS   SUI per recipient, in MIST (1 SUI = 1e9)    (required)
 *   FROST_PER_ADDRESS  WAL per recipient, in FROST (1 WAL = 1e9)   (required)
 *   NETWORK            mainnet|testnet          (default mainnet)
 *   GAS_BUDGET         MIST                     (default 5000000000 = 5 SUI)
 *   DRY_RUN            simulate and report without sending (default true — set
 *                      to false to actually move funds)
 *   LIVE_WRITER_ADDRESSES_JSON
 *                      fresh output from collect-live-writer-addresses.sh;
 *                      required and matched exactly when DRY_RUN=false
 *   FUNDING_JOURNAL_OUT
 *                      durable journal path (default funding-journal.json)
 *   FUNDING_JOURNAL_JSON
 *                      a previous journal to reconcile/resume; DRY_RUN must be
 *                      false and only its original signed bytes are replayed
 *   FUNDING_PREPARE_ONLY
 *                      with DRY_RUN=false, persist a signed journal and exit
 *                      before submission (default false)
 */

import {
  closeSync,
  fsyncSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname } from "node:path";
import { Transaction, TransactionDataBuilder } from "@mysten/sui/transactions";
import { SuiGrpcClient } from "@mysten/sui/grpc";
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import {
  isValidSuiAddress,
  normalizeSuiAddress,
  normalizeStructTag,
  parseStructTag,
} from "@mysten/sui/utils";
import { verifyTransactionSignature } from "@mysten/sui/verify";

type Network = "mainnet" | "testnet";
type WriterAddresses = Record<string, string[]>;

type LiveWriterSnapshot = {
  schemaVersion: 1;
  collectedAt: string;
  context: string;
  namespace: string;
  statefulSet: {
    name: string;
    uid: string;
    generation: number;
    revision: string;
    replicas: number;
    currentReplicas: number;
    updatedReplicas: number;
    readyReplicas: number;
  };
  writerSecrets: Array<{
    name: string;
    uid: string;
    resourceVersion: string;
    immutable: true;
  }>;
  writerSecretProviders: Array<{
    container: string;
    secretName: string;
    key: string;
    source: "secretKeyRef" | "envFrom";
  }>;
  writers: Array<{
    id: string;
    ordinal: number;
    podUid: string;
    revision: string;
    images: Array<{ name: string; image: string; imageId: string }>;
    addresses: string[];
  }>;
};

type FundingIntent = {
  network: Network;
  sender: string;
  walType: string;
  payoutManifest: string;
  writers: WriterAddresses;
  mistPerAddress: string;
  frostPerAddress: string;
  gasBudget: string;
};

type FundingJournal = {
  schemaVersion: 1;
  kind: "walrus-memory-funding";
  status: "simulated" | "prepared" | "succeeded" | "failed";
  createdAt: string;
  updatedAt: string;
  intent: FundingIntent;
  liveSnapshot?: LiveWriterSnapshot;
  transaction?: {
    transactionBytes: string;
    signature: string;
    digest: string;
  };
  execution?: {
    observedAt: string;
    source: "query" | "submit";
    success: boolean;
    error?: unknown;
  };
};

const SUI_TYPE = "0x2::sui::SUI";
const SUI_FRAMEWORK = normalizeSuiAddress("0x2");
const LIVE_SNAPSHOT_MAX_AGE_MS = 15 * 60 * 1000;
const LIVE_SNAPSHOT_FUTURE_SKEW_MS = 60 * 1000;
const FUNDING_JOURNAL_SCHEMA_VERSION = 1;

/**
 * The payout list for a network: scripts/distribute-funds.<network>.json. Kept
 * per network because testnet and mainnet fund entirely different wallets, and a
 * single shared file is one edit away from paying the wrong fleet.
 */
function recipientsFile(network: Network): URL {
  return new URL(`./distribute-funds.${network}.json`, import.meta.url);
}

/** Two coins are transferred per recipient; cap the batch inside the PTB command budget. */
const MAX_RECIPIENTS = 500;

/**
 * The walrus system object per network — the anchor the WAL coin type is read
 * from. Same ids the walrus CLI config (~/.config/walrus/client_config.yaml) and
 * @mysten/walrus ship; the mainnet one also matches the walrus config pinned in
 * .github/workflows/deploy-app-walrus.yml.
 */
const WALRUS_SYSTEM_OBJECT: Record<Network, string> = {
  mainnet: "0x2134d52768ea07e8c43570ef975eb3e4c27a39fa6396bef985b5abc58d03ddd2",
  testnet: "0x6c2547cbbc38025cf3adac45f63cb0a8d12ecf777cdc75a4971612bf97fdf6af",
};

function env(name: string, fallback?: string): string | undefined {
  const v = process.env[name]?.trim();
  return v && v.length > 0 ? v : fallback;
}

function requireEnv(name: string): string {
  const v = env(name);
  if (!v) throw new Error(`missing required env var ${name}`);
  return v;
}

function assertAddress(v: string, what: string): string {
  if (!isValidSuiAddress(v))
    throw new Error(`${what} is not a valid Sui address: ${JSON.stringify(v)}`);
  return normalizeSuiAddress(v);
}

/** Parse a positive amount of a coin's smallest unit (MIST / FROST). */
function parseAmount(v: string, what: string): bigint {
  if (!/^\d+$/.test(v))
    throw new Error(
      `${what} must be a whole number of base units, got ${JSON.stringify(v)}`
    );
  const n = BigInt(v);
  if (n === 0n) throw new Error(`${what} must be greater than 0`);
  return n;
}

/**
 * Validate and flatten the writer -> ordered wallet mapping. Grouping is part
 * of the safety contract: a paid run reconciles it with the live sidecars.
 */
function normalizeWriters(manifest: unknown): WriterAddresses {
  const writers: WriterAddresses = {};
  if (
    manifest === null ||
    typeof manifest !== "object" ||
    Array.isArray(manifest)
  ) {
    throw new Error(
      "payout manifest must be an object mapping writer ids to ordered address arrays"
    );
  }
  for (const [writer, addrs] of Object.entries(
    manifest as Record<string, unknown>
  )) {
    if (!writer.trim()) throw new Error("writer id must not be empty");
    if (!Array.isArray(addrs) || addrs.length === 0)
      throw new Error(`${writer} has no addresses`);
    writers[writer] = addrs.map((a, i) =>
      assertAddress(String(a).trim(), `${writer}[${i}]`)
    );
  }
  const out = Object.values(writers).flat();
  if (out.length === 0) throw new Error("no addresses to fund");

  // An address listed under two writers would otherwise be paid twice.
  const dup = out.find((a, i) => out.indexOf(a) !== i);
  if (dup)
    throw new Error(
      `duplicate recipient ${dup} — each address must appear once`
    );
  if (out.length > MAX_RECIPIENTS)
    throw new Error(
      `too many recipients (${out.length}); max ${MAX_RECIPIENTS} per tx`
    );

  return writers;
}

function flattenWriters(manifest: unknown): string[] {
  return Object.values(normalizeWriters(manifest)).flat();
}

function parseWriters(raw: string, what: string): WriterAddresses {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`${what} is not valid JSON`);
  }
  return normalizeWriters(parsed);
}

function requireRecord(value: unknown, what: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error(`${what} must be an object`);
  return value as Record<string, unknown>;
}

function requireString(value: unknown, what: string): string {
  if (typeof value !== "string" || !value.trim())
    throw new Error(`${what} must be a non-empty string`);
  return value;
}

function requirePositiveInteger(value: unknown, what: string): number {
  if (!Number.isSafeInteger(value) || Number(value) <= 0)
    throw new Error(`${what} must be a positive integer`);
  return Number(value);
}

/** Parse a collector snapshot and bind every pod to one stable StatefulSet rollout. */
function parseLiveWriterSnapshot(
  raw: string,
  nowMs = Date.now(),
  requireFresh = true
): LiveWriterSnapshot {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("LIVE_WRITER_ADDRESSES_JSON is not valid JSON");
  }
  const root = requireRecord(parsed, "live writer snapshot");
  if (root.schemaVersion !== 1)
    throw new Error("live writer snapshot schemaVersion must be 1");

  const collectedAt = requireString(root.collectedAt, "snapshot collectedAt");
  const collectedAtMs = Date.parse(collectedAt);
  if (!Number.isFinite(collectedAtMs))
    throw new Error("snapshot collectedAt must be an ISO-8601 timestamp");
  if (requireFresh) {
    const ageMs = nowMs - collectedAtMs;
    if (ageMs > LIVE_SNAPSHOT_MAX_AGE_MS)
      throw new Error(
        `live writer snapshot is older than 15 minutes (${Math.floor(
          ageMs / 1000
        )}s)`
      );
    if (ageMs < -LIVE_SNAPSHOT_FUTURE_SKEW_MS)
      throw new Error("live writer snapshot collectedAt is in the future");
  }

  const statefulSetRaw = requireRecord(
    root.statefulSet,
    "snapshot statefulSet"
  );
  const statefulSet = {
    name: requireString(statefulSetRaw.name, "statefulSet.name"),
    uid: requireString(statefulSetRaw.uid, "statefulSet.uid"),
    generation: requirePositiveInteger(
      statefulSetRaw.generation,
      "statefulSet.generation"
    ),
    revision: requireString(statefulSetRaw.revision, "statefulSet.revision"),
    replicas: requirePositiveInteger(
      statefulSetRaw.replicas,
      "statefulSet.replicas"
    ),
    currentReplicas: requirePositiveInteger(
      statefulSetRaw.currentReplicas,
      "statefulSet.currentReplicas"
    ),
    updatedReplicas: requirePositiveInteger(
      statefulSetRaw.updatedReplicas,
      "statefulSet.updatedReplicas"
    ),
    readyReplicas: requirePositiveInteger(
      statefulSetRaw.readyReplicas,
      "statefulSet.readyReplicas"
    ),
  };
  if (
    statefulSet.currentReplicas !== statefulSet.replicas ||
    statefulSet.updatedReplicas !== statefulSet.replicas ||
    statefulSet.readyReplicas !== statefulSet.replicas
  ) {
    throw new Error(
      "snapshot StatefulSet rollout is not fully ready and updated"
    );
  }

  if (!Array.isArray(root.writerSecrets) || root.writerSecrets.length === 0)
    throw new Error(
      "snapshot must identify at least one immutable writer Secret"
    );
  const secretNames = new Set<string>();
  const writerSecrets = root.writerSecrets.map((rawSecret, index) => {
    const secret = requireRecord(rawSecret, `writerSecrets[${index}]`);
    const name = requireString(secret.name, `writerSecrets[${index}].name`);
    if (secret.immutable !== true)
      throw new Error(`${name} must be an immutable Kubernetes Secret`);
    if (secretNames.has(name))
      throw new Error(`duplicate writer Secret ${name}`);
    secretNames.add(name);
    return {
      name,
      uid: requireString(secret.uid, `${name}.uid`),
      resourceVersion: requireString(
        secret.resourceVersion,
        `${name}.resourceVersion`
      ),
      immutable: true as const,
    };
  });
  if (
    !Array.isArray(root.writerSecretProviders) ||
    root.writerSecretProviders.length === 0
  ) {
    throw new Error(
      "snapshot must resolve the Secret provider for SERVER_SUI_PRIVATE_KEYS"
    );
  }
  const providerContainers = new Set<string>();
  const writerSecretProviders = root.writerSecretProviders.map(
    (rawProvider, index) => {
      const provider = requireRecord(
        rawProvider,
        `writerSecretProviders[${index}]`
      );
      const container = requireString(
        provider.container,
        `writerSecretProviders[${index}].container`
      );
      const secretName = requireString(
        provider.secretName,
        `${container}.secretName`
      );
      const key = requireString(provider.key, `${container}.secretKey`);
      if (key !== "SERVER_SUI_PRIVATE_KEYS")
        throw new Error(
          `${container} writer Secret must provide SERVER_SUI_PRIVATE_KEYS`
        );
      if (provider.source !== "secretKeyRef" && provider.source !== "envFrom")
        throw new Error(`${container} has an invalid writer Secret source`);
      if (!secretNames.has(secretName))
        throw new Error(
          `${container} references unverified Secret ${secretName}`
        );
      if (providerContainers.has(container))
        throw new Error(`${container} has ambiguous writer Secret providers`);
      providerContainers.add(container);
      const source: "secretKeyRef" | "envFrom" = provider.source;
      return { container, secretName, key, source };
    }
  );
  if (!Array.isArray(root.writers))
    throw new Error("snapshot writers must be an array");
  if (root.writers.length !== statefulSet.replicas)
    throw new Error(
      `snapshot has ${root.writers.length} writers but StatefulSet has ${statefulSet.replicas} replicas`
    );

  const podUids = new Set<string>();
  const writers = root.writers.map((rawWriter, ordinal) => {
    const writer = requireRecord(rawWriter, `writers[${ordinal}]`);
    const id = requireString(writer.id, `writers[${ordinal}].id`);
    const podUid = requireString(writer.podUid, `writers[${ordinal}].podUid`);
    const revision = requireString(
      writer.revision,
      `writers[${ordinal}].revision`
    );
    if (writer.ordinal !== ordinal)
      throw new Error(`writers[${ordinal}].ordinal must be ${ordinal}`);
    if (id !== `${statefulSet.name}-${ordinal}`)
      throw new Error(
        `writers[${ordinal}].id must be ${statefulSet.name}-${ordinal}`
      );
    if (revision !== statefulSet.revision)
      throw new Error(
        `${id} is not on StatefulSet revision ${statefulSet.revision}`
      );
    if (podUids.has(podUid)) throw new Error(`duplicate pod UID ${podUid}`);
    podUids.add(podUid);
    if (!Array.isArray(writer.images) || writer.images.length === 0)
      throw new Error(`${id} must report at least one running container image`);
    const imageNames = new Set<string>();
    const images = writer.images.map((rawImage, imageIndex) => {
      const image = requireRecord(rawImage, `${id}.images[${imageIndex}]`);
      const name = requireString(
        image.name,
        `${id}.images[${imageIndex}].name`
      );
      if (imageNames.has(name))
        throw new Error(`${id} repeats container ${name}`);
      imageNames.add(name);
      return {
        name,
        image: requireString(image.image, `${id}.${name}.image`),
        imageId: requireString(image.imageId, `${id}.${name}.imageId`),
      };
    });
    const addresses = normalizeWriters({ [id]: writer.addresses })[id];
    return { id, ordinal, podUid, revision, images, addresses };
  });
  const expectedImages = JSON.stringify(writers[0]?.images);
  for (const writer of writers) {
    if (JSON.stringify(writer.images) !== expectedImages)
      throw new Error("writer pods do not run the same container image IDs");
  }
  for (const provider of writerSecretProviders) {
    if (
      writers.some(
        (writer) =>
          !writer.images.some((image) => image.name === provider.container)
      )
    ) {
      throw new Error(
        `writer Secret provider ${provider.container} is not running in every writer pod`
      );
    }
  }

  return {
    schemaVersion: 1,
    collectedAt,
    context: requireString(root.context, "snapshot context"),
    namespace: requireString(root.namespace, "snapshot namespace"),
    statefulSet,
    writerSecrets,
    writerSecretProviders,
    writers,
  };
}

/** Require the exact writer and upload-key order checked into the network manifest. */
function reconcileLiveWriters(
  expected: WriterAddresses,
  raw: string,
  nowMs = Date.now()
): LiveWriterSnapshot {
  const snapshot = parseLiveWriterSnapshot(raw, nowMs);
  assertSnapshotMatchesWriters(expected, snapshot);
  return snapshot;
}

function assertSnapshotMatchesWriters(
  expected: WriterAddresses,
  snapshot: LiveWriterSnapshot
): void {
  const expectedIds = Object.keys(expected);
  const liveIds = snapshot.writers.map((writer) => writer.id);
  if (JSON.stringify(liveIds) !== JSON.stringify(expectedIds)) {
    throw new Error(
      "live writer order does not exactly match the payout manifest"
    );
  }
  snapshot.writers.forEach((writer) => {
    if (
      JSON.stringify(writer.addresses) !== JSON.stringify(expected[writer.id])
    ) {
      throw new Error(
        `${writer.id} live wallet order does not match the payout manifest`
      );
    }
  });
}

/**
 * Read the WAL coin type off chain, the way @mysten/walrus does it (its
 * #walType() is private, so there is nothing to import): the walrus package id
 * is the address of the system object's own type, and WAL is the coin that
 * `staking::stake_with_pool` takes. Nothing is hardcoded because mainnet and
 * testnet WAL are different packages — and matching on the sender's coins
 * instead would be spoofable, since anyone can publish a `wal::WAL` and airdrop
 * it.
 */
async function walTypeForNetwork(
  client: SuiGrpcClient,
  network: Network
): Promise<string> {
  const { object } = await client.getObject({
    objectId: WALRUS_SYSTEM_OBJECT[network],
  });
  const packageId = parseStructTag(object.type).address;

  const { function: stakeWithPool } = await client.getMoveFunction({
    packageId,
    moduleName: "staking",
    name: "stake_with_pool",
  });

  // stake_with_pool(_, to_stake: Coin<WAL>, ..) — WAL is Coin's type argument.
  const toStake = stakeWithPool.parameters[1]?.body;
  const coin = toStake?.$kind === "datatype" ? toStake.datatype : null;
  const wal = coin?.typeParameters[0];
  if (wal?.$kind !== "datatype")
    throw new Error(
      `could not read the WAL type from ${packageId}::staking::stake_with_pool`
    );

  const walType = normalizeStructTag(wal.datatype.typeName);
  // The walrus Rust client asserts the same suffix when it reads the type off
  // chain (crates/walrus-sui/.../retriable_sui_client.rs).
  if (!walType.endsWith("::wal::WAL"))
    throw new Error(`${packageId} yielded a non-WAL coin type: ${walType}`);

  return walType;
}

function requireFunds(what: string, have: bigint, need: bigint): void {
  if (have < need)
    throw new Error(
      `insufficient ${what}: sender has ${have}, needs ${need} (short ${
        need - have
      })`
    );
}

/** Unwrap a gRPC transaction result, throwing with the Move abort on failure. */
function requireSuccess(result: any, context: string) {
  const tx = result?.Transaction || result?.FailedTransaction;
  if (!tx) throw new Error(`${context}: gRPC response has no transaction`);
  if (!tx.status?.success) {
    const error = tx.status?.error;
    throw new Error(
      `${context}: ${typeof error === "string" ? error : JSON.stringify(error)}`
    );
  }
  return tx;
}

function fundingIntent(params: {
  network: Network;
  sender: string;
  walType: string;
  payoutManifest: string;
  writers: WriterAddresses;
  mistPer: bigint;
  frostPer: bigint;
  gasBudget: bigint;
}): FundingIntent {
  return {
    network: params.network,
    sender: assertAddress(params.sender, "funding sender"),
    walType: normalizeStructTag(params.walType),
    payoutManifest: params.payoutManifest,
    writers: normalizeWriters(params.writers),
    mistPerAddress: params.mistPer.toString(),
    frostPerAddress: params.frostPer.toString(),
    gasBudget: params.gasBudget.toString(),
  };
}

function canonicalBase64(value: unknown, what: string): Uint8Array {
  const encoded = requireString(value, what);
  const bytes = new Uint8Array(Buffer.from(encoded, "base64"));
  if (!bytes.length || Buffer.from(bytes).toString("base64") !== encoded)
    throw new Error(`${what} must be canonical base64`);
  return bytes;
}

function inputForArgument(
  data: TransactionDataBuilder,
  argument: any,
  what: string
) {
  if (argument?.$kind !== "Input")
    throw new Error(`${what} must refer to a transaction input`);
  const input = data.inputs[argument.Input];
  if (!input) throw new Error(`${what} refers to a missing transaction input`);
  return input;
}

function pureAddress(
  data: TransactionDataBuilder,
  argument: any,
  what: string
): string {
  const input = inputForArgument(data, argument, what);
  if (input.$kind !== "Pure") throw new Error(`${what} must be a pure address`);
  const bytes = canonicalBase64(input.Pure.bytes, what);
  if (bytes.length !== 32)
    throw new Error(`${what} must contain a Sui address`);
  return normalizeSuiAddress(`0x${Buffer.from(bytes).toString("hex")}`);
}

function pureU64(
  data: TransactionDataBuilder,
  argument: any,
  what: string
): bigint {
  const input = inputForArgument(data, argument, what);
  if (input.$kind !== "Pure") throw new Error(`${what} must be a pure u64`);
  const bytes = canonicalBase64(input.Pure.bytes, what);
  if (bytes.length !== 8) throw new Error(`${what} must contain a u64`);
  return Buffer.from(bytes).readBigUInt64LE();
}

function outputAmount(
  data: TransactionDataBuilder,
  argument: any,
  coinType: string,
  what: string
): bigint {
  if (argument?.$kind !== "NestedResult")
    throw new Error(`${what} must consume a prepared balance`);
  const [commandIndex, resultIndex] = argument.NestedResult;
  const command = data.commands[commandIndex];
  if (command?.$kind !== "MoveCall" || resultIndex !== 0)
    throw new Error(`${what} does not consume a balance-producing Move call`);

  const moveCall = command.MoveCall;
  const type = moveCall.typeArguments[0];
  if (
    normalizeSuiAddress(moveCall.package) === SUI_FRAMEWORK &&
    moveCall.module === "balance" &&
    moveCall.function === "redeem_funds" &&
    moveCall.typeArguments.length === 1 &&
    normalizeStructTag(type) === coinType
  ) {
    const input = inputForArgument(
      data,
      moveCall.arguments[0],
      `${what} withdrawal`
    );
    const withdrawal = input.FundsWithdrawal;
    if (
      input.$kind !== "FundsWithdrawal" ||
      withdrawal.reservation.$kind !== "MaxAmountU64" ||
      withdrawal.typeArg.$kind !== "Balance" ||
      normalizeStructTag(withdrawal.typeArg.Balance) !== coinType ||
      withdrawal.withdrawFrom.$kind !== "Sender"
    ) {
      throw new Error(`${what} has an invalid address-balance withdrawal`);
    }
    return BigInt(withdrawal.reservation.MaxAmountU64);
  }

  if (
    normalizeSuiAddress(moveCall.package) === SUI_FRAMEWORK &&
    moveCall.module === "coin" &&
    moveCall.function === "into_balance" &&
    moveCall.typeArguments.length === 1 &&
    normalizeStructTag(type) === coinType
  ) {
    const splitResult = moveCall.arguments[0];
    if (splitResult?.$kind !== "NestedResult")
      throw new Error(`${what} does not consume a split coin`);
    const [splitIndex, outputIndex] = splitResult.NestedResult;
    const split = data.commands[splitIndex];
    if (split?.$kind !== "SplitCoins")
      throw new Error(`${what} does not consume a split coin`);
    const amount = split.SplitCoins.amounts[outputIndex];
    if (!amount) throw new Error(`${what} refers to a missing split amount`);
    return pureU64(data, amount, `${what} split amount`);
  }

  throw new Error(`${what} has an unexpected balance source`);
}

/** Confirm signed bytes encode only the exact payout requested by this run. */
function assertFundingTransaction(
  bytes: Uint8Array,
  intent: FundingIntent
): TransactionDataBuilder {
  const data = TransactionDataBuilder.fromBytes(bytes);
  if (!data.sender || normalizeSuiAddress(data.sender) !== intent.sender)
    throw new Error(
      "funding transaction sender does not match the journal intent"
    );
  if (
    !data.gasData.owner ||
    normalizeSuiAddress(data.gasData.owner) !== intent.sender
  ) {
    throw new Error("funding transaction gas owner does not match the sender");
  }
  if (BigInt(data.gasData.budget ?? 0) !== BigInt(intent.gasBudget))
    throw new Error(
      "funding transaction gas budget does not match the journal intent"
    );

  const allowedTypes = new Set([
    normalizeStructTag(SUI_TYPE),
    normalizeStructTag(intent.walType),
  ]);
  const actualPayments: Array<{
    address: string;
    coinType: string;
    amount: bigint;
  }> = [];
  const allowedMoveCalls = new Set([
    "balance::redeem_funds",
    "balance::send_funds",
    "coin::redeem_funds",
    "coin::into_balance",
    "coin::send_funds",
    "coin::destroy_zero",
  ]);

  data.commands.forEach((command, commandIndex) => {
    if (command.$kind === "MergeCoins" || command.$kind === "SplitCoins")
      return;
    if (command.$kind !== "MoveCall")
      throw new Error(
        `funding transaction contains unexpected ${command.$kind} command`
      );
    const call = command.MoveCall;
    const target = `${call.module}::${call.function}`;
    if (
      normalizeSuiAddress(call.package) !== SUI_FRAMEWORK ||
      !allowedMoveCalls.has(target) ||
      call.typeArguments.length !== 1
    ) {
      throw new Error(
        `funding transaction contains unexpected Move call ${target}`
      );
    }
    const coinType = normalizeStructTag(call.typeArguments[0]);
    if (!allowedTypes.has(coinType))
      throw new Error(
        `funding transaction uses unexpected coin type ${coinType}`
      );

    if (target === "coin::send_funds") {
      const recipient = pureAddress(
        data,
        call.arguments[1],
        `command ${commandIndex} remainder recipient`
      );
      if (recipient !== intent.sender)
        throw new Error(
          "funding transaction sends a coin remainder away from sender"
        );
      return;
    }
    if (target !== "balance::send_funds") return;
    if (call.arguments.length !== 2)
      throw new Error(
        `command ${commandIndex} send_funds has invalid arguments`
      );
    actualPayments.push({
      address: pureAddress(
        data,
        call.arguments[1],
        `command ${commandIndex} recipient`
      ),
      coinType,
      amount: outputAmount(
        data,
        call.arguments[0],
        coinType,
        `command ${commandIndex} payment`
      ),
    });
  });

  const expectedPayments = flattenWriters(intent.writers).flatMap((address) => [
    {
      address,
      coinType: normalizeStructTag(SUI_TYPE),
      amount: BigInt(intent.mistPerAddress),
    },
    {
      address,
      coinType: normalizeStructTag(intent.walType),
      amount: BigInt(intent.frostPerAddress),
    },
  ]);
  if (actualPayments.length !== expectedPayments.length)
    throw new Error(
      `funding transaction has ${actualPayments.length} payments; expected ${expectedPayments.length}`
    );
  actualPayments.forEach((actual, index) => {
    const expected = expectedPayments[index];
    if (
      actual.address !== expected.address ||
      actual.coinType !== expected.coinType ||
      actual.amount !== expected.amount
    ) {
      throw new Error(
        `funding transaction payment ${index} does not match intent`
      );
    }
  });
  return data;
}

function writeJournalAtomic(path: string, journal: FundingJournal): void {
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  let fileDescriptor: number | undefined;
  let temporaryExists = false;
  try {
    fileDescriptor = openSync(temporary, "wx", 0o600);
    temporaryExists = true;
    writeFileSync(
      fileDescriptor,
      `${JSON.stringify(journal, null, 2)}\n`,
      "utf8"
    );
    fsyncSync(fileDescriptor);
    closeSync(fileDescriptor);
    fileDescriptor = undefined;
    renameSync(temporary, path);
    temporaryExists = false;
    const directoryDescriptor = openSync(dirname(path), "r");
    try {
      fsyncSync(directoryDescriptor);
    } finally {
      closeSync(directoryDescriptor);
    }
  } finally {
    if (fileDescriptor !== undefined) closeSync(fileDescriptor);
    if (temporaryExists) unlinkSync(temporary);
  }
}

function sameJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

async function parseFundingJournal(
  raw: string,
  expectedIntent: FundingIntent
): Promise<{ journal: FundingJournal; bytes: Uint8Array }> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("FUNDING_JOURNAL_JSON is not valid JSON");
  }
  const root = requireRecord(parsed, "funding journal");
  if (
    root.schemaVersion !== FUNDING_JOURNAL_SCHEMA_VERSION ||
    root.kind !== "walrus-memory-funding"
  ) {
    throw new Error("funding journal has an unsupported schema or kind");
  }
  if (!["prepared", "succeeded", "failed"].includes(String(root.status)))
    throw new Error("funding journal is not a resumable signed transaction");

  const intentRaw = requireRecord(root.intent, "funding journal intent");
  const journalIntent = fundingIntent({
    network: requireString(
      intentRaw.network,
      "journal intent network"
    ) as Network,
    sender: requireString(intentRaw.sender, "journal intent sender"),
    walType: requireString(intentRaw.walType, "journal intent WAL type"),
    payoutManifest: requireString(
      intentRaw.payoutManifest,
      "journal intent payout manifest"
    ),
    writers: normalizeWriters(intentRaw.writers),
    mistPer: parseAmount(
      requireString(intentRaw.mistPerAddress, "journal MIST per address"),
      "journal MIST per address"
    ),
    frostPer: parseAmount(
      requireString(intentRaw.frostPerAddress, "journal FROST per address"),
      "journal FROST per address"
    ),
    gasBudget: parseAmount(
      requireString(intentRaw.gasBudget, "journal gas budget"),
      "journal gas budget"
    ),
  });
  if (
    journalIntent.network !== "mainnet" &&
    journalIntent.network !== "testnet"
  )
    throw new Error("funding journal network must be mainnet or testnet");
  if (!sameJson(journalIntent, expectedIntent))
    throw new Error("funding journal intent does not exactly match this run");

  if (!root.liveSnapshot)
    throw new Error("funding journal is missing its original live snapshot");
  const originalSnapshot = parseLiveWriterSnapshot(
    JSON.stringify(root.liveSnapshot),
    Date.now(),
    false
  );
  assertSnapshotMatchesWriters(expectedIntent.writers, originalSnapshot);

  const transaction = requireRecord(
    root.transaction,
    "funding journal transaction"
  );
  const bytes = canonicalBase64(
    transaction.transactionBytes,
    "journal transactionBytes"
  );
  const signature = requireString(
    transaction.signature,
    "journal transaction signature"
  );
  const digest = requireString(
    transaction.digest,
    "journal transaction digest"
  );
  const calculatedDigest = TransactionDataBuilder.getDigestFromBytes(bytes);
  if (digest !== calculatedDigest)
    throw new Error(
      `funding journal digest mismatch: expected ${digest}, got ${calculatedDigest}`
    );
  assertFundingTransaction(bytes, expectedIntent);
  await verifyTransactionSignature(bytes, signature, {
    address: expectedIntent.sender,
  });

  return {
    bytes,
    journal: {
      ...(root as FundingJournal),
      intent: journalIntent,
      liveSnapshot: originalSnapshot,
      transaction: {
        transactionBytes: Buffer.from(bytes).toString("base64"),
        signature,
        digest,
      },
    },
  };
}

function isTransactionNotFound(error: unknown, digest: string): boolean {
  const value = error as { code?: unknown; message?: unknown };
  return (
    value?.code === "NOT_FOUND" ||
    value?.code === 5 ||
    value?.message === `Transaction ${digest} not found`
  );
}

function transactionFromResult(result: any): any {
  return result?.Transaction || result?.FailedTransaction;
}

function jsonSafe(value: unknown): unknown {
  if (value === undefined) return undefined;
  return JSON.parse(
    JSON.stringify(value, (_, item) =>
      typeof item === "bigint" ? item.toString() : item
    )
  );
}

function recordObservedTransaction(
  journalPath: string,
  journal: FundingJournal,
  result: unknown,
  source: "query" | "submit"
): { journal: FundingJournal; transaction: any } {
  const transaction = transactionFromResult(result);
  const expectedDigest = journal.transaction!.digest;
  if (!transaction || transaction.digest !== expectedDigest)
    throw new Error(
      `funding response digest mismatch: expected ${expectedDigest}, got ${String(
        transaction?.digest
      )}`
    );
  if (typeof transaction.status?.success !== "boolean")
    throw new Error("funding response has no definitive execution status");
  const success = transaction.status.success;
  const observed: FundingJournal = {
    ...journal,
    status: success ? "succeeded" : "failed",
    updatedAt: new Date().toISOString(),
    execution: {
      observedAt: new Date().toISOString(),
      source,
      success,
      ...(success ? {} : { error: jsonSafe(transaction.status?.error) }),
    },
  };
  writeJournalAtomic(journalPath, observed);
  return { journal: observed, transaction };
}

async function reconcileAndExecuteFunding(
  client: SuiGrpcClient,
  journalPath: string,
  journal: FundingJournal,
  bytes: Uint8Array,
  beforeSubmit: () => void
): Promise<string> {
  const digest = journal.transaction!.digest;
  const include = { effects: true } as const;
  let existing: unknown;
  let confirmedNotFound = false;
  try {
    existing = await client.getTransaction({ digest, include });
  } catch (error: unknown) {
    if (!isTransactionNotFound(error, digest)) {
      throw new Error(
        `cannot reconcile funding digest ${digest}; do not create or submit a new payout. Retry with the same FUNDING_JOURNAL_JSON. Cause: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
    }
    confirmedNotFound = true;
  }

  if (existing !== undefined) {
    const observed = recordObservedTransaction(
      journalPath,
      journal,
      existing,
      "query"
    );
    requireSuccess(existing, "journaled funding transaction failed");
    return observed.transaction.digest;
  }
  if (!confirmedNotFound)
    throw new Error(
      `cannot reconcile funding digest ${digest}; the RPC returned no transaction and no explicit NOT_FOUND. Do not create or submit a new payout.`
    );
  if (journal.status !== "prepared")
    throw new Error(
      `journal says ${journal.status} but digest ${digest} is not on chain; refusing to replay`
    );
  // The lookup above can be slow or retried by the transport. Recheck at the
  // actual submission boundary so a snapshot cannot age past its 15-minute
  // limit while we are reconciling the digest.
  beforeSubmit();

  let result: unknown;
  try {
    result = await client.executeTransaction({
      transaction: bytes,
      signatures: [journal.transaction!.signature],
      include,
    });
  } catch (error: unknown) {
    throw new Error(
      `FUNDING OUTCOME AMBIGUOUS for digest ${digest}. Do not build or submit a new payout. Preserve ${journalPath} and retry with its exact contents in FUNDING_JOURNAL_JSON. Cause: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
  }

  let observed: ReturnType<typeof recordObservedTransaction>;
  try {
    observed = recordObservedTransaction(
      journalPath,
      journal,
      result,
      "submit"
    );
  } catch (error: unknown) {
    throw new Error(
      `FUNDING OUTCOME AMBIGUOUS for digest ${digest}. The RPC returned after submission but the durable result could not be recorded. Do not build or submit a new payout; reconcile this exact journal. Cause: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
  }
  requireSuccess(result, "journaled funding transaction failed");
  return observed.transaction.digest;
}

async function main() {
  if (process.argv.includes("--self-test")) return selfTest();

  // 1. parse env → strings (throws early if a required var is missing).
  const funderKeyStr = requireEnv("SUI_FUNDER_KEY");
  const grpcUrlStr = requireEnv("GRPC_URL");
  const mistStr = requireEnv("MIST_PER_ADDRESS");
  const frostStr = requireEnv("FROST_PER_ADDRESS");
  const networkStr = env("NETWORK", "mainnet")!;
  const gasBudgetStr = env("GAS_BUDGET", "5000000000")!;
  const dryRunStr = env("DRY_RUN", "true")!;
  const prepareOnlyStr = env("FUNDING_PREPARE_ONLY", "false")!;
  const journalPath = env("FUNDING_JOURNAL_OUT", "funding-journal.json")!;
  const resumeJournalRaw = env("FUNDING_JOURNAL_JSON");

  // 2. validate → fully-typed values.
  const mistPer = parseAmount(mistStr, "MIST_PER_ADDRESS");
  const frostPer = parseAmount(frostStr, "FROST_PER_ADDRESS");
  if (networkStr !== "mainnet" && networkStr !== "testnet")
    throw new Error(
      `NETWORK must be mainnet|testnet (walrus is not deployed elsewhere), got ${JSON.stringify(
        networkStr
      )}`
    );
  const network: Network = networkStr;
  const gasBudget = parseAmount(gasBudgetStr, "GAS_BUDGET");
  // Anything but an explicit "false" stays a dry run: a typo'd flag must never
  // be the reason real funds move.
  const dryRun = dryRunStr !== "false";
  if (prepareOnlyStr !== "true" && prepareOnlyStr !== "false")
    throw new Error("FUNDING_PREPARE_ONLY must be true or false");
  const prepareOnly = prepareOnlyStr === "true";
  if (dryRun && prepareOnly)
    throw new Error("FUNDING_PREPARE_ONLY=true requires DRY_RUN=false");
  if (resumeJournalRaw && dryRun)
    throw new Error("FUNDING_JOURNAL_JSON requires DRY_RUN=false");
  // The file is chosen by NETWORK, so a mainnet run can never read the testnet
  // list (or the reverse) no matter what is checked in.
  const payoutFile = recipientsFile(network);
  const writers = parseWriters(
    readFileSync(payoutFile, "utf8"),
    `${network} payout manifest`
  );
  const recipients = flattenWriters(writers);
  const liveWriters = env("LIVE_WRITER_ADDRESSES_JSON");
  let liveSnapshot: LiveWriterSnapshot | undefined;
  if (liveWriters) liveSnapshot = reconcileLiveWriters(writers, liveWriters);
  else if (!dryRun)
    throw new Error("missing required env var LIVE_WRITER_ADDRESSES_JSON");

  // Ed25519 only — the funder key is one we generate for this job, so there is
  // no reason for it to be secp256k1/r1.
  const signer = Ed25519Keypair.fromSecretKey(funderKeyStr);
  const sender = normalizeSuiAddress(signer.getPublicKey().toSuiAddress());

  // 3. logic.
  const client = new SuiGrpcClient({ network, baseUrl: grpcUrlStr });
  const walType = await walTypeForNetwork(client, network);
  const payoutManifest = payoutFile.pathname.split("/").pop()!;
  const intent = fundingIntent({
    network,
    sender,
    walType,
    payoutManifest,
    writers,
    mistPer,
    frostPer,
    gasBudget,
  });

  console.error(`sender:     ${sender} (${network})`);
  console.error(`wal type:   ${walType}`);
  console.error(`payout list:${payoutManifest}`);
  console.error(`recipients: ${recipients.length}`);

  if (resumeJournalRaw) {
    const prepared = await parseFundingJournal(resumeJournalRaw, intent);
    liveSnapshot = reconcileLiveWriters(writers, liveWriters!);
    // Persist the supplied recovery record locally before any chain query or
    // replay, so the workflow always has a current artifact to upload.
    const reconciledJournal: FundingJournal = {
      ...prepared.journal,
      updatedAt: new Date().toISOString(),
      liveSnapshot: liveSnapshot!,
    };
    writeJournalAtomic(journalPath, reconciledJournal);
    if (prepareOnly) {
      console.error(
        `journal ${
          reconciledJournal.transaction!.digest
        } validated and persisted; submission intentionally deferred`
      );
      process.stdout.write(`${reconciledJournal.transaction!.digest}\n`);
      return;
    }
    const digest = await reconcileAndExecuteFunding(
      client,
      journalPath,
      reconciledJournal,
      prepared.bytes,
      () => {
        reconcileLiveWriters(writers, liveWriters!);
      }
    );
    console.error(
      `funding digest ${digest} reconciled from the supplied journal`
    );
    process.stdout.write(`${digest}\n`);
    return;
  }

  // Check the funds BEFORE building: a sender that cannot cover the payout
  // should fail here, naming the shortfall, rather than as an opaque abort
  // partway through execution.
  const suiNeeded = mistPer * BigInt(recipients.length) + gasBudget;
  const frostNeeded = frostPer * BigInt(recipients.length);

  const [sui, wal] = await Promise.all([
    client.core.getBalance({ owner: sender, coinType: SUI_TYPE }),
    client.core.getBalance({ owner: sender, coinType: walType }),
  ]);
  const suiHave = BigInt(sui.balance.balance);
  const walHave = BigInt(wal.balance.balance);

  console.error(
    `SUI:        need ${suiNeeded} MIST (incl. ${gasBudget} gas), have ${suiHave}`
  );
  console.error(`WAL:        need ${frostNeeded} FROST, have ${walHave}`);

  requireFunds("SUI (MIST, incl. gas budget)", suiHave, suiNeeded);
  requireFunds("WAL (FROST)", walHave, frostNeeded);

  const tx = new Transaction();
  tx.setSender(sender);
  tx.setGasBudget(gasBudget);

  // Pay into each recipient's ADDRESS BALANCE, not as owned Coin objects: the
  // upload writers prepare address-balance-funded transactions and registration
  // fails closed before submission if either currency would fall back to an
  // owned coin (see the migrator README, "Recipe for a big run"). Coin objects
  // would leave every wallet funded on paper and unable to register a blob.
  //
  // tx.balance() is the SDK's Balance<T> intent: it sources from the sender's
  // own address balance when available and falls back to owned coins, so the
  // funder works either way. build() batches the intents into one merge + one
  // split per type; balance::send_funds then credits the recipient.
  for (const addr of recipients) {
    tx.moveCall({
      target: "0x2::balance::send_funds",
      typeArguments: [SUI_TYPE],
      arguments: [tx.balance({ balance: mistPer }), tx.pure.address(addr)],
    });
    tx.moveCall({
      target: "0x2::balance::send_funds",
      typeArguments: [walType],
      arguments: [
        tx.balance({ type: walType, balance: frostPer }),
        tx.pure.address(addr),
      ],
    });
  }

  const transactionBytes = await tx.build({ client });
  const sim = await client.simulateTransaction({
    transaction: transactionBytes,
    include: { effects: true },
  });
  requireSuccess(sim, "funding simulation failed");

  if (dryRun) {
    const now = new Date().toISOString();
    writeJournalAtomic(journalPath, {
      schemaVersion: FUNDING_JOURNAL_SCHEMA_VERSION,
      kind: "walrus-memory-funding",
      status: "simulated",
      createdAt: now,
      updatedAt: now,
      intent,
      ...(liveSnapshot ? { liveSnapshot } : {}),
    });
    console.error(
      `dry run OK — ${recipients.length} wallets would be funded. Set DRY_RUN=false to send.`
    );
    return;
  }

  // Network discovery and simulation can take time. Re-check the same signed
  // collector snapshot at the point of no return, not only during startup.
  liveSnapshot = reconcileLiveWriters(writers, liveWriters!);
  const signed = await signer.signTransaction(transactionBytes);
  const digest = TransactionDataBuilder.getDigestFromBytes(transactionBytes);
  assertFundingTransaction(transactionBytes, intent);
  await verifyTransactionSignature(transactionBytes, signed.signature, {
    address: sender,
  });
  const now = new Date().toISOString();
  const journal: FundingJournal = {
    schemaVersion: FUNDING_JOURNAL_SCHEMA_VERSION,
    kind: "walrus-memory-funding",
    status: "prepared",
    createdAt: now,
    updatedAt: now,
    intent,
    liveSnapshot: liveSnapshot!,
    transaction: {
      transactionBytes: Buffer.from(transactionBytes).toString("base64"),
      signature: signed.signature,
      digest,
    },
  };

  // This fsync + atomic rename is the point of no return: execution is never
  // attempted unless the exact signed bytes are already durable.
  writeJournalAtomic(journalPath, journal);
  if (prepareOnly) {
    console.error(
      `prepared ${recipients.length}-wallet funding transaction ${digest}; submission intentionally deferred`
    );
    process.stdout.write(`${digest}\n`);
    return;
  }
  const executedDigest = await reconcileAndExecuteFunding(
    client,
    journalPath,
    journal,
    transactionBytes,
    () => {
      reconcileLiveWriters(writers, liveWriters!);
    }
  );
  console.error(
    `funded ${recipients.length} wallets · digest ${executedDigest}`
  );
  process.stdout.write(`${executedDigest}\n`);
}

async function selfTest() {
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
  const threwAsync = async (fn: () => Promise<unknown>) => {
    try {
      await fn();
      return false;
    } catch {
      return true;
    }
  };
  const A = "0x" + "1".repeat(64);
  const B = "0x" + "2".repeat(64);
  const C = "0x" + "3".repeat(64);
  const D = "0x" + "ab".repeat(32);
  const NOW = Date.parse("2026-07-22T12:00:00.000Z");

  const snapshotFor = (
    writerAddresses: WriterAddresses,
    overrides: Record<string, unknown> = {}
  ): LiveWriterSnapshot => {
    const ids = Object.keys(writerAddresses);
    return {
      schemaVersion: 1,
      collectedAt: new Date(NOW).toISOString(),
      context: "gke_project_region_cluster",
      namespace: "walrus-memory-migration-testnet",
      statefulSet: {
        name: "writer",
        uid: "47c2d958-9d4d-44af-8d04-c893694a819c",
        generation: 7,
        revision: "writer-7f5ddf6dc9",
        replicas: ids.length,
        currentReplicas: ids.length,
        updatedReplicas: ids.length,
        readyReplicas: ids.length,
      },
      writerSecrets: [
        {
          name: "writer-wallets",
          uid: "409fcf31-67e4-49cc-b3d9-b84fa4dc558d",
          resourceVersion: "12345",
          immutable: true,
        },
      ],
      writerSecretProviders: [
        {
          container: "migrator",
          secretName: "writer-wallets",
          key: "SERVER_SUI_PRIVATE_KEYS",
          source: "envFrom",
        },
      ],
      writers: ids.map((id, ordinal) => ({
        id,
        ordinal,
        podUid: `pod-uid-${ordinal}`,
        revision: "writer-7f5ddf6dc9",
        images: [
          {
            name: "migrator",
            image: "registry/migrator:sha",
            imageId: "registry/migrator@sha256:abc",
          },
        ],
        addresses: writerAddresses[id],
      })),
      ...overrides,
    };
  };

  // The real lists are the thing being paid — check them, not just a fixture.
  for (const network of ["mainnet", "testnet"] as Network[]) {
    const file = recipientsFile(network);
    const real = flattenWriters(JSON.parse(readFileSync(file, "utf8")));
    assert(real.length > 0, `distribute-funds.${network}.json is non-empty`);
    assert(
      real.length === new Set(real).size,
      `no duplicate address in distribute-funds.${network}.json`
    );
  }
  // The two networks must not share a wallet: paying testnet from the mainnet
  // run (or the reverse) would be silent.
  const mainnetAddrs = flattenWriters(
    JSON.parse(readFileSync(recipientsFile("mainnet"), "utf8"))
  );
  const testnetAddrs = flattenWriters(
    JSON.parse(readFileSync(recipientsFile("testnet"), "utf8"))
  );
  assert(
    !mainnetAddrs.some((a) => testnetAddrs.includes(a)),
    "mainnet and testnet payout lists are disjoint"
  );

  assert(
    threw(() => flattenWriters([A, B])),
    "flat payout manifest rejected"
  );
  assert(
    threw(() => flattenWriters([])),
    "empty flat array rejected"
  );
  assert(
    threw(() => flattenWriters("0x1")),
    "non-array/object manifest rejected"
  );
  assert(
    flattenWriters({ "writer-0": [A], "writer-1": [B] }).length === 2,
    "writers flattened"
  );
  assert(
    flattenWriters({ "writer-0": [D.toUpperCase().replace("0X", "0x")] })[0] ===
      D,
    "addresses normalized"
  );
  assert(
    threw(() =>
      flattenWriters({
        "writer-0": [D],
        "writer-1": [D.toUpperCase().replace("0X", "0x")],
      })
    ),
    "normalized cross-writer duplicate rejected"
  );
  assert(
    threw(() => flattenWriters({ "writer-0": [A, A] })),
    "in-writer duplicate rejected"
  );
  assert(
    threw(() => flattenWriters({ "writer-0": [] })),
    "empty writer rejected"
  );
  assert(
    threw(() => flattenWriters({})),
    "no writers rejected"
  );
  assert(
    threw(() => flattenWriters({ "writer-0": ["0x123"] })),
    "bad address rejected"
  );
  const many = {
    "writer-0": Array.from(
      { length: MAX_RECIPIENTS + 1 },
      (_, i) => "0x" + i.toString(16).padStart(64, "0")
    ),
  };
  assert(
    threw(() => flattenWriters(many)),
    `over ${MAX_RECIPIENTS} rejected`
  );

  const expected = { "writer-0": [A], "writer-1": [B, C] };
  reconcileLiveWriters(expected, JSON.stringify(snapshotFor(expected)), NOW);
  assert(
    threw(() =>
      reconcileLiveWriters(
        expected,
        JSON.stringify(snapshotFor({ "writer-0": [A] })),
        NOW
      )
    ),
    "missing writer rejected"
  );
  assert(
    threw(() =>
      reconcileLiveWriters(
        expected,
        JSON.stringify(snapshotFor({ ...expected, "writer-2": [D] })),
        NOW
      )
    ),
    "unexpected writer rejected"
  );
  assert(
    threw(() =>
      reconcileLiveWriters(
        expected,
        JSON.stringify(snapshotFor({ ...expected, "writer-0": [D] })),
        NOW
      )
    ),
    "changed wallet rejected"
  );
  assert(
    threw(() =>
      reconcileLiveWriters(
        expected,
        JSON.stringify(snapshotFor({ ...expected, "writer-1": [C, B] })),
        NOW
      )
    ),
    "reordered wallets rejected"
  );
  assert(
    threw(() =>
      reconcileLiveWriters(
        expected,
        JSON.stringify(
          snapshotFor(expected, {
            collectedAt: new Date(
              NOW - LIVE_SNAPSHOT_MAX_AGE_MS - 1
            ).toISOString(),
          })
        ),
        NOW
      )
    ),
    "stale live snapshot rejected"
  );
  assert(
    threw(() =>
      reconcileLiveWriters(
        expected,
        JSON.stringify(
          snapshotFor(expected, {
            collectedAt: new Date(
              NOW + LIVE_SNAPSHOT_FUTURE_SKEW_MS + 1
            ).toISOString(),
          })
        ),
        NOW
      )
    ),
    "future live snapshot rejected"
  );
  const wrongRevision = snapshotFor(expected);
  wrongRevision.writers[1].revision = "writer-old";
  assert(
    threw(() =>
      reconcileLiveWriters(expected, JSON.stringify(wrongRevision), NOW)
    ),
    "mixed StatefulSet revisions rejected"
  );
  const incompleteRollout = snapshotFor(expected);
  incompleteRollout.statefulSet.updatedReplicas -= 1;
  assert(
    threw(() =>
      reconcileLiveWriters(expected, JSON.stringify(incompleteRollout), NOW)
    ),
    "incomplete StatefulSet rollout rejected"
  );
  const mutableSecret = snapshotFor(expected) as any;
  mutableSecret.writerSecrets[0].immutable = false;
  assert(
    threw(() =>
      reconcileLiveWriters(expected, JSON.stringify(mutableSecret), NOW)
    ),
    "mutable writer Secret rejected"
  );
  const missingProvider = snapshotFor(expected) as any;
  missingProvider.writerSecretProviders = [];
  assert(
    threw(() =>
      reconcileLiveWriters(expected, JSON.stringify(missingProvider), NOW)
    ),
    "missing writer Secret provider rejected"
  );
  const wrongProviderKey = snapshotFor(expected) as any;
  wrongProviderKey.writerSecretProviders[0].key = "UNRELATED_KEY";
  assert(
    threw(() =>
      reconcileLiveWriters(expected, JSON.stringify(wrongProviderKey), NOW)
    ),
    "wrong writer Secret key rejected"
  );
  const missingImageId = snapshotFor(expected);
  missingImageId.writers[0].images[0].imageId = "";
  assert(
    threw(() =>
      reconcileLiveWriters(expected, JSON.stringify(missingImageId), NOW)
    ),
    "missing container image ID rejected"
  );
  const mixedImageIds = snapshotFor(expected);
  mixedImageIds.writers[1].images[0].imageId =
    "registry/migrator@sha256:different";
  assert(
    threw(() =>
      reconcileLiveWriters(expected, JSON.stringify(mixedImageIds), NOW)
    ),
    "mixed writer image IDs rejected"
  );
  const wrongWriterOrder = snapshotFor(expected);
  wrongWriterOrder.writers.reverse();
  assert(
    threw(() =>
      reconcileLiveWriters(expected, JSON.stringify(wrongWriterOrder), NOW)
    ),
    "writer ordinal order rejected"
  );

  assert(parseAmount("10", "x") === 10n, "amount parsed");
  assert(
    threw(() => parseAmount("0", "x")),
    "zero amount rejected"
  );
  assert(
    threw(() => parseAmount("-1", "x")),
    "negative amount rejected"
  );
  assert(
    threw(() => parseAmount("1.5", "x")),
    "fractional amount rejected"
  );
  assert(
    threw(() => parseAmount("1e9", "x")),
    "exponent amount rejected"
  );

  requireFunds("SUI", 10n, 10n);
  assert(
    threw(() => requireFunds("SUI", 9n, 10n)),
    "shortfall rejected"
  );
  // Enough for the payout but not the gas on top must still be rejected.
  assert(
    threw(() => requireFunds("SUI", 2n * 5n, 2n * 5n + 1n)),
    "payout without gas headroom rejected"
  );

  assert(
    requireSuccess(
      { Transaction: { status: { success: true }, digest: "d" } },
      "x"
    ).digest === "d",
    "success unwrapped"
  );
  assert(
    threw(() =>
      requireSuccess(
        { FailedTransaction: { status: { success: false, error: "boom" } } },
        "x"
      )
    ),
    "failed tx rejected"
  );
  assert(
    threw(() => requireSuccess({}, "x")),
    "empty response rejected"
  );

  const signer = Ed25519Keypair.generate();
  const sender = signer.toSuiAddress();
  const walType = `${"0x" + "b".repeat(64)}::wal::WAL`;
  const journalWriters = { "writer-0": [A] };
  const intent = fundingIntent({
    network: "testnet",
    sender,
    walType,
    payoutManifest: "distribute-funds.testnet.json",
    writers: journalWriters,
    mistPer: 10n,
    frostPer: 20n,
    gasBudget: 1_000n,
  });
  const addressInput = (address: string) => ({
    $kind: "Pure",
    Pure: {
      bytes: Buffer.from(normalizeSuiAddress(address).slice(2), "hex").toString(
        "base64"
      ),
    },
  });
  const withdrawalInput = (coinType: string, amount: bigint) => ({
    $kind: "FundsWithdrawal",
    FundsWithdrawal: {
      reservation: {
        $kind: "MaxAmountU64",
        MaxAmountU64: amount.toString(),
      },
      typeArg: { $kind: "Balance", Balance: coinType },
      withdrawFrom: { $kind: "Sender", Sender: true },
    },
  });
  const fixtureData = new TransactionDataBuilder({
    version: 2,
    sender,
    expiration: null,
    gasData: {
      budget: intent.gasBudget,
      price: "1",
      owner: sender,
      payment: [
        {
          objectId: "0x" + "4".repeat(64),
          version: "1",
          digest: "11111111111111111111111111111111",
        },
      ],
    },
    inputs: [
      withdrawalInput(SUI_TYPE, 10n),
      addressInput(A),
      withdrawalInput(walType, 20n),
      addressInput(A),
    ],
    commands: [
      {
        $kind: "MoveCall",
        MoveCall: {
          package: "0x2",
          module: "balance",
          function: "redeem_funds",
          typeArguments: [SUI_TYPE],
          arguments: [{ $kind: "Input", Input: 0, type: "withdrawal" }],
        },
      },
      {
        $kind: "MoveCall",
        MoveCall: {
          package: "0x2",
          module: "balance",
          function: "send_funds",
          typeArguments: [SUI_TYPE],
          arguments: [
            { $kind: "NestedResult", NestedResult: [0, 0] },
            { $kind: "Input", Input: 1, type: "pure" },
          ],
        },
      },
      {
        $kind: "MoveCall",
        MoveCall: {
          package: "0x2",
          module: "balance",
          function: "redeem_funds",
          typeArguments: [walType],
          arguments: [{ $kind: "Input", Input: 2, type: "withdrawal" }],
        },
      },
      {
        $kind: "MoveCall",
        MoveCall: {
          package: "0x2",
          module: "balance",
          function: "send_funds",
          typeArguments: [walType],
          arguments: [
            { $kind: "NestedResult", NestedResult: [2, 0] },
            { $kind: "Input", Input: 3, type: "pure" },
          ],
        },
      },
    ],
  } as any);
  const transactionBytes = fixtureData.build();
  const signed = await signer.signTransaction(transactionBytes);
  const journal: FundingJournal = {
    schemaVersion: 1,
    kind: "walrus-memory-funding",
    status: "prepared",
    createdAt: new Date(NOW).toISOString(),
    updatedAt: new Date(NOW).toISOString(),
    intent,
    liveSnapshot: snapshotFor(journalWriters),
    transaction: {
      transactionBytes: signed.bytes,
      signature: signed.signature,
      digest: TransactionDataBuilder.getDigestFromBytes(transactionBytes),
    },
  };
  const validated = await parseFundingJournal(JSON.stringify(journal), intent);
  assert(
    validated.journal.transaction?.digest === journal.transaction?.digest,
    "signed journal validated"
  );
  assert(
    await threwAsync(() =>
      parseFundingJournal(
        JSON.stringify({
          ...journal,
          transaction: { ...journal.transaction, digest: "wrong" },
        }),
        intent
      )
    ),
    "journal digest tampering rejected"
  );
  assert(
    await threwAsync(() =>
      parseFundingJournal(JSON.stringify(journal), {
        ...intent,
        mistPerAddress: "11",
      })
    ),
    "journal intent mismatch rejected"
  );
  assert(
    isTransactionNotFound(
      { message: `Transaction ${journal.transaction!.digest} not found` },
      journal.transaction!.digest
    ),
    "authoritative not-found recognized"
  );
  assert(
    !isTransactionNotFound(
      { message: "connection reset" },
      journal.transaction!.digest
    ),
    "transport failure is not treated as not-found"
  );
  let submittedAfterUndefinedLookup = false;
  assert(
    await threwAsync(() =>
      reconcileAndExecuteFunding(
        {
          getTransaction: async () => undefined,
          executeTransaction: async () => {
            submittedAfterUndefinedLookup = true;
          },
        } as any,
        "/unused/funding-journal.json",
        journal,
        transactionBytes,
        () => undefined
      )
    ),
    "undefined transaction lookup rejected"
  );
  assert(
    !submittedAfterUndefinedLookup,
    "undefined transaction lookup is never submitted"
  );
  console.log("self-test OK");
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
