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
  walletSessionInsertSchema,
} from "@/shared/db/type";

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
  message: walletSessionInsertSchema.shape.signedMessage, // Maps to signedMessage in DB
});

export type ConnectWalletInput = z.infer<typeof connectWalletInput>;
