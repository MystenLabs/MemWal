import { createSession } from "@/lib/auth/session";
import { upsertDelegateCredentialsByPublicKey } from "@/lib/db/queries";
import * as ed from "@noble/ed25519";
import { sha512 } from "@noble/hashes/sha512";
import {
  assertDelegateAccountBinding,
  DelegateAccountBindingError,
} from "@/lib/auth/delegate-account";
import { isSameOriginRequest } from "@/lib/auth/request-security";
import { AuthRateLimitError, checkAuthRateLimit } from "@/lib/ratelimit";

if (!ed.etc.sha512Sync) {
  ed.etc.sha512Sync = (...m: Uint8Array[]) => {
    const h = sha512.create();
    for (const msg of m) h.update(msg);
    return h.digest();
  };
}

const PRIVATE_KEY_REGEX = /^[0-9a-f]{64}$/i;
const ACCOUNT_ID_REGEX = /^0x[0-9a-f]{64}$/i;

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
  if (!isSameOriginRequest(request)) {
    return Response.json({ error: "Invalid request origin" }, { status: 403 });
  }

  try {
    await checkAuthRateLimit(request, "verify");
    const { privateKey, accountId } = await request.json();

    if (!privateKey || typeof privateKey !== "string" || !PRIVATE_KEY_REGEX.test(privateKey)) {
      return Response.json(
        { error: "Invalid private key. Expected 64 hex characters." },
        { status: 400 }
      );
    }

    const privKeyBytes = hexToBytes(privateKey);
    const pubKeyBytes = ed.getPublicKey(privKeyBytes);
    const publicKey = bytesToHex(pubKeyBytes);

    if (
      !accountId ||
      typeof accountId !== "string" ||
      !ACCOUNT_ID_REGEX.test(accountId)
    ) {
      return Response.json(
        { error: "Valid account ID is required (0x... format)." },
        { status: 400 }
      );
    }

    // Manual login has no wallet owner, but the account must still be active,
    // from the configured package, and contain this derived delegate key.
    await assertDelegateAccountBinding({ accountId, publicKeyHex: publicKey });

    const user = await upsertDelegateCredentialsByPublicKey({
      publicKey,
      delegatePrivateKey: privateKey,
      accountId,
    });

    await createSession(user.id, publicKey, accountId);

    return Response.json({ success: true });
  } catch (error) {
    if (error instanceof DelegateAccountBindingError) {
      return Response.json({ error: error.message }, { status: 401 });
    }
    if (error instanceof AuthRateLimitError) {
      return Response.json(
        {
          error:
            error.status === 429
              ? "Too many authentication requests"
              : "Authentication service temporarily unavailable",
        },
        {
          headers: { "Retry-After": error.status === 429 ? "60" : "5" },
          status: error.status,
        }
      );
    }
    console.error("[auth:key] Error:", error);
    return Response.json({ error: "Authentication failed" }, { status: 500 });
  }
}
