import "server-only";

import { SuiGraphQLClient } from "@mysten/sui/graphql";
import { normalizeSuiAddress } from "@mysten/sui/utils";
import { verifyPersonalMessageSignature } from "@mysten/sui/verify";
import { jwtVerify, SignJWT } from "jose";
import { cookies } from "next/headers";
import {
  requireSharedRedisClient,
  SharedRedisUnavailableError,
} from "@/lib/shared-redis";

const CHALLENGE_COOKIE = "enoki-auth-challenge";
const CHALLENGE_TTL_SECONDS = 5 * 60;
const CHALLENGE_REDIS_PREFIX = "enoki-auth:challenge:";

type SuiNetwork = "mainnet" | "testnet";

function getSecret(): Uint8Array {
  const value = process.env.AUTH_SECRET;
  if (!value || value.length < 32) {
    throw new Error("AUTH_SECRET must contain at least 32 characters");
  }
  return new TextEncoder().encode(value);
}

function getNetwork(): SuiNetwork {
  return process.env.NEXT_PUBLIC_SUI_NETWORK === "mainnet"
    ? "mainnet"
    : "testnet";
}

function getGraphQLClient(): SuiGraphQLClient {
  const network = getNetwork();
  const url =
    process.env.SUI_GRAPHQL_URL ||
    `https://graphql.${network}.sui.io/graphql`;
  return new SuiGraphQLClient({ network, url });
}

export async function issueEnokiChallenge(rawAddress: string): Promise<string> {
  const address = normalizeSuiAddress(rawAddress);
  const nonce = crypto.randomUUID();
  const issuedAt = new Date().toISOString();
  const message = [
    "Sign in to Walrus Memory Researcher",
    `Address: ${address}`,
    `Nonce: ${nonce}`,
    `Issued at: ${issuedAt}`,
  ].join("\n");

  const token = await new SignJWT({ address, message })
    .setProtectedHeader({ alg: "HS256" })
    .setAudience("enoki-auth")
    .setIssuer("walrus-memory-researcher")
    .setJti(nonce)
    .setIssuedAt()
    .setExpirationTime(`${CHALLENGE_TTL_SECONDS}s`)
    .sign(getSecret());

  try {
    const redis = await requireSharedRedisClient();
    const result = await redis.set(
      `${CHALLENGE_REDIS_PREFIX}${nonce}`,
      JSON.stringify({ address, message }),
      { EX: CHALLENGE_TTL_SECONDS, NX: true },
    );
    if (result !== "OK") {
      throw new SharedRedisUnavailableError();
    }
  } catch (error) {
    if (error instanceof SharedRedisUnavailableError) {
      throw error;
    }
    throw new SharedRedisUnavailableError();
  }

  const cookieStore = await cookies();
  cookieStore.set(CHALLENGE_COOKIE, token, {
    httpOnly: true,
    maxAge: CHALLENGE_TTL_SECONDS,
    path: "/api/auth/enoki",
    sameSite: "strict",
    secure: process.env.NODE_ENV === "production",
  });

  return message;
}

export async function verifyAndConsumeEnokiChallenge({
  rawAddress,
  signature,
}: {
  rawAddress: string;
  signature: string;
}): Promise<boolean> {
  const cookieStore = await cookies();
  const token = cookieStore.get(CHALLENGE_COOKIE)?.value;

  // Consume before verification so a failed or successful attempt cannot be replayed.
  cookieStore.set(CHALLENGE_COOKIE, "", {
    httpOnly: true,
    maxAge: 0,
    path: "/api/auth/enoki",
    sameSite: "strict",
    secure: process.env.NODE_ENV === "production",
  });
  if (!token) {
    return false;
  }

  try {
    const address = normalizeSuiAddress(rawAddress);
    const { payload } = await jwtVerify(token, getSecret(), {
      algorithms: ["HS256"],
      audience: "enoki-auth",
      issuer: "walrus-memory-researcher",
    });
    if (
      payload.address !== address ||
      typeof payload.message !== "string" ||
      typeof payload.jti !== "string"
    ) {
      return false;
    }

    let storedChallenge: string | null;
    try {
      const redis = await requireSharedRedisClient();
      // GETDEL is atomic: at most one of any parallel replay attempts can
      // obtain the challenge and proceed to expensive signature verification.
      storedChallenge = await redis.getDel(
        `${CHALLENGE_REDIS_PREFIX}${payload.jti}`,
      );
    } catch {
      throw new SharedRedisUnavailableError();
    }
    if (!storedChallenge) {
      return false;
    }

    let issuedChallenge: { address?: unknown; message?: unknown };
    try {
      issuedChallenge = JSON.parse(storedChallenge);
    } catch {
      return false;
    }
    if (
      issuedChallenge.address !== address ||
      issuedChallenge.message !== payload.message
    ) {
      return false;
    }

    await verifyPersonalMessageSignature(
      new TextEncoder().encode(payload.message),
      signature,
      { address, client: getGraphQLClient() },
    );
    return true;
  } catch (error) {
    if (error instanceof SharedRedisUnavailableError) {
      throw error;
    }
    return false;
  }
}
