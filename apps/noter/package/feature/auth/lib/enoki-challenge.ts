import "server-only";

import { SuiGraphQLClient } from "@mysten/sui/graphql";
import { normalizeSuiAddress } from "@mysten/sui/utils";
import { verifyPersonalMessageSignature } from "@mysten/sui/verify";
import {
  requireSharedRedisClient,
  SharedRedisUnavailableError,
} from "@/shared/lib/shared-redis";

// Server-issued, single-use ownership challenge for the Enoki zkLogin flow.
//
// The Enoki wallet only surfaces a Sui address to app code (no id_token), so we
// prove control by having the client sign a server-issued challenge with its
// zkLogin key and verifying the signature server-side against that address.
//
// Adaptation note: noter's auth is tRPC over an x-session-id header (no cookie
// plumbing), so the challenge is returned to the caller as an opaque token (the
// nonce) instead of an httpOnly cookie. Single-use / replay safety comes from
// Redis: the challenge is stored under the nonce with SET NX EX at issue time
// and removed with an atomic GETDEL at verify time, so at most one caller can
// consume any given challenge.

const CHALLENGE_TTL_SECONDS = 5 * 60;
const CHALLENGE_REDIS_PREFIX = "enoki-auth:challenge:";
const MAX_SIGNATURE_LENGTH = 8192;

// A challenge is scoped to the action it authorizes. The purpose is baked into
// both the human-readable message the user signs AND the stored record, and
// verification requires an exact match — so a signature obtained for sign-in can
// never be replayed against the delegate-key export path, and vice versa.
export type ChallengePurpose = "signin" | "export";

const PURPOSE_PROMPT: Record<ChallengePurpose, string> = {
  signin: "Sign in to Walrus Memory Noter",
  export: "Export your Walrus Memory Noter delegate key",
};

type SuiNetwork = "mainnet" | "testnet";

function getNetwork(): SuiNetwork {
  return process.env.NEXT_PUBLIC_SUI_NETWORK === "mainnet"
    ? "mainnet"
    : "testnet";
}

function getGraphQLClient(): SuiGraphQLClient {
  const network = getNetwork();
  const url =
    process.env.SUI_GRAPHQL_URL || `https://graphql.${network}.sui.io/graphql`;
  return new SuiGraphQLClient({ network, url });
}

export type EnokiChallenge = {
  /** Opaque token the client must return alongside the signature. */
  challengeId: string;
  /** The exact message the client must sign. */
  message: string;
};

/**
 * Issue a single-use ownership challenge for `rawAddress`, scoped to `purpose`.
 * Returns the message to sign and an opaque challengeId. Throws
 * SharedRedisUnavailableError if the challenge store is unreachable (fail-closed).
 */
export async function issueEnokiChallenge(
  rawAddress: string,
  purpose: ChallengePurpose
): Promise<EnokiChallenge> {
  const address = normalizeSuiAddress(rawAddress);
  const nonce = crypto.randomUUID();
  const issuedAt = new Date().toISOString();
  const message = [
    PURPOSE_PROMPT[purpose],
    `Address: ${address}`,
    `Nonce: ${nonce}`,
    `Issued at: ${issuedAt}`,
  ].join("\n");

  const redis = await requireSharedRedisClient();
  const result = await redis.set(
    `${CHALLENGE_REDIS_PREFIX}${nonce}`,
    JSON.stringify({ address, message, purpose }),
    { EX: CHALLENGE_TTL_SECONDS, NX: true }
  );
  if (result !== "OK") {
    // Nonce collision (astronomically unlikely) or store failure — fail closed.
    throw new SharedRedisUnavailableError();
  }

  return { challengeId: nonce, message };
}

/**
 * Verify that `signature` is a valid signature over the challenge identified by
 * `challengeId`, produced by the holder of `rawAddress`. Consumes the challenge
 * atomically so it can be used at most once (replay-safe). Returns true only
 * when everything checks out.
 *
 * Throws SharedRedisUnavailableError if the store is unreachable (fail-closed);
 * all other failures return false.
 */
export async function verifyAndConsumeEnokiChallenge({
  rawAddress,
  challengeId,
  signature,
  purpose,
}: {
  rawAddress: string;
  challengeId: string;
  signature: string;
  purpose: ChallengePurpose;
}): Promise<boolean> {
  if (
    typeof challengeId !== "string" ||
    challengeId.length === 0 ||
    typeof signature !== "string" ||
    signature.length === 0 ||
    signature.length > MAX_SIGNATURE_LENGTH
  ) {
    return false;
  }

  let address: string;
  try {
    address = normalizeSuiAddress(rawAddress);
  } catch {
    return false;
  }

  // GETDEL is atomic: at most one of any parallel replay attempts can obtain the
  // challenge and proceed to (expensive) signature verification.
  let stored: string | null;
  try {
    const redis = await requireSharedRedisClient();
    stored = await redis.getDel(`${CHALLENGE_REDIS_PREFIX}${challengeId}`);
  } catch {
    throw new SharedRedisUnavailableError();
  }
  if (!stored) {
    return false;
  }

  let issued: { address?: unknown; message?: unknown; purpose?: unknown };
  try {
    issued = JSON.parse(stored);
  } catch {
    return false;
  }
  if (
    typeof issued.message !== "string" ||
    issued.address !== address ||
    issued.purpose !== purpose
  ) {
    // A challenge issued for a different action (e.g. sign-in) must not satisfy
    // a verify for another action (e.g. export).
    return false;
  }

  try {
    // For a zkLogin signature this validates the proof against the JWKS/epoch
    // via the client, and returns the recovered signer; we require it to match
    // the claimed address.
    const publicKey = await verifyPersonalMessageSignature(
      new TextEncoder().encode(issued.message),
      signature,
      { address, client: getGraphQLClient() }
    );
    return publicKey.toSuiAddress() === address;
  } catch {
    return false;
  }
}
