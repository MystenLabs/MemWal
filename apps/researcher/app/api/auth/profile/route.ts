import { getSession } from "@/lib/auth/session";
import { getUserById } from "@/lib/db/queries";

/** GET /api/auth/profile — Returns the authenticated user's profile data including auth method and MemWal account info. */
export async function GET() {
  const session = await getSession();
  if (!session?.user) {
    return Response.json({ error: "Not authenticated" }, { status: 401 });
  }

  const dbUser = await getUserById(session.user.id);
  if (!dbUser) {
    return Response.json({ error: "User not found" }, { status: 404 });
  }

  return Response.json({
    id: dbUser.id,
    email: dbUser.email,
    publicKey: dbUser.publicKey,
    suiAddress: dbUser.suiAddress ?? null,
    accountId: dbUser.accountId ?? session.user.accountId ?? null,
    authMethod: dbUser.suiAddress ? "enoki" : "key",
    hasPrivateKey: !!session.user.privateKey,
  });
}
