import * as ed from "@noble/ed25519";
import { sha512 } from "@noble/hashes/sha2.js";
import { toBase64 } from "@mysten/sui/utils";
import { enokiConfig } from "@/lib/enoki/config";
import { findDelegateFixture } from "./delegate-fixtures";

if (!ed.etc.sha512Sync) {
  ed.etc.sha512Sync = (...m: Uint8Array[]) => {
    const h = sha512.create();
    for (const msg of m) h.update(msg);
    return h.digest();
  };
}

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
 * ids outside the shared fixture pool (the "object not found" case).
 *
 * public_key is base64 to match real gRPC `include: { json: true }`
 * responses (standard protobuf JSON mapping for bytes). The parser now
 * accepts hex as well; base64 here is about matching production shape,
 * not working around the decoder.
 */
export function mockDelegateAccountObject(
  accountId: string,
): { type: string; json: unknown } | null {
  const fixture = findDelegateFixture(accountId);
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
