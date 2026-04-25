import { createSession } from "@/lib/auth/session";
import {
  getUserBySuiAddress,
  createEnokiUser,
  updateEnokiUserCredentials,
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

const HEX_64_REGEX = /^[0-9a-f]{64}$/i;
const SUI_ADDRESS_REGEX = /^0x[0-9a-f]{64}$/i;

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

/**
 * POST /api/auth/enoki
 *
 * Two-phase Enoki login:
 * - Phase 1 (check): { suiAddress } → returns existing user or needsSetup
 * - Phase 2 (register): { suiAddress, privateKey, publicKey, accountId } → creates/updates user + session
 */
export async function POST(request: Request) {
  try {
    const body = await request.json();
    const { suiAddress, privateKey, accountId } = body;

    if (!suiAddress || !SUI_ADDRESS_REGEX.test(suiAddress)) {
      return Response.json(
        { error: "Invalid Sui address." },
        { status: 400 },
      );
    }

    // Phase 1: Check — only suiAddress provided
    if (!privateKey && !accountId) {
      const existing = await getUserBySuiAddress(suiAddress);

      if (existing?.delegatePrivateKey && existing?.publicKey && existing?.accountId) {
        // Returning user — recreate session from stored credentials
        await createSession(
          existing.id,
          existing.publicKey,
          existing.delegatePrivateKey,
          existing.accountId,
        );
        return Response.json({ success: true, needsSetup: false });
      }

      // No stored credentials — client needs to generate key + register on-chain
      return Response.json({ success: true, needsSetup: true });
    }

    // Phase 2: Register — full credentials provided
    if (
      !privateKey ||
      typeof privateKey !== "string" ||
      !HEX_64_REGEX.test(privateKey)
    ) {
      return Response.json(
        { error: "Invalid private key. Expected 64 hex characters." },
        { status: 400 },
      );
    }

    if (!accountId || typeof accountId !== "string" || !SUI_ADDRESS_REGEX.test(accountId)) {
      return Response.json(
        { error: "Valid account ID is required (0x... format)." },
        { status: 400 },
      );
    }

    // Derive publicKey server-side from privateKey (don't trust client-submitted publicKey)
    const privKeyBytes = hexToBytes(privateKey);
    const derivedPubKeyBytes = ed.getPublicKey(privKeyBytes);
    const derivedPublicKey = bytesToHex(derivedPubKeyBytes);

    // Check if user already exists by suiAddress (e.g. partial setup from before)
    const existing = await getUserBySuiAddress(suiAddress);

    if (existing) {
      // Update stored credentials
      await updateEnokiUserCredentials({
        userId: existing.id,
        publicKey: derivedPublicKey,
        delegatePrivateKey: privateKey,
        accountId,
      });
      await createSession(existing.id, derivedPublicKey, privateKey, accountId);
    } else {
      // Create new user
      const created = await createEnokiUser({
        publicKey: derivedPublicKey,
        suiAddress,
        delegatePrivateKey: privateKey,
        accountId,
      });
      await createSession(created.id, derivedPublicKey, privateKey, accountId);
    }

    return Response.json({ success: true, needsSetup: false });
  } catch (error) {
    console.error("[auth:enoki] Error:", error);
    return Response.json(
      { error: "Authentication failed" },
      { status: 500 },
    );
  }
}
