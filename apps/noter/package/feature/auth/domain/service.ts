/**
 * AUTH SERVICE LAYER
 *
 * DB operations for authentication feature.
 * All service functions take db as first parameter (dependency injection pattern).
 * Called exclusively by api/route.ts handlers.
 */

import type { db as dbClient } from "@/shared/lib/db";
import { users, zkLoginSessions, walletSessions } from "@/shared/db/schema";
import { eq } from "drizzle-orm";
import type { ZkProofData } from "@/shared/db/type";

type DbClient = typeof dbClient;

// ══════════════════════════════════════════════════════════════
// ZKLOGIN USER MANAGEMENT
// ══════════════════════════════════════════════════════════════

/**
 * Create or update user from zkLogin authentication
 * Returns existing user if suiAddress matches, otherwise creates new user
 */
export async function upsertZkLoginUser(
  db: DbClient,
  input: {
    suiAddress: string;
    provider: string;
    providerSub: string;
    name: string | null;
    email: string | null;
    avatar: string | null;
  }
) {
  // Check if user exists
  const [existingUser] = await db
    .select()
    .from(users)
    .where(eq(users.suiAddress, input.suiAddress))
    .limit(1);

  if (existingUser) {
    // Update existing user
    const [user] = await db
      .update(users)
      .set({
        authMethod: "zklogin",
        provider: input.provider,
        name: input.name,
        email: input.email,
        avatar: input.avatar,
        lastSeenAt: new Date(),
      })
      .where(eq(users.id, existingUser.id))
      .returning();
    return user;
  }

  // Create new user
  const [user] = await db
    .insert(users)
    .values({
      suiAddress: input.suiAddress,
      authMethod: "zklogin",
      provider: input.provider,
      providerSub: input.providerSub,
      name: input.name,
      email: input.email,
      avatar: input.avatar,
      lastSeenAt: new Date(),
    })
    .returning();
  return user;
}

// ══════════════════════════════════════════════════════════════
// ZKLOGIN SESSION MANAGEMENT
// ══════════════════════════════════════════════════════════════

/**
 * Update zkLogin session with userId and proof after authentication completes
 * Called after successful OAuth callback and proof generation
 */
export async function updateZkLoginSession(
  db: DbClient,
  input: {
    sessionId: string;
    userId: string;
    zkProof: ZkProofData;
  }
) {
  await db
    .update(zkLoginSessions)
    .set({
      userId: input.userId,
      zkProof: input.zkProof,
    })
    .where(eq(zkLoginSessions.id, input.sessionId));
}

// ══════════════════════════════════════════════════════════════
// WALLET USER MANAGEMENT
// ══════════════════════════════════════════════════════════════

/**
 * Create or update user from wallet authentication
 * Returns existing user if suiAddress matches, otherwise creates new user
 */
export async function upsertWalletUser(
  db: DbClient,
  input: {
    address: string;
    walletType: string;
  }
) {
  const [existingUser] = await db
    .select()
    .from(users)
    .where(eq(users.suiAddress, input.address))
    .limit(1);

  if (existingUser) {
    const [user] = await db
      .update(users)
      .set({
        lastSeenAt: new Date(),
        walletType: input.walletType,
      })
      .where(eq(users.id, existingUser.id))
      .returning();
    return user;
  }

  const [user] = await db
    .insert(users)
    .values({
      suiAddress: input.address,
      authMethod: "wallet",
      walletType: input.walletType,
      name: `${input.walletType} User`,
      lastSeenAt: new Date(),
    })
    .returning();
  return user;
}

// ══════════════════════════════════════════════════════════════
// SESSION RETRIEVAL
// ══════════════════════════════════════════════════════════════

/**
 * Get active session by ID (supports both zkLogin and wallet sessions)
 * Returns null if session doesn't exist, is expired, or has no associated user
 */
export async function getActiveSession(db: DbClient, sessionId: string) {
  // Try zkLogin session first
  const [zkSession] = await db
    .select()
    .from(zkLoginSessions)
    .where(eq(zkLoginSessions.id, sessionId))
    .limit(1);

  if (zkSession?.userId && zkSession.expiresAt > new Date()) {
    const [user] = await db
      .select()
      .from(users)
      .where(eq(users.id, zkSession.userId))
      .limit(1);

    if (user) {
      return {
        user,
        sessionId: zkSession.id,
        suiAddress: user.suiAddress,
        expiresAt: zkSession.expiresAt,
      };
    }
  }

  // Try wallet session
  const [walletSession] = await db
    .select()
    .from(walletSessions)
    .where(eq(walletSessions.id, sessionId))
    .limit(1);

  if (walletSession?.userId && walletSession.expiresAt > new Date()) {
    const [user] = await db
      .select()
      .from(users)
      .where(eq(users.id, walletSession.userId))
      .limit(1);

    if (user) {
      return {
        user,
        sessionId: walletSession.id,
        suiAddress: user.suiAddress,
        expiresAt: walletSession.expiresAt,
      };
    }
  }

  return null;
}

// ══════════════════════════════════════════════════════════════
// ENOKI USER MANAGEMENT
// ══════════════════════════════════════════════════════════════

/** Create or update user from Enoki zkLogin. Stores delegate key for returning-user fast path. */
export async function upsertEnokiUser(
  db: DbClient,
  input: {
    suiAddress: string;
    delegatePrivateKey: string;
    delegateAccountId: string;
  }
) {
  const [existingUser] = await db
    .select()
    .from(users)
    .where(eq(users.suiAddress, input.suiAddress))
    .limit(1);

  if (existingUser) {
    const [user] = await db
      .update(users)
      .set({
        authMethod: "enoki",
        delegatePrivateKey: input.delegatePrivateKey,
        delegateAccountId: input.delegateAccountId,
        lastSeenAt: new Date(),
      })
      .where(eq(users.id, existingUser.id))
      .returning();
    return user;
  }

  const [user] = await db
    .insert(users)
    .values({
      suiAddress: input.suiAddress,
      authMethod: "enoki",
      delegatePrivateKey: input.delegatePrivateKey,
      delegateAccountId: input.delegateAccountId,
      name: "Enoki User",
      lastSeenAt: new Date(),
    })
    .returning();
  return user;
}

/** Look up Enoki user with stored credentials for returning-user fast path. */
export async function getEnokiUserBySuiAddress(db: DbClient, suiAddress: string) {
  const [user] = await db
    .select()
    .from(users)
    .where(eq(users.suiAddress, suiAddress))
    .limit(1);

  if (user?.delegatePrivateKey && user?.delegateAccountId) {
    return user;
  }
  return null;
}

/** Create an Enoki session. Reuses walletSessions table with walletType "enoki". */
export async function createEnokiSession(
  db: DbClient,
  input: { sessionId: string; userId: string; suiAddress: string }
) {
  const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000);
  await db.insert(walletSessions).values({
    id: input.sessionId,
    userId: input.userId,
    walletAddress: input.suiAddress,
    walletType: "enoki",
    signedMessage: "enoki-zklogin",
    signature: "",
    signedAt: new Date(),
    expiresAt,
  });
  return { sessionId: input.sessionId, expiresAt };
}

// ══════════════════════════════════════════════════════════════
// SESSION CLEANUP
// ══════════════════════════════════════════════════════════════

/**
 * Delete all sessions for a given session ID (logout)
 * Removes from both zkLoginSessions and walletSessions tables
 */
export async function deleteSession(db: DbClient, sessionId: string) {
  await db.delete(zkLoginSessions).where(eq(zkLoginSessions.id, sessionId));
  await db.delete(walletSessions).where(eq(walletSessions.id, sessionId));
}
