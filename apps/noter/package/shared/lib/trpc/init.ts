import { initTRPC, TRPCError } from "@trpc/server";
import { FetchCreateContextFnOptions } from "@trpc/server/adapters/fetch";
import superjson from "superjson";
import { db } from "@/shared/lib/db";
import { zkLoginSessions, walletSessions } from "@/shared/db/schema";
import { eq } from "drizzle-orm";

export type Context = {
  db: typeof db;
  userId: string | null;
};

/**
 * Extract session ID from request headers
 * Client should send sessionId in x-session-id header
 */
function getSessionIdFromRequest(req: Request): string | null {
  const sessionId = req.headers.get("x-session-id");
  return sessionId;
}

/**
 * Create tRPC context with authenticated user
 * Extracts sessionId from headers and validates against database
 * Supports both zkLogin and wallet sessions
 */
export const createContext = async (
  opts: FetchCreateContextFnOptions
): Promise<Context> => {
  const sessionId = getSessionIdFromRequest(opts.req);
  if (!sessionId) {    return { db, userId: null };
  }

  // Try zkLogin session first
  const [zkSession] = await db
    .select()
    .from(zkLoginSessions)
    .where(eq(zkLoginSessions.id, sessionId))
    .limit(1);

  if (zkSession && zkSession.userId) {
    // Check if session expired
    if (zkSession.expiresAt < new Date()) {      return { db, userId: null };
    }

    return { db, userId: zkSession.userId };
  }

  // Try wallet session
  const [walletSession] = await db
    .select()
    .from(walletSessions)
    .where(eq(walletSessions.id, sessionId))
    .limit(1);

  if (walletSession && walletSession.userId) {
    // Check if session expired
    if (walletSession.expiresAt < new Date()) {      return { db, userId: null };
    }

    return { db, userId: walletSession.userId };
  }  return { db, userId: null };
};

const t = initTRPC.context<Context>().create({
  transformer: superjson,
});

export const router = t.router;
export const procedure = t.procedure;

/**
 * Protected procedure that requires authentication
 * Throws UNAUTHORIZED if no valid session
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
      userId: ctx.userId, // Now TypeScript knows userId is non-null
    },
  });
});
