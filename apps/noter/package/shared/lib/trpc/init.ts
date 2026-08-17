import { initTRPC, TRPCError } from "@trpc/server";
import { FetchCreateContextFnOptions } from "@trpc/server/adapters/fetch";
import superjson from "superjson";
import { db } from "@/shared/lib/db";
import { walletSessions } from "@/shared/db/schema";
import { eq } from "drizzle-orm";

export type Context = {
  db: typeof db;
  request: Request;
  userId: string | null;
};

function getSessionIdFromRequest(req: Request): string | null {
  return req.headers.get("x-session-id");
}

export const createContext = async (
  opts: FetchCreateContextFnOptions
): Promise<Context> => {
  const noAuth: Context = {
    db,
    request: opts.req,
    userId: null,
  };
  const sessionId = getSessionIdFromRequest(opts.req);
  if (!sessionId) return noAuth;

  // Sessions are resolved only from wallet/enoki sessions, which require proof
  // of address ownership to create. The legacy zklogin_sessions table (written
  // by the removed custom zkLogin flow) is deliberately no longer trusted here,
  // so a leftover or re-introduced row can never authenticate a request.
  const [walletSession] = await db
    .select()
    .from(walletSessions)
    .where(eq(walletSessions.id, sessionId))
    .limit(1);

  if (walletSession?.userId && walletSession.expiresAt > new Date()) {
    return { db, request: opts.req, userId: walletSession.userId };
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
