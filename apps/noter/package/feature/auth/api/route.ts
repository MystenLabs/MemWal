/**
 * AUTH API ROUTES
 * tRPC routes for Enoki zkLogin + wallet / delegate-key authentication.
 */

import { router, procedure, protectedProcedure } from "@/shared/lib/trpc/init";
import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { verifyPersonalMessageSignature } from "@mysten/sui/verify";
import { normalizeSuiAddress } from "@mysten/sui/utils";
import { uuidv7 } from "uuidv7";
import { validateSessionInput, connectWalletInput } from "./input";
import { AUTH_ERRORS } from "../constant";
import { walletSessions } from "@/shared/db/schema";
import * as authService from "../domain/service";
import { toSafeUser, DelegateCredentialConflictError } from "../domain/service";
import {
  issueEnokiChallenge as issueEnokiChallengeToken,
  verifyAndConsumeEnokiChallenge,
} from "../lib/enoki-challenge";
import { SharedRedisUnavailableError } from "@/shared/lib/shared-redis";

// Canonical Sui address: 0x + 64 hex. Reject malformed input at the boundary so
// it never reaches normalizeSuiAddress (which would silently left-pad garbage
// into a valid-looking-but-wrong address) or a DB lookup.
const suiAddressSchema = z
  .string()
  .regex(/^0x[0-9a-f]{64}$/i, "Invalid Sui address");

