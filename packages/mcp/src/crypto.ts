/**
 * Ed25519 helpers — pure-JS via @noble/ed25519.
 */
import { getPublicKeyAsync, signAsync, utils } from "@noble/ed25519";
import { blake2b } from "@noble/hashes/blake2.js";

function hex(bytes: Uint8Array): string {
    return Array.from(bytes)
        .map((b) => b.toString(16).padStart(2, "0"))
        .join("");
}

function fromHex(s: string): Uint8Array {
    const clean = s.startsWith("0x") ? s.slice(2) : s;
    const out = new Uint8Array(clean.length / 2);
    for (let i = 0; i < out.length; i++) {
        out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
    }
    return out;
}

export interface Keypair {
    privateKeyHex: string; // 64 hex (32-byte seed)
    publicKeyHex: string;  // 64 hex (32-byte Ed25519 pub)
    suiAddress: string;    // 0x + 64 hex (blake2b-256 of [0x00 || pubkey])
}

/** Generate a fresh Ed25519 keypair and derive its Sui address. */
export async function generateKeypair(): Promise<Keypair> {
    const seed = utils.randomPrivateKey(); // 32 bytes
    const pub = await getPublicKeyAsync(seed);
    return {
        privateKeyHex: hex(seed),
        publicKeyHex: hex(pub),
        suiAddress: deriveSuiAddress(pub),
    };
}

/**
 * Sui Ed25519 address: blake2b-256(0x00 || pubkey).
 * The `0x00` is the Ed25519 scheme flag byte.
 */
export function deriveSuiAddress(pubKey: Uint8Array): string {
    const buf = new Uint8Array(1 + pubKey.length);
    buf[0] = 0x00;
    buf.set(pubKey, 1);
    const digest = blake2b.create({ dkLen: 32 }).update(buf).digest();
    return "0x" + hex(digest);
}

/**
 * Sign a canonical request message with a delegate private key.
 *
 * The relayer authenticates `/api/*` by Ed25519 signature over
 * `{timestamp}.{method}.{path_and_query}.{body_sha256}.{nonce}.{account_id}`
 * (`services/server/src/auth.rs`, which calls itself the single source of
 * truth for that format). Keep the two in lockstep.
 */
export async function signMessage(privateKeyHex: string, message: string): Promise<string> {
    const sig = await signAsync(new TextEncoder().encode(message), fromHex(privateKeyHex));
    return hex(sig);
}

export { hex as bytesToHex, fromHex as hexToBytes };
