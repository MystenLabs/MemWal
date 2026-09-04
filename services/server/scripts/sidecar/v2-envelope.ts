/**
 * MEMWALV2 envelope (D3) and canonical 40-byte Seal suffix.
 */

import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { blake2b } from "@noble/hashes/blake2.js";
import { normalizeSuiAddress } from "@mysten/sui/utils";

export const MEMWAL_V2_MAGIC = Buffer.from("MEMWALV2");
export const MEMWAL_V2_VERSION = 1;
const NONCE_LEN = 12;
const TAG_LEN = 16;

export function objectIdBytes(id: string): Uint8Array {
    const hex = normalizeSuiAddress(id).slice(2);
    return Buffer.from(hex, "hex");
}

export function u64Le(value: bigint | number): Buffer {
    const buf = Buffer.alloc(8);
    buf.writeBigUInt64LE(BigInt(value));
    return buf;
}

/** Canonical Seal suffix: BCS(namespace_id) || BCS(key_version u64 LE) — 40 bytes. */
export function namespaceSealKeyId(namespaceId: string, keyVersion: bigint | number): Uint8Array {
    const id = objectIdBytes(namespaceId);
    const version = u64Le(keyVersion);
    const out = new Uint8Array(40);
    out.set(id, 0);
    out.set(version, 32);
    return out;
}

export function namespaceSealKeyIdHex(namespaceId: string, keyVersion: bigint | number): string {
    return Buffer.from(namespaceSealKeyId(namespaceId, keyVersion)).toString("hex");
}

export function envelopeAad(namespaceId: Uint8Array, keyVersionLe: Uint8Array): Buffer {
    return Buffer.concat([MEMWAL_V2_MAGIC, Buffer.from(namespaceId), Buffer.from(keyVersionLe)]);
}

export function blake2b256(data: Uint8Array): Buffer {
    return Buffer.from(blake2b(data, { dkLen: 32 }));
}

export function decodeWalrusBlobIdLe(blobId: string): Buffer {
    const bytes = Buffer.from(blobId, "base64url");
    if (bytes.length !== 32) {
        throw new Error("blob_id must decode to 32 bytes");
    }
    return bytes;
}

export function writeCommitmentV1(input: {
    namespaceId: string;
    keyVersion: bigint | number;
    blobId: string;
    blobObjectId?: string | null;
    envelope: Uint8Array;
}): Buffer {
    const blobObject = input.blobObjectId
        ? Buffer.from(objectIdBytes(input.blobObjectId))
        : Buffer.alloc(32);
    const preimage = Buffer.concat([
        Buffer.from("memwal.v2.write_commitment.v1"),
        Buffer.from([0x00]),
        Buffer.from(objectIdBytes(input.namespaceId)),
        u64Le(input.keyVersion),
        decodeWalrusBlobIdLe(input.blobId),
        blobObject,
        blake2b256(input.envelope),
    ]);
    return blake2b256(preimage);
}

export function encodeMemwalV2Envelope(input: {
    dek: Uint8Array;
    plaintext: Uint8Array;
    namespaceId: string;
    keyVersion: bigint | number;
    nonce?: Uint8Array;
}): { envelope: Buffer; ciphertextDigest: Buffer } {
    if (input.dek.length !== 32) {
        throw new Error("DEK must be 32 bytes");
    }
    const namespaceId = objectIdBytes(input.namespaceId);
    const keyVersionLe = u64Le(input.keyVersion);
    const nonce = input.nonce ? Buffer.from(input.nonce) : randomBytes(NONCE_LEN);
    if (nonce.length !== NONCE_LEN) {
        throw new Error("nonce must be 12 bytes");
    }
    const aad = envelopeAad(namespaceId, keyVersionLe);
    const cipher = createCipheriv("aes-256-gcm", Buffer.from(input.dek), nonce);
    cipher.setAAD(aad);
    const encrypted = Buffer.concat([cipher.update(Buffer.from(input.plaintext)), cipher.final()]);
    const tag = cipher.getAuthTag();
    const ciphertext = Buffer.concat([encrypted, tag]);
    if (tag.length !== TAG_LEN) {
        throw new Error("GCM tag must be 16 bytes");
    }
    const ctLen = Buffer.alloc(4);
    ctLen.writeUInt32LE(ciphertext.length);
    const envelope = Buffer.concat([
        MEMWAL_V2_MAGIC,
        Buffer.from([MEMWAL_V2_VERSION]),
        Buffer.from(namespaceId),
        keyVersionLe,
        nonce,
        ctLen,
        ciphertext,
    ]);
    return { envelope, ciphertextDigest: blake2b256(envelope) };
}

export function decodeMemwalV2Envelope(input: {
    dek: Uint8Array;
    envelope: Uint8Array;
}): Buffer {
    if (input.dek.length !== 32) {
        throw new Error("DEK must be 32 bytes");
    }
    const buf = Buffer.from(input.envelope);
    const header = 8 + 1 + 32 + 8 + NONCE_LEN + 4;
    if (buf.length < header + TAG_LEN) {
        throw new Error("MEMWALV2 envelope is truncated");
    }
    if (!buf.subarray(0, 8).equals(MEMWAL_V2_MAGIC)) {
        throw new Error("envelope magic is not MEMWALV2");
    }
    const version = buf[8];
    if (version !== MEMWAL_V2_VERSION) {
        throw new Error(`unsupported MEMWALV2 version ${version}`);
    }
    const namespaceId = buf.subarray(9, 41);
    const keyVersionLe = buf.subarray(41, 49);
    const nonce = buf.subarray(49, 61);
    const ctLen = buf.readUInt32LE(61);
    const ciphertext = buf.subarray(65);
    if (ciphertext.length !== ctLen) {
        throw new Error("MEMWALV2 ciphertext length mismatch");
    }
    const tag = ciphertext.subarray(ciphertext.length - TAG_LEN);
    const encrypted = ciphertext.subarray(0, ciphertext.length - TAG_LEN);
    const decipher = createDecipheriv("aes-256-gcm", Buffer.from(input.dek), nonce);
    decipher.setAAD(envelopeAad(namespaceId, keyVersionLe));
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(encrypted), decipher.final()]);
}
