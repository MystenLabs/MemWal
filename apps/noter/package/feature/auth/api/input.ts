/**
 * AUTH API INPUT SCHEMAS
 * Zod validation for auth API routes
 *
 * Following type-flow.md:
 * - Derive from DB insert schemas where fields map to tables
 * - Use standalone schemas for flow-specific fields (e.g., jwt, redirectUri)
 */

import { z } from "zod";
import {
  uuidv7Schema,
  idInputSchema,
  userInsertSchema,
  walletSessionInsertSchema,
} from "@/shared/db/type";

// ═══════════════════════════════════════════════════════════════
// OAuth Flow Inputs
// ═══════════════════════════════════════════════════════════════

/**
 * Input for initiating OAuth login flow
 * Derives provider from users table, adds flow-specific redirectUri
 */
export const initiateLoginInput = userInsertSchema
  .pick({ provider: true })
  .extend({
    provider: z.enum(["google"]), // Only Google supported for now (subset of DB enum)
    redirectUri: z.string().url().optional(), // Flow-specific field
  });

export type InitiateLoginInput = z.infer<typeof initiateLoginInput>;

/**
 * Input for completing OAuth login (callback handler)
 */
export const completeLoginInput = z.object({
  jwt: z.string().min(1), // ID token from OAuth provider
  sessionId: uuidv7Schema, // Session ID from initiate flow
});

export type CompleteLoginInput = z.infer<typeof completeLoginInput>;

// ═══════════════════════════════════════════════════════════════
// Session Management Inputs
// ═══════════════════════════════════════════════════════════════

/**
 * Input for validating existing session
 * Uses common idInputSchema pattern, aliased as sessionId
 */
export const validateSessionInput = z.object({
  sessionId: uuidv7Schema, // Same as idInputSchema.shape.id
});

export type ValidateSessionInput = z.infer<typeof validateSessionInput>;

/**
 * Input for refreshing ZK proof
 */
export const refreshProofInput = z.object({
  sessionId: uuidv7Schema,
  jwt: z.string().min(1), // Fresh JWT token
});

export type RefreshProofInput = z.infer<typeof refreshProofInput>;

// ═══════════════════════════════════════════════════════════════
// Wallet Auth Inputs
// ═══════════════════════════════════════════════════════════════

/**
 * Input for wallet authentication
 * Derives field types from walletSessionInsertSchema
 * Uses client-friendly names (address/message instead of walletAddress/signedMessage)
 */
export const connectWalletInput = z.object({
  walletType: walletSessionInsertSchema.shape.walletType.pipe(z.enum(["slush"])), // Subset validation
  address: walletSessionInsertSchema.shape.walletAddress, // Maps to walletAddress in DB
  signature: walletSessionInsertSchema.shape.signature,
  challengeId: uuidv7Schema, // Server-issued challenge ID (replaces client message)
});

export type ConnectWalletInput = z.infer<typeof connectWalletInput>;
