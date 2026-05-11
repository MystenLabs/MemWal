/**
 * Credentials persistence — `~/.memwal/credentials.json`.
 *
 * The file is created with mode `0600` so it's only readable by the owning
 * user; the delegate private key inside is sensitive (compromise lets an
 * attacker write/read the user's memories until revoked from the
 * dashboard).
 *
 * Format mirrors Walcraft's `credentials.json` so existing tooling +
 * documentation patterns transfer cleanly.
 */
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { mkdirSync, readFileSync, writeFileSync, chmodSync, unlinkSync, existsSync } from "node:fs";

export interface MemWalCredentials {
    /** 64-hex Ed25519 private key seed (32 bytes). NEVER log this. */
    delegatePrivateKey: string;
    /** 64-hex Ed25519 public key derived from the seed. Safe to display. */
    delegatePublicKeyHex: string;
    /** 0x-prefixed 64-hex Sui address derived from the delegate public key. */
    delegateAddress: string;
    /** 0x-prefixed Sui wallet address that signed the add_delegate_key tx. */
    walletAddress: string;
    /** 0x-prefixed MemWalAccount object id this delegate is registered against. */
    accountId: string;
    /** 0x-prefixed MemWal package id the account lives in. */
    packageId: string;
    /** Relayer base URL the bridge should connect to. */
    relayerUrl: string;
    /** Human-readable label, e.g. "Cursor MCP" — surfaced in dashboard. */
    label?: string;
    /** ISO timestamp credentials were saved. */
    createdAt: string;
    /** Schema version — bump when we change shape. */
    version: 1;
}

const CREDS_DIR = join(homedir(), ".memwal");
const CREDS_PATH = join(CREDS_DIR, "credentials.json");

export function credsPath(): string {
    return CREDS_PATH;
}

/** Load credentials from disk. Returns null if missing or malformed. */
export function loadCreds(): MemWalCredentials | null {
    if (!existsSync(CREDS_PATH)) return null;
    try {
        const raw = readFileSync(CREDS_PATH, "utf8");
        const parsed = JSON.parse(raw);
        if (!isValid(parsed)) return null;
        return parsed as MemWalCredentials;
    } catch {
        return null;
    }
}

/** Write credentials with secure (`0600`) permission. */
export function saveCreds(creds: MemWalCredentials): void {
    mkdirSync(dirname(CREDS_PATH), { recursive: true, mode: 0o700 });
    writeFileSync(CREDS_PATH, JSON.stringify(creds, null, 2), { encoding: "utf8", mode: 0o600 });
    // writeFileSync's `mode` argument is only honored on file creation; ensure
    // the permission on an existing file matches.
    try {
        chmodSync(CREDS_PATH, 0o600);
    } catch {
        /* Windows etc. — best effort */
    }
}

/** Delete credentials. No-op if the file does not exist. */
export function clearCreds(): void {
    if (existsSync(CREDS_PATH)) {
        try {
            unlinkSync(CREDS_PATH);
        } catch {
            /* swallow */
        }
    }
}

function isValid(obj: unknown): obj is MemWalCredentials {
    if (!obj || typeof obj !== "object") return false;
    const c = obj as Record<string, unknown>;
    return (
        typeof c.delegatePrivateKey === "string" &&
        /^[0-9a-fA-F]{64}$/.test(c.delegatePrivateKey) &&
        typeof c.delegatePublicKeyHex === "string" &&
        typeof c.delegateAddress === "string" &&
        typeof c.walletAddress === "string" &&
        typeof c.accountId === "string" &&
        /^0x[0-9a-fA-F]{64}$/.test(c.accountId) &&
        typeof c.packageId === "string" &&
        typeof c.relayerUrl === "string" &&
        typeof c.createdAt === "string" &&
        c.version === 1
    );
}
