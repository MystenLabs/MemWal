import * as ed from "@noble/ed25519";
import { sha512 } from "@noble/hashes/sha512";
import { enokiConfig } from "@/lib/enoki/config";

if (!ed.etc.sha512Sync) {
  ed.etc.sha512Sync = (...m: Uint8Array[]) => {
    const h = sha512.create();
    for (const msg of m) h.update(msg);
    return h.digest();
  };
}

/**
 * Fixture identities for Playwright runs (lib/constants.ts isTestEnvironment).
 *
 * Each account id maps to exactly one delegate private key, so the real
 * binding validation in delegate-account.ts still runs meaningfully against
 * the fabricated object: an unknown account id fails lookup, and a key that
 * doesn't derive the registered public key is rejected — the same failure
 * modes as the on-chain path.
 *
 * Mirrored in tests/playwright/fixtures/test-accounts.ts — keep in sync.
 */
const TEST_DELEGATE_ACCOUNTS: ReadonlyArray<{
  accountId: string;
  privateKey: string;
}> = [
  { accountId: `0x${"aa".repeat(32)}`, privateKey: "a".repeat(64) },
  { accountId: `0x${"bb".repeat(32)}`, privateKey: "b".repeat(64) },
];

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
 * Fabricated stand-in for the Sui gRPC getObject response, shaped exactly
 * like the fields delegate-account.ts validates. Returns null for account
 * ids outside the fixture list (the "object not found" case).
 */
export function mockDelegateAccountObject(
  accountId: string
): { type: string; json: unknown } | null {
  const fixture = TEST_DELEGATE_ACCOUNTS.find(
    (account) => account.accountId.toLowerCase() === accountId.toLowerCase()
  );
  if (!fixture) {
    return null;
  }

  const publicKey = bytesToHex(ed.getPublicKey(hexToBytes(fixture.privateKey)));
  return {
    type: `${enokiConfig.memwalPackageId}::account::MemWalAccount`,
    json: {
      active: true,
      delegate_keys: [{ public_key: publicKey }],
    },
  };
}
