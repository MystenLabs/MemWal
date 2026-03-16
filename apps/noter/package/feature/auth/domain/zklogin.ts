/**
 * ZKLOGIN DOMAIN LOGIC
 * Pure functions for zkLogin authentication (no DB, no async except where noted)
 */

import { Ed25519Keypair, Ed25519PublicKey } from "@mysten/sui/keypairs/ed25519";
import { generateNonce, generateRandomness } from "@mysten/sui/zklogin";
import { jwtDecode } from "jwt-decode";
import type { EphemeralKeyPair, JwtClaims, SessionData } from "./type";
import { AUTH_ERRORS, ZKLOGIN_CONFIG } from "../constant";

// ═══════════════════════════════════════════════════════════════
// Ephemeral Key Management
// ═══════════════════════════════════════════════════════════════

/**
 * Generate a new ephemeral keypair for zkLogin session
 * Returns base64-encoded private and public keys
 */
export function generateEphemeralKeyPair(): EphemeralKeyPair {
  const keypair = new Ed25519Keypair();

  return {
    privateKey: keypair.getSecretKey(),
    publicKey: keypair.getPublicKey().toBase64(),
  };
}

/**
 * Restore keypair from stored secret key
 */
export function restoreKeyPair(secretKey: string): Ed25519Keypair {
  return Ed25519Keypair.fromSecretKey(secretKey);
}

// ═══════════════════════════════════════════════════════════════
// Nonce & Randomness Generation
// ═══════════════════════════════════════════════════════════════

/**
 * Generate cryptographic randomness for nonce
 */
export function generateRandomnessValue(): string {
  return generateRandomness();
}

/**
 * Compute OAuth nonce from ephemeral public key, max epoch, and randomness
 * This nonce will be included in the OAuth request and verified in the JWT
 */
export function computeNonce(
  ephemeralPublicKey: string,
  maxEpoch: number,
  randomness: string
): string {
  const publicKey = new Ed25519PublicKey(ephemeralPublicKey);
  return generateNonce(publicKey, maxEpoch, randomness);
}

// ═══════════════════════════════════════════════════════════════
// JWT Handling
// ═══════════════════════════════════════════════════════════════

/**
 * Decode and validate JWT token from OAuth provider
 * Throws if JWT is invalid or expired
 */
export function decodeAndValidateJwt(token: string): JwtClaims {
  try {
    const claims = jwtDecode<JwtClaims>(token);

    // Check expiration
    const now = Math.floor(Date.now() / 1000);
    if (claims.exp && claims.exp < now) {
      throw new Error(AUTH_ERRORS.INVALID_JWT);
    }

    // Validate required fields
    if (!claims.iss || !claims.sub || !claims.aud) {
      throw new Error(AUTH_ERRORS.INVALID_JWT);
    }

    return claims;
  } catch (error) {
    if (error instanceof Error && error.message === AUTH_ERRORS.INVALID_JWT) {
      throw error;
    }
    throw new Error(AUTH_ERRORS.INVALID_JWT);
  }
}

/**
 * Verify that JWT nonce matches expected value
 */
export function verifyNonce(jwt: JwtClaims, expectedNonce: string): boolean {
  return jwt.nonce === expectedNonce;
}

// ═══════════════════════════════════════════════════════════════
// Session Validation
// ═══════════════════════════════════════════════════════════════

/**
 * Check if zkLogin session has expired
 */
export function isSessionExpired(session: Pick<SessionData, "expiresAt">): boolean {
  return new Date() >= new Date(session.expiresAt);
}

/**
 * Calculate session expiration date based on max epoch
 * Sessions expire slightly before the epoch boundary
 */
export function calculateSessionExpiration(): Date {
  const hours = ZKLOGIN_CONFIG.sessionDurationHours;
  const expiration = new Date();
  expiration.setHours(expiration.getHours() + hours);
  return expiration;
}

/**
 * Calculate max epoch for zkLogin session
 * This should be fetched from the Sui network in the API layer
 */
export function calculateMaxEpoch(currentEpoch: number): number {
  return currentEpoch + ZKLOGIN_CONFIG.maxEpochOffset;
}

// ═══════════════════════════════════════════════════════════════
// OAuth URL Construction
// ═══════════════════════════════════════════════════════════════

/**
 * Build OAuth authorization URL with nonce
 */
export function buildOAuthUrl(params: {
  authUrl: string;
  clientId: string;
  redirectUri: string;
  nonce: string;
  scopes: string[];
  state?: string;
}): string {
  const url = new URL(params.authUrl);

  url.searchParams.set("client_id", params.clientId);
  url.searchParams.set("redirect_uri", params.redirectUri);
  url.searchParams.set("response_type", "id_token");
  url.searchParams.set("scope", params.scopes.join(" "));
  url.searchParams.set("nonce", params.nonce);

  if (params.state) {
    url.searchParams.set("state", params.state);
  }

  return url.toString();
}

// ═══════════════════════════════════════════════════════════════
// User Profile Extraction
// ═══════════════════════════════════════════════════════════════

/**
 * Extract user profile data from JWT claims
 */
export function extractUserProfile(jwt: JwtClaims) {
  return {
    name: jwt.name || null,
    email: jwt.email || null,
    avatar: jwt.picture || null,
    provider: extractProvider(jwt.iss),
    providerSub: jwt.sub,
  };
}

/**
 * Extract provider name from JWT issuer
 */
function extractProvider(issuer: string): string {
  if (issuer.includes("google")) return "google";
  if (issuer.includes("facebook")) return "facebook";
  if (issuer.includes("twitch")) return "twitch";
  if (issuer.includes("apple")) return "apple";
  return "unknown";
}

// ═══════════════════════════════════════════════════════════════
// Sui Address Truncation (UI Helper)
// ═══════════════════════════════════════════════════════════════

/**
 * Truncate Sui address for display
 * Example: 0x1234...5678
 */
export function truncateSuiAddress(address: string, chars: number = 4): string {
  if (address.length <= chars * 2 + 2) return address;
  return `${address.slice(0, chars + 2)}...${address.slice(-chars)}`;
}
