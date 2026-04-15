/**
 * Memory Remember API — analyzes note text and extracts facts to MemWal.
 * Uses the authenticated user's delegate key from their session.
 */

import { extractMemories } from "@/feature/note/lib/pdw-client";
import { db } from "@/shared/lib/db";
import { zkLoginSessions, walletSessions, users } from "@/shared/db/schema";
import { eq } from "drizzle-orm";

/** Resolve user's MemWal key from session header. */
async function resolveUserKey(req: Request) {
  const sessionId = req.headers.get("x-session-id");
  if (!sessionId) return { key: null, accountId: null };

  // Check wallet/enoki sessions
  const [session] = await db
    .select()
    .from(walletSessions)
    .where(eq(walletSessions.id, sessionId))
    .limit(1);

  if (!session?.userId || session.expiresAt < new Date()) {
    // Try zkLogin session
    const [zkSession] = await db
      .select()
      .from(zkLoginSessions)
      .where(eq(zkLoginSessions.id, sessionId))
      .limit(1);
    if (!zkSession?.userId || zkSession.expiresAt < new Date()) {
      return { key: null, accountId: null };
    }
    const [user] = await db.select().from(users).where(eq(users.id, zkSession.userId)).limit(1);
    return {
      key: user?.delegatePrivateKey ?? null,
      accountId: user?.delegateAccountId ?? null,
    };
  }

  const [user] = await db.select().from(users).where(eq(users.id, session.userId)).limit(1);
  return {
    key: user?.delegatePrivateKey ?? null,
    accountId: user?.delegateAccountId ?? null,
  };
}

export async function POST(req: Request) {
  try {
    const { text } = await req.json();

    if (!text || typeof text !== "string") {
      return Response.json({ error: "text is required" }, { status: 400 });
    }

    if (text.trim().length < 10) {
      return Response.json({ error: "Text too short to analyze" }, { status: 400 });
    }

    const { key, accountId } = await resolveUserKey(req);
    if (!key || !accountId) {
      return Response.json({ facts: [], count: 0 });
    }
    const facts = await extractMemories("noter", text, key, accountId);
    return Response.json({ facts, count: facts.length });
  } catch (error) {
    console.error("[memory/remember] Error:", error);
    return Response.json(
      { error: error instanceof Error ? error.message : "Unknown error" },
      { status: 500 },
    );
  }
}
