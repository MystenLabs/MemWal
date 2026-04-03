import { getSession } from "@/lib/auth/session";

/** POST /api/auth/profile/export-key — Returns the delegate private key from the active session. Requires authentication. */
export async function POST() {
  const session = await getSession();
  if (!session?.user?.privateKey) {
    return Response.json({ error: "Not authenticated" }, { status: 401 });
  }

  return Response.json({
    privateKey: session.user.privateKey,
    accountId: session.user.accountId,
  });
}
