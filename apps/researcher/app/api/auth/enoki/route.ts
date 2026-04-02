import { createSession } from "@/lib/auth/session";
import {
  getUserBySuiAddress,
  createEnokiUser,
  updateEnokiUserCredentials,
} from "@/lib/db/queries";

const HEX_64_REGEX = /^[0-9a-f]{64}$/i;
const SUI_ADDRESS_REGEX = /^0x[0-9a-f]{10,}$/i;

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
    const { suiAddress, privateKey, publicKey, accountId } = body;

    if (!suiAddress || !SUI_ADDRESS_REGEX.test(suiAddress)) {
      return Response.json(
        { error: "Invalid Sui address." },
        { status: 400 },
      );
    }

    // Phase 1: Check — only suiAddress provided
    if (!privateKey && !publicKey && !accountId) {
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

    if (
      !publicKey ||
      typeof publicKey !== "string" ||
      !HEX_64_REGEX.test(publicKey)
    ) {
      return Response.json(
        { error: "Invalid public key. Expected 64 hex characters." },
        { status: 400 },
      );
    }

    if (!accountId || typeof accountId !== "string") {
      return Response.json(
        { error: "Account ID is required." },
        { status: 400 },
      );
    }

    // Check if user already exists by suiAddress (e.g. partial setup from before)
    const existing = await getUserBySuiAddress(suiAddress);

    if (existing) {
      // Update stored credentials
      await updateEnokiUserCredentials({
        userId: existing.id,
        publicKey,
        delegatePrivateKey: privateKey,
        accountId,
      });
      await createSession(existing.id, publicKey, privateKey, accountId);
    } else {
      // Create new user
      const created = await createEnokiUser({
        publicKey,
        suiAddress,
        delegatePrivateKey: privateKey,
        accountId,
      });
      await createSession(created.id, publicKey, privateKey, accountId);
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
