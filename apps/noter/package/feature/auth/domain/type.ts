/**
 * AUTH DOMAIN TYPES
 * Pure TypeScript types for auth feature (no Zod, no DB)
 */

import type { User, ZkProofData } from "@/shared/db/type";
import type { OAuthProvider } from "../constant";

// ═══════════════════════════════════════════════════════════════
// Authentication State
// ═══════════════════════════════════════════════════════════════

export type AuthState = {
  isAuthenticated: boolean;
  user: User | null;
  suiAddress: string | null;
  provider: OAuthProvider | null;
  isLoading: boolean;
};

// ═══════════════════════════════════════════════════════════════
// Session Data Types
// ═══════════════════════════════════════════════════════════════

export type EphemeralKeyPair = {
  privateKey: string; // Base64 encoded
  publicKey: string; // Base64 encoded
};

/**
 * zkLogin session data with ephemeral keypair and proof
 * Used for OAuth-based authentication via zkLogin
 */
export type ZkLoginSessionData = {
  sessionId: string;
  ephemeralKeyPair: EphemeralKeyPair;
  maxEpoch: number;
  randomness: string;
  nonce: string;
  zkProof?: ZkProofData;
  expiresAt: Date;
};

/**
 * Wallet session data for direct wallet connections
 * Simpler structure as wallet auth doesn't use ephemeral keys
 */
export type WalletSessionData = {
  sessionId: string;
  expiresAt: Date;
};

/**
 * Union type for all session types
 * Discriminate by checking for presence of ephemeralKeyPair
 */
export type SessionData = ZkLoginSessionData | WalletSessionData;

// Note: ZkProofData imported from @/shared/db/type (defined in schema.ts)

// ═══════════════════════════════════════════════════════════════
// JWT Claims (from OpenID providers)
// ═══════════════════════════════════════════════════════════════

export type JwtClaims = {
  iss: string; // Issuer (e.g., "https://accounts.google.com")
  sub: string; // Subject (unique user ID from provider)
  aud: string; // Audience (your app's client ID)
  exp: number; // Expiration timestamp
  iat: number; // Issued at timestamp
  nonce?: string; // Nonce (must match the one we sent)
  email?: string; // User's email
  name?: string; // User's full name
  picture?: string; // User's avatar URL
};

// ═══════════════════════════════════════════════════════════════
// OAuth Flow Data
// ═══════════════════════════════════════════════════════════════

export type OAuthInitData = {
  authUrl: string; // URL to redirect user for OAuth
  sessionId: string; // Session ID to track the flow
  nonce: string; // Nonce for JWT validation
};

export type OAuthCallbackData = {
  jwt: string; // ID token from OAuth provider
  sessionId: string; // Session ID from initial flow
};

// ═══════════════════════════════════════════════════════════════
// Login Result
// ═══════════════════════════════════════════════════════════════

export type LoginResult = {
  user: User;
  suiAddress: string;
  sessionData: SessionData;
};

// ═══════════════════════════════════════════════════════════════
// UI Component Props
// ═══════════════════════════════════════════════════════════════

export type LoginButtonProps = {
  provider: OAuthProvider;
  onSuccess?: (result: LoginResult) => void;
  onError?: (error: Error) => void;
  className?: string;
};

export type UserMenuProps = {
  user: Pick<User, "id" | "name" | "email" | "avatar" | "suiAddress">;
  onLogout?: () => void;
};

export type AuthGuardProps = {
  children: React.ReactNode;
  fallback?: React.ReactNode;
  redirectTo?: string;
};
