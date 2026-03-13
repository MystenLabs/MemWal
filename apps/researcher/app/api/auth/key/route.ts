import { createSession } from "@/lib/auth/session";
import {
  getUserByPublicKey,
  createUserByPublicKey,
} from "@/lib/db/queries";

const PUBLIC_KEY_REGEX = /^[0-9a-f]{64}$/i;

export async function POST(request: Request) {
  try {
    const { publicKey } = await request.json();

    if (!publicKey || typeof publicKey !== "string" || !PUBLIC_KEY_REGEX.test(publicKey)) {
      return Response.json(
        { error: "Invalid public key. Expected 64 hex characters." },
        { status: 400 }
      );
    }

    const existing = await getUserByPublicKey(publicKey);
    const user = existing ?? (await createUserByPublicKey(publicKey));

    await createSession(user.id, publicKey);

    return Response.json({ success: true });
  } catch (error) {
    console.error("[auth:key] Error:", error);
    return Response.json({ error: "Authentication failed" }, { status: 500 });
  }
}
