/**
 * AUTH API ROUTES
 * tRPC routes for zkLogin authentication
 */

import { router, procedure } from "@/shared/lib/trpc/init";
import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { verifyPersonalMessageSignature } from "@mysten/sui/verify";
import { randomBytes } from "crypto";
import { uuidv7 } from "uuidv7";
import {
  initiateLoginInput,
  completeLoginInput,
  validateSessionInput,
  connectWalletInput,
} from "./input";
import {
  generateEphemeralKeyPair,
  generateRandomnessValue,
  computeNonce,
  calculateMaxEpoch,
  calculateSessionExpiration,
  decodeAndValidateJwt,
  verifyNonce,
  extractUserProfile,
  isSessionExpired,
} from "../domain/zklogin";
import {
  getCurrentEpoch,
  deriveAddress,
  fetchUserSalt,
  generateZkProof,
} from "../lib/zklogin-client";
import { OAUTH_PROVIDERS, OAUTH_SCOPES, AUTH_ERRORS } from "../constant";
import { buildOAuthUrl } from "../domain/zklogin";
import { zkLoginSessions, walletSessions, walletChallenges } from "@/shared/db/schema";
import { eq, lt } from "drizzle-orm";
import * as authService from "../domain/service";

export const authRouter = router({
  /**
   * Step 1: Initiate OAuth login flow
   * Generates ephemeral keypair, nonce, and returns OAuth URL
   */
  initiateLogin: procedure
    .input(initiateLoginInput)
    .mutation(async ({ ctx, input }) => {
      const { provider, redirectUri } = input;

      // Validate provider
      const providerConfig = OAUTH_PROVIDERS[provider];
      if (!providerConfig) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: AUTH_ERRORS.INVALID_PROVIDER,
        });
      }

      try {
        // Generate ephemeral keypair
        const ephemeralKeyPair = generateEphemeralKeyPair();

        // Get current epoch from Sui network
        const currentEpoch = await getCurrentEpoch();
        const maxEpoch = calculateMaxEpoch(currentEpoch);

        // Generate randomness and compute nonce
        const randomness = generateRandomnessValue();
        const nonce = computeNonce(ephemeralKeyPair.publicKey, maxEpoch, randomness);

        // Create session record (without userId yet)
        const sessionId = uuidv7();
        const expiresAt = calculateSessionExpiration();

        await ctx.db.insert(zkLoginSessions).values({
          id: sessionId,
          ephemeralPrivateKey: ephemeralKeyPair.privateKey,
          ephemeralPublicKey: ephemeralKeyPair.publicKey,
          maxEpoch,
          randomness,
          nonce,
          expiresAt,
        });

        // Build OAuth URL
        const defaultRedirectUri = `${process.env.NEXT_PUBLIC_APP_URL}/auth/callback`;
        const authUrl = buildOAuthUrl({
          authUrl: providerConfig.authUrl,
          clientId: providerConfig.clientId,
          redirectUri: redirectUri || defaultRedirectUri,
          nonce,
          scopes: [...OAUTH_SCOPES[provider]], // Convert readonly to mutable array
          state: sessionId, // Pass session ID in state for callback
        });

        return {
          authUrl,
          sessionId,
          nonce,
        };
      } catch (error) {
        console.error("Failed to initiate login:", error);
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: AUTH_ERRORS.NETWORK_ERROR,
        });
      }
    }),

  /**
   * Step 2: Complete OAuth login after callback
   * Validates JWT, generates ZK proof, creates/updates user
   */
  completeLogin: procedure
    .input(completeLoginInput)
    .mutation(async ({ ctx, input }) => {
      const { jwt, sessionId } = input;

      try {
        // Fetch session
        const [session] = await ctx.db
          .select()
          .from(zkLoginSessions)
          .where(eq(zkLoginSessions.id, sessionId))
          .limit(1);

        if (!session) {
          throw new TRPCError({
            code: "NOT_FOUND",
            message: "Session not found",
          });
        }

        // Check session expiration
        if (isSessionExpired(session)) {
          throw new TRPCError({
            code: "UNAUTHORIZED",
            message: AUTH_ERRORS.SESSION_EXPIRED,
          });
        }

        // Decode and validate JWT
        const jwtClaims = decodeAndValidateJwt(jwt);

        // Verify nonce matches
        if (!verifyNonce(jwtClaims, session.nonce)) {
          throw new TRPCError({
            code: "UNAUTHORIZED",
            message: AUTH_ERRORS.INVALID_JWT,
          });
        }

        // Fetch user salt
        const salt = await fetchUserSalt(jwt);

        // Derive Sui address
        const suiAddress = await deriveAddress(jwt, salt);

        // Generate ZK proof (or reuse cached proof)
        let zkProof;
        if (session.zkProof) {          zkProof = session.zkProof;
        } else {          zkProof = await generateZkProof({
            jwt,
            ephemeralPublicKey: session.ephemeralPublicKey,
            maxEpoch: session.maxEpoch,
            randomness: session.randomness,
            salt,
          });
        }

        // Extract user profile from JWT
        const profile = extractUserProfile(jwtClaims);

        // Upsert user (create or update via service)
        const user = await authService.upsertZkLoginUser(ctx.db, {
          suiAddress,
          provider: profile.provider,
          providerSub: profile.providerSub,
          name: profile.name,
          email: profile.email,
          avatar: profile.avatar,
        });

        // Update session with userId and proof
        await authService.updateZkLoginSession(ctx.db, {
          sessionId,
          userId: user.id,
          zkProof,
        });

        return {
          user,
          suiAddress,
          sessionId,
          sessionData: {
            sessionId,
            ephemeralKeyPair: {
              privateKey: session.ephemeralPrivateKey,
              publicKey: session.ephemeralPublicKey,
            },
            maxEpoch: session.maxEpoch,
            randomness: session.randomness,
            nonce: session.nonce,
            zkProof,
            expiresAt: session.expiresAt,
          },
        };
      } catch (error) {
        console.error("Failed to complete login:", error);

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
   * Get a one-time challenge nonce for wallet authentication
   * The nonce must be signed by the wallet and returned via connectWallet
   */
  getChallenge: procedure
    .mutation(async ({ ctx }) => {
      // Clean up expired challenges to prevent table bloat
      await ctx.db
        .delete(walletChallenges)
        .where(lt(walletChallenges.expiresAt, new Date()));

      const challengeId = uuidv7();
      const nonce = randomBytes(32).toString("hex");
      const expiresAt = new Date(Date.now() + 5 * 60 * 1000); // 5 minutes

      await ctx.db.insert(walletChallenges).values({
        id: challengeId,
        nonce,
        expiresAt,
      });

      return { challengeId, nonce, expiresAt };
    }),

  /**
   * Connect wallet - authenticate with Sui wallet (Slush, Sui Wallet)
   * Verifies signature against a server-issued challenge nonce
   */
  connectWallet: procedure
    .input(connectWalletInput)
    .mutation(async ({ ctx, input }) => {
      const { challengeId, walletType, address, signature } = input;

      try {
        // 1. Atomically consume challenge
        const [challenge] = await ctx.db
          .delete(walletChallenges)
          .where(eq(walletChallenges.id, challengeId))
          .returning();

        if (!challenge) {
          throw new TRPCError({
            code: "NOT_FOUND",
            message: "Challenge not found or already used",
          });
        }

        if (challenge.expiresAt < new Date()) {
          throw new TRPCError({
            code: "UNAUTHORIZED",
            message: "Challenge expired",
          });
        }

        // 2. Verify signature against server-issued nonce
        const signerAddress = await verifyPersonalMessageSignature(
          new TextEncoder().encode(challenge.nonce),
          signature,
        ).catch(() => {
          throw new TRPCError({ code: "UNAUTHORIZED", message: "Invalid signature" });
        });

        if (signerAddress.toSuiAddress() !== address) {
          throw new TRPCError({
            code: "UNAUTHORIZED",
            message: "Signature does not match address",
          });
        }

        // 4. Create or update user
        const user = await authService.upsertWalletUser(ctx.db, {
          address,
          walletType,
        });

        // 5. Create wallet session
        const sessionId = uuidv7();
        const expiresAt = new Date();
        expiresAt.setHours(expiresAt.getHours() + 24); // 24 hour session

        await ctx.db.insert(walletSessions).values({
          id: sessionId,
          userId: user.id,
          walletAddress: address,
          walletType,
          signedMessage: challenge.nonce,
          signature,
          signedAt: new Date(),
          expiresAt,
        });

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
        const { sha512 } = await import("@noble/hashes/sha512");
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

        const { blake2b } = await import("@noble/hashes/blake2b");
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
