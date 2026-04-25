import { initTRPC, TRPCError } from "@trpc/server";
import { FetchCreateContextFnOptions } from "@trpc/server/adapters/fetch";
import superjson from "superjson";
import { db } from "@/shared/lib/db";
import { zkLoginSessions, walletSessions, users } from "@/shared/db/schema";
import { eq } from "drizzle-orm";

export type Context = {
  db: typeof db;
  userId: string | null;
  /** Per-user MemWal delegate key (null if user has no stored key). */
  memwalKey: string | null;
  /** Per-user MemWal account ID (null if user has no stored account). */
  memwalAccountId: string | null;
};

function getSessionIdFromRequest(req: Request): string | null {
  return req.headers.get("x-session-id");
}

/** Load user's MemWal delegate key from the users table. Falls back to env vars. */
async function loadUserMemwalKey(userId: string) {
  try {
    const [user] = await db.select().from(users).where(eq(users.id, userId)).limit(1);
    return {
      memwalKey: user?.delegatePrivateKey ?? process.env.MEMWAL_KEY ?? null,
      memwalAccountId: user?.delegateAccountId ?? process.env.MEMWAL_ACCOUNT_ID ?? null,
    };
  } catch {
    return {
      memwalKey: process.env.MEMWAL_KEY ?? null,
      memwalAccountId: process.env.MEMWAL_ACCOUNT_ID ?? null,
    };
  }
}

export const createContext = async (
  opts: FetchCreateContextFnOptions
): Promise<Context> => {
  const noAuth: Context = { db, userId: null, memwalKey: null, memwalAccountId: null };
  const sessionId = getSessionIdFromRequest(opts.req);
  if (!sessionId) return noAuth;

  // Try zkLogin session first
  const [zkSession] = await db
    .select()
    .from(zkLoginSessions)
    .where(eq(zkLoginSessions.id, sessionId))
    .limit(1);

  if (zkSession?.userId && zkSession.expiresAt > new Date()) {
    const keys = await loadUserMemwalKey(zkSession.userId);
    return { db, userId: zkSession.userId, ...keys };
  }

  // Try wallet/enoki session
  const [walletSession] = await db
    .select()
    .from(walletSessions)
    .where(eq(walletSessions.id, sessionId))
    .limit(1);

  if (walletSession?.userId && walletSession.expiresAt > new Date()) {
    const keys = await loadUserMemwalKey(walletSession.userId);
    return { db, userId: walletSession.userId, ...keys };
  }

  return noAuth;
};

const t = initTRPC.context<Context>().create({
  transformer: superjson,
});

export const router = t.router;
export const procedure = t.procedure;

/**
 * Protected procedure that requires authentication.
 * Throws UNAUTHORIZED if no valid session.
 */
export const protectedProcedure = t.procedure.use(async ({ ctx, next }) => {
  if (!ctx.userId) {
    throw new TRPCError({
      code: "UNAUTHORIZED",
      message: "Authentication required",
    });
  }

  return next({
    ctx: {
      ...ctx,
      userId: ctx.userId,
    },
  });
});
