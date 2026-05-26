/**
 * Memory Remember One API — saves a single approved memory text to Walrus Memory.
 * Used by the memory panel's "Approve" flow (individual memory saves).
 * Returns { id, blob_id, owner, namespace } for blockchain data display.
 */

import { rememberText } from "@/feature/note/lib/pdw-client";
import { db } from "@/shared/lib/db";
import { zkLoginSessions, walletSessions, users } from "@/shared/db/schema";
import { eq } from "drizzle-orm";

async function resolveUserKey(req: Request) {
  const sessionId = req.headers.get("x-session-id");
  if (!sessionId) return { key: null, accountId: null };

  const [session] = await db
    .select()
    .from(walletSessions)
    .where(eq(walletSessions.id, sessionId))
    .limit(1);

  if (!session?.userId || session.expiresAt < new Date()) {
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
      return Response.json({ error: "Text too short to remember" }, { status: 400 });
    }

    const { key, accountId } = await resolveUserKey(req);
    if ((!key || !accountId) && (!process.env.MEMWAL_PRIVATE_KEY || !process.env.MEMWAL_ACCOUNT_ID)) {
      return Response.json(
        { error: "[Walrus Memory] No accountId configured — sign in with Enoki or set MEMWAL_ACCOUNT_ID in .env" },
        { status: 401 },
      );
    }

    const result = await rememberText(text, key, accountId);
    return Response.json(result);
  } catch (error) {
    console.error("[memory/remember-one] Error:", error);
    return Response.json(
      { error: error instanceof Error ? error.message : "Unknown error" },
      { status: 500 },
    );
  }
}
