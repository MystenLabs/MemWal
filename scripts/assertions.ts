/**
 * Shared env, chain, and object-type assertions for the build-*-tx.ts builders.
 *
 * Every builder reads the same env vars and drops the object ids straight into a
 * moveCall. Nothing there notices if REGISTRY_ID and ADMIN_CAP_ID are swapped, or
 * if a cap left over from an earlier publish is pasted in — the tx builds fine and
 * only aborts once signed and submitted. `assertObjectTypes` reads each object's
 * real type first, so a wrong id fails at build time instead.
 */

import type { SuiGrpcClient } from "@mysten/sui/grpc";
import {
  isValidSuiAddress,
  isValidSuiObjectId,
  normalizeStructTag,
  normalizeSuiAddress,
} from "@mysten/sui/utils";

export type GovernanceNetwork = "mainnet" | "testnet";

export const GOVERNANCE_CHAIN_IDENTIFIERS: Record<GovernanceNetwork, string> = {
  mainnet: "4btiuiMPvEENsttpZC7CZ53DruC3MAgfznDbASZ7DR6S",
  testnet: "69WiPg3DAQiwdxfncX6wYQ2siKwAe6L9BZthQea3JNMD",
};

export function env(name: string, fallback?: string): string | undefined {
  const v = process.env[name]?.trim();
  return v && v.length > 0 ? v : fallback;
}

export function requireEnv(name: string): string {
  const v = env(name);
  if (!v) throw new Error(`missing required env var ${name}`);
  return v;
}

export function governanceNetwork(
  value: string,
  label = "NETWORK"
): GovernanceNetwork {
  if (value !== "mainnet" && value !== "testnet")
    throw new Error(
      `${label} must be mainnet|testnet, got ${JSON.stringify(value)}`
    );
  return value;
}

/** Fail closed when a labelled network is wired to the other chain's endpoint. */
export function assertChainIdentifier(
  network: GovernanceNetwork,
  observed: string
): void {
  const expected = GOVERNANCE_CHAIN_IDENTIFIERS[network];
  if (observed !== expected)
    throw new Error(
      `GRPC_URL chain identifier ${JSON.stringify(
        observed
      )} does not match ${network} (${expected})`
    );
}

export function assertAddress(v: string, what: string): string {
  if (!isValidSuiAddress(v))
    throw new Error(`${what} is not a valid Sui address: ${JSON.stringify(v)}`);
  return normalizeSuiAddress(v);
}

export function assertObjectId(v: string, what: string): string {
  if (!isValidSuiObjectId(v))
    throw new Error(
      `${what} is not a valid Sui object id: ${JSON.stringify(v)}`
    );
  return normalizeSuiAddress(v);
}

/**
 * `<packageId>::account::<structName>`, normalized — getObject() normalizes the
 * type it returns, so normalize this side too or a short PACKAGE_ID (0x2) won't
 * compare equal to the padded type it comes back as (0x000..2).
 */
export function accountType(packageId: string, structName: string): string {
  return normalizeStructTag(`${packageId}::account::${structName}`);
}

/**
 * Assert each object really is the `account` struct it is meant to be, so a
 * swapped ADMIN_CAP_ID/REGISTRY_ID — or an AdminCap left over from an earlier
 * publish — fails here rather than after the tx is signed and submitted.
 *
 * ponytail: compares against PACKAGE_ID. A Move type keeps the ORIGINAL
 * (first-publish) package id across upgrades, while PACKAGE_ID has to stay the
 * LATEST id — that's what the moveCall targets. The two are the same today (the
 * package is a fresh publish at package version 1), so one env var covers both.
 * They diverge at the first upgrade and this starts false-failing. The fix then
 * is a second env var — ORIGINAL_PACKAGE_ID for this check, PACKAGE_ID stays the
 * moveCall target — not passing the original id as PACKAGE_ID, which would send
 * every call to the superseded package.
 */
export async function assertObjectTypes(
  client: SuiGrpcClient,
  packageId: string,
  expected: { id: string; struct: string; what: string }[]
): Promise<void> {
  const { objects } = await client.getObjects({
    objectIds: expected.map((e) => e.id),
  });
  objects.forEach((object, i) => {
    const { id, struct, what } = expected[i];
    // getObjects reports a per-id failure in place rather than throwing.
    if (object instanceof Error)
      throw new Error(`${what} ${id}: cannot read object — ${object.message}`);
    const want = accountType(packageId, struct);
    if (object.type !== want)
      throw new Error(
        `${what} ${id} is ${object.type}, expected ${want}. If ${packageId} is an upgraded ` +
          `package, this check needs updating rather than PACKAGE_ID: Move types keep the ` +
          `original (first-publish) package id, so these scripts need a separate ` +
          `ORIGINAL_PACKAGE_ID to compare types against, while PACKAGE_ID stays the ` +
          `upgraded id the moveCall targets.`
      );
  });
}
