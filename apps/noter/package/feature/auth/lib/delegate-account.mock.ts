import * as ed from "@noble/ed25519";
import { sha512 } from "@noble/hashes/sha2.js";
import { toBase64 } from "@mysten/sui/utils";
import { enokiConfig } from "@/lib/enoki/config";

if (!ed.etc.sha512Sync) {
  ed.etc.sha512Sync = (...m: Uint8Array[]) => {
    const h = sha512.create();
    for (const msg of m) h.update(msg);
    return h.digest();
  };
}

function hex2(n: number): string {
  return n.toString(16).padStart(2, "0");
}

/**
 * Fixture identities for Playwright runs (lib/constants.ts isTestEnvironment).
 *
 * Noter's specs authenticate a fresh identity per test (unlike researcher's
 * two-identity, shared-storage-state design), so this is a pool, not a pair
 * — with `workers: 2` and ~15 login call sites, two fixed identities would
 * have tests colliding on each other's notes. Each entry is deterministic
 * (index N → accountId byte `N` repeated, privateKey byte `N + 0x40`
 * repeated) so the same 24 pairs regenerate identically here and in
 * tests/playwright/fixtures/delegate-key.ts — keep both in sync.
 *
 * Each account id maps to exactly one delegate private key, so the real
 * binding validation in delegate-account.ts still runs meaningfully against
 * the fabricated object: an unknown account id fails lookup, and a key that
 * doesn't derive the registered public key is rejected — the same failure
 * modes as the on-chain path.
 */
const FIXTURE_COUNT = 24;

const TEST_DELEGATE_ACCOUNTS: ReadonlyArray<{
  accountId: string;
  owner: string;
  privateKey: string;
}> = Array.from({ length: FIXTURE_COUNT }, (_, i) => ({
  accountId: `0x${hex2(i).repeat(32)}`,
  owner: `0x${hex2(i + 0x80).repeat(32)}`,
  privateKey: hex2(i + 0x40).repeat(32),
}));

function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

/**
 * Fabricated stand-in for the Sui gRPC getObject response, shaped exactly
 * like the fields delegate-account.ts validates. Returns null for account
 * ids outside the fixture list (the "object not found" case).
 *
 * public_key is base64, not hex: delegate-account.ts's publicKeyHex() parser
 * tries fromBase64() first and only falls back to a raw-hex check if that
 * throws — and every 64-char hex string (alphabet 0-9a-f, always
 * length-divisible-by-4) IS valid base64, just of the wrong bytes. Real gRPC
 * `include: { json: true }` responses base64-encode bytes fields (standard
 * protobuf JSON mapping), so this matches the real shape rather than
 * coincidentally working around the parser.
 */
export function mockDelegateAccountObject(
  accountId: string,
): { type: string; json: unknown } | null {
  const fixture = TEST_DELEGATE_ACCOUNTS.find(
    (account) => account.accountId.toLowerCase() === accountId.toLowerCase(),
  );
  if (!fixture) {
    return null;
  }

  const publicKey = toBase64(ed.getPublicKey(hexToBytes(fixture.privateKey)));
  return {
    type: `${enokiConfig.memwalPackageId}::account::MemWalAccount`,
    json: {
      owner: fixture.owner,
      active: true,
      delegate_keys: [{ public_key: publicKey }],
    },
  };
}
