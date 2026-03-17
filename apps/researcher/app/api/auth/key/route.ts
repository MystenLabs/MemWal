import { createSession } from "@/lib/auth/session";
import {
  getUserByPublicKey,
  createUserByPublicKey,
} from "@/lib/db/queries";
import * as ed from "@noble/ed25519";
import { sha512 } from "@noble/hashes/sha512";

if (!ed.etc.sha512Sync) {
  ed.etc.sha512Sync = (...m: Uint8Array[]) => {
    const h = sha512.create();
    for (const msg of m) h.update(msg);
    return h.digest();
  };
}

const PRIVATE_KEY_REGEX = /^[0-9a-f]{64}$/i;

function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export async function POST(request: Request) {
  try {
    const { privateKey } = await request.json();

    if (!privateKey || typeof privateKey !== "string" || !PRIVATE_KEY_REGEX.test(privateKey)) {
      return Response.json(
        { error: "Invalid private key. Expected 64 hex characters." },
        { status: 400 }
      );
    }

    const privKeyBytes = hexToBytes(privateKey);
    const pubKeyBytes = ed.getPublicKey(privKeyBytes);
    const publicKey = bytesToHex(pubKeyBytes);

    const existing = await getUserByPublicKey(publicKey);
    const user = existing ?? (await createUserByPublicKey(publicKey));

    await createSession(user.id, publicKey, privateKey);

    return Response.json({ success: true });
  } catch (error) {
    console.error("[auth:key] Error:", error);
    return Response.json({ error: "Authentication failed" }, { status: 500 });
  }
}
