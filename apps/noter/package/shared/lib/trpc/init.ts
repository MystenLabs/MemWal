import { initTRPC, TRPCError } from "@trpc/server";
import { FetchCreateContextFnOptions } from "@trpc/server/adapters/fetch";
import superjson from "superjson";
import { db } from "@/shared/lib/db";
import { walletSessions } from "@/shared/db/schema";
import { eq } from "drizzle-orm";

export type Context = {
  db: typeof db;
  request: Request;
  /**
   * The session id the caller presented in x-session-id, whether or not it
   * resolves to a live session. Procedures that act on a session must read it
   * from here rather than from their input, so holding the credential is what
   * grants access instead of merely knowing the id.
   */
  sessionId: string | null;
  userId: string | null;
};

const UUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function getSessionIdFromRequest(req: Request): string | null {
  const sessionId = req.headers.get("x-session-id")?.trim();

  // Session ids are compared against uuid columns, where a malformed value makes
  // Postgres raise rather than simply miss. Anything that is not a uuid cannot
  // name a session, so treat it as no credential at all.
  if (!sessionId || !UUID_REGEX.test(sessionId)) {
    return null;
  }

  return sessionId;
}

export const createContext = async (
  opts: FetchCreateContextFnOptions
): Promise<Context> => {
  const sessionId = getSessionIdFromRequest(opts.req);
  const noAuth: Context = {
    db,
    request: opts.req,
    sessionId,
    userId: null,
  };
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
    return { db, request: opts.req, sessionId, userId: walletSession.userId };
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
