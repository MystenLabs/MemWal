/**
 * AUTH API ROUTES
 * tRPC routes for Enoki zkLogin + wallet / delegate-key authentication.
 */

import { router, procedure } from "@/shared/lib/trpc/init";
import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { verifyPersonalMessageSignature } from "@mysten/sui/verify";
import { uuidv7 } from "uuidv7";
import { validateSessionInput, connectWalletInput } from "./input";
import { AUTH_ERRORS } from "../constant";
import { walletSessions } from "@/shared/db/schema";
import * as authService from "../domain/service";

export const authRouter = router({
  /**
   * Get current session (for resuming auth state)
   * Works for both zkLogin and wallet sessions
   */
  getSession: procedure
    .input(validateSessionInput)
    .query(({ ctx, input }) =>
      authService.getActiveSession(ctx.db, input.sessionId)
    ),

  /**
   * Logout - clear session (works for both zkLogin and wallet)
   */
  logout: procedure
    .input(validateSessionInput)
    .mutation(async ({ ctx, input }) => {
      await authService.deleteSession(ctx.db, input.sessionId);
      return { success: true };
    }),

  /**
   * Connect wallet - authenticate with Sui wallet (Slush, Sui Wallet)
   * Verifies signature and creates session
   */
  connectWallet: procedure
    .input(connectWalletInput)
    .mutation(async ({ ctx, input }) => {
      const { walletType, address, signature, message } = input;

      try {
        // Verify the wallet signature before creating a session
        const signerAddress = await verifyPersonalMessageSignature(
          new TextEncoder().encode(message),
          signature,
        ).catch(() => {
          throw new TRPCError({ code: "UNAUTHORIZED", message: "Invalid signature" });
        });

        if (signerAddress.toSuiAddress() !== address) {
          throw new TRPCError({ code: "UNAUTHORIZED", message: "Signature does not match address" });
        }

        // Create or update user via service
        const user = await authService.upsertWalletUser(ctx.db, {
          address,
          walletType,
        });

        // Create wallet session
        const sessionId = uuidv7();
        const expiresAt = new Date();
        expiresAt.setHours(expiresAt.getHours() + 24); // 24 hour session

        await ctx.db.insert(walletSessions).values({
          id: sessionId,
          userId: user.id,
          walletAddress: address,
          walletType,
          signedMessage: message,
          signature,
          signedAt: new Date(),
          expiresAt,
        });

        // Return wallet session data (no ephemeral keys for wallet auth)
        return {
          user,
          sessionId,
          sessionData: {
            sessionId,
            expiresAt,
          },
        };
      } catch (error) {
        console.error("Failed to connect wallet:", error);

        if (error instanceof TRPCError) {
          throw error;
        }

        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: error instanceof Error ? error.message : AUTH_ERRORS.NETWORK_ERROR,
        });
      }
    }),

  /** Connect with Enoki zkLogin. Two-phase: suiAddress only = returning user check, full = register. */
  connectEnoki: procedure
    .input(z.object({
      suiAddress: z.string().min(1),
      privateKey: z.string().optional(),
      accountId: z.string().optional(),
    }))
    .mutation(async ({ ctx, input }) => {
      const { suiAddress, privateKey, accountId } = input;

      try {
        // Phase 1: returning user check
        if (!privateKey && !accountId) {
          const existing = await authService.getEnokiUserBySuiAddress(ctx.db, suiAddress);
          if (existing) {
            const sessionId = uuidv7();
            const session = await authService.createEnokiSession(ctx.db, {
              sessionId, userId: existing.id, suiAddress,
            });
            return {
              needsSetup: false,
              user: existing,
              sessionId: session.sessionId,
              sessionData: { sessionId: session.sessionId, expiresAt: session.expiresAt },
            };
          }
          return { needsSetup: true };
        }

        // Phase 2: register with credentials
        if (!privateKey || !accountId) {
          throw new TRPCError({ code: "BAD_REQUEST", message: "privateKey and accountId required" });
        }

        const user = await authService.upsertEnokiUser(ctx.db, {
          suiAddress, delegatePrivateKey: privateKey, delegateAccountId: accountId,
        });

        const sessionId = uuidv7();
        const session = await authService.createEnokiSession(ctx.db, {
          sessionId, userId: user.id, suiAddress,
        });

        return {
          needsSetup: false,
          user,
          sessionId: session.sessionId,
          sessionData: { sessionId: session.sessionId, expiresAt: session.expiresAt },
        };
      } catch (error) {
        if (error instanceof TRPCError) throw error;
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: error instanceof Error ? error.message : AUTH_ERRORS.NETWORK_ERROR,
        });
      }
    }),

  /** Connect with delegate key (manual key + account ID login). */
  connectDelegateKey: procedure
    .input(z.object({
      privateKey: z.string().regex(/^[0-9a-f]{64}$/i, "Must be 64 hex characters"),
      accountId: z.string().min(1),
    }))
    .mutation(async ({ ctx, input }) => {
      const { privateKey, accountId } = input;

      try {
        // Derive Sui address from private key
        const ed = await import("@noble/ed25519");
        const { sha512 } = await import("@noble/hashes/sha2.js");
        if (!(ed.etc as any).sha512Sync) {
          (ed.etc as any).sha512Sync = (...m: Uint8Array[]) => {
            const h = sha512.create();
            for (const msg of m) h.update(msg);
            return h.digest();
          };
        }

        const privKeyBytes = Uint8Array.from(
          privateKey.match(/.{2}/g)!.map((b) => parseInt(b, 16))
        );
        const pubKeyBytes = ed.getPublicKey(privKeyBytes);

        const { blake2b } = await import("@noble/hashes/blake2.js");
        const addrInput = new Uint8Array(33);
        addrInput[0] = 0x00;
        addrInput.set(pubKeyBytes, 1);
        const addressBytes = blake2b(addrInput, { dkLen: 32 });
        const suiAddress = "0x" + Array.from(new Uint8Array(addressBytes))
          .map((b) => b.toString(16).padStart(2, "0")).join("");

        const user = await authService.upsertEnokiUser(ctx.db, {
          suiAddress, delegatePrivateKey: privateKey, delegateAccountId: accountId,
        });

        const sessionId = uuidv7();
        const session = await authService.createEnokiSession(ctx.db, {
          sessionId, userId: user.id, suiAddress,
        });

        return {
          user,
          sessionId: session.sessionId,
          sessionData: { sessionId: session.sessionId, expiresAt: session.expiresAt },
        };
      } catch (error) {
        if (error instanceof TRPCError) throw error;
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: error instanceof Error ? error.message : AUTH_ERRORS.NETWORK_ERROR,
        });
      }
    }),
});
