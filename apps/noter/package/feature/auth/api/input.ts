/**
 * AUTH API INPUT SCHEMAS
 * Zod validation for auth API routes
 *
 * Following type-flow.md:
 * - Derive from DB insert schemas where fields map to tables
 * - Use standalone schemas for flow-specific fields (e.g., jwt, redirectUri)
 */

import { z } from "zod";
import { walletSessionInsertSchema } from "@/shared/db/type";

// Session id is deliberately absent here: getSession and logout take it from the
// x-session-id header via the tRPC context, so it can never be supplied as input.

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