export const authRouter = router({
  /**
   * Get current session (for resuming auth state).
   * Resolves wallet / enoki sessions only; the legacy zkLogin table is not trusted.
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

        // Return wallet session data (no ephemeral keys for wallet auth).
        // Sanitized: never expose the delegate signing key or PII to the client.
        return {
          user: toSafeUser(user),
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

  /**
   * Issue a single-use SIGN-IN challenge for the Enoki flow. The client signs the
   * returned `message` with its zkLogin key and returns `{ challengeId, signature }`
   * to connectEnoki. This challenge is scoped to sign-in only — it cannot be used
   * to authorize a delegate-key export.
   */
  issueEnokiChallenge: procedure
    .input(z.object({ suiAddress: suiAddressSchema }))
    .mutation(async ({ input }) => {
      try {
        const { challengeId, message } = await issueEnokiChallengeToken(
          input.suiAddress,
          "signin"
        );
        return { challengeId, message };
      } catch (error) {
        if (error instanceof SharedRedisUnavailableError) {
          throw new TRPCError({
            code: "SERVICE_UNAVAILABLE",
            message: "Authentication service temporarily unavailable",
          });
        }
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: error instanceof Error ? error.message : AUTH_ERRORS.NETWORK_ERROR,
        });
      }
    }),

  /**
   * Connect with Enoki zkLogin. Every call must prove address ownership with a
   * signed challenge (challengeId + signature). Two-phase: without privateKey/
   * accountId = returning-user check; with them = register.
   */
  connectEnoki: procedure
    .input(z.object({
      suiAddress: suiAddressSchema,
      challengeId: z.string().min(1),
      signature: z.string().min(1),
      privateKey: z.string().optional(),
      accountId: z.string().optional(),
    }))
    .mutation(async ({ ctx, input }) => {
      const { challengeId, signature, privateKey, accountId } = input;
      // Normalize once so the challenge check and every DB op key on the same
      // canonical address (a non-canonical variant would otherwise verify but
      // miss the stored row).
      const suiAddress = normalizeSuiAddress(input.suiAddress);

      try {
        // Ownership gate — must pass BEFORE any DB lookup, for both phases.
        let ownershipVerified: boolean;
        try {
          ownershipVerified = await verifyAndConsumeEnokiChallenge({
            rawAddress: suiAddress,
            challengeId,
            signature,
            purpose: "signin",
          });
        } catch (error) {
          if (error instanceof SharedRedisUnavailableError) {
            throw new TRPCError({
              code: "SERVICE_UNAVAILABLE",
              message: "Authentication service temporarily unavailable",
            });
          }
          throw error;
        }
        if (!ownershipVerified) {
          throw new TRPCError({
            code: "UNAUTHORIZED",
            message: "Wallet ownership verification failed",
          });
        }

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
              user: toSafeUser(existing),
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
          user: toSafeUser(user),
          sessionId: session.sessionId,
          sessionData: { sessionId: session.sessionId, expiresAt: session.expiresAt },
        };
      } catch (error) {
        if (error instanceof TRPCError) throw error;
        if (error instanceof DelegateCredentialConflictError) {
          throw new TRPCError({ code: "CONFLICT", message: error.message });
        }
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: error instanceof Error ? error.message : AUTH_ERRORS.NETWORK_ERROR,
        });
      }
    }),

  /**
   * Issue a single-use EXPORT challenge, scoped to the delegate-key export action
   * and to the caller's own session address. Protected: requires a valid session,
   * and the challenge is issued only for that session's address — so a caller can
   * never obtain an export challenge for someone else's address, and a sign-in
   * signature can never satisfy it (different purpose).
   */
  issueExportChallenge: protectedProcedure.mutation(async ({ ctx }) => {
    try {
      const address = await authService.getUserAddressById(ctx.db, ctx.userId);
      if (!address) {
        throw new TRPCError({ code: "NOT_FOUND", message: "User not found" });
      }
      const { challengeId, message } = await issueEnokiChallengeToken(
        address,
        "export"
      );
      return { challengeId, message };
    } catch (error) {
      if (error instanceof TRPCError) throw error;
      if (error instanceof SharedRedisUnavailableError) {
        throw new TRPCError({
          code: "SERVICE_UNAVAILABLE",
          message: "Authentication service temporarily unavailable",
        });
      }
      throw new TRPCError({
        code: "INTERNAL_SERVER_ERROR",
        message: error instanceof Error ? error.message : AUTH_ERRORS.NETWORK_ERROR,
      });
    }
  }),

  /**
   * Export the delegate private key for the authenticated caller. This is the
   * ONLY path that returns the private key. It requires: a valid session
   * (protectedProcedure); an EXPORT-purpose ownership challenge signature (a
   * sign-in signature cannot be replayed here); and that the caller's session
   * address matches the requested address (a caller can only export their own key).
   */
  exportDelegateKey: protectedProcedure
    .input(z.object({
      suiAddress: suiAddressSchema,
      challengeId: z.string().min(1),
      signature: z.string().min(1),
    }))
    .mutation(async ({ ctx, input }) => {
      const { challengeId, signature } = input;
      const suiAddress = normalizeSuiAddress(input.suiAddress);

      try {
        // Bind the export to the session: the caller may only export the key for
        // the address their own session authenticates as.
        const sessionAddress = await authService.getUserAddressById(
          ctx.db,
          ctx.userId
        );
        if (!sessionAddress || normalizeSuiAddress(sessionAddress) !== suiAddress) {
          throw new TRPCError({
            code: "FORBIDDEN",
            message: "You can only export the key for your own session",
          });
        }

        let ownershipVerified: boolean;
        try {
          ownershipVerified = await verifyAndConsumeEnokiChallenge({
            rawAddress: suiAddress,
            challengeId,
            signature,
            purpose: "export",
          });
        } catch (error) {
          if (error instanceof SharedRedisUnavailableError) {
            throw new TRPCError({
              code: "SERVICE_UNAVAILABLE",
              message: "Authentication service temporarily unavailable",
            });
          }
          throw error;
        }
        if (!ownershipVerified) {
          throw new TRPCError({
            code: "UNAUTHORIZED",
            message: "Wallet ownership verification failed",
          });
        }

        const key = await authService.getDelegateKeyForOwner(ctx.db, suiAddress);
        if (!key) {
          throw new TRPCError({
            code: "NOT_FOUND",
            message: "No delegate key found for this address",
          });
        }
        return {
          delegatePrivateKey: key.delegatePrivateKey,
          delegateAccountId: key.delegateAccountId,
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
          user: toSafeUser(user),
          sessionId: session.sessionId,
          sessionData: { sessionId: session.sessionId, expiresAt: session.expiresAt },
        };
      } catch (error) {
        if (error instanceof TRPCError) throw error;
        if (error instanceof DelegateCredentialConflictError) {
          throw new TRPCError({ code: "CONFLICT", message: error.message });
        }
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: error instanceof Error ? error.message : AUTH_ERRORS.NETWORK_ERROR,
        });
      }
    }),
});
