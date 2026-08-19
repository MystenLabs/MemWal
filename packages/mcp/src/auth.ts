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
import {
    mkdirSync,
    readFileSync,
    writeFileSync,
    chmodSync,
    unlinkSync,
    existsSync,
    copyFileSync,
} from "node:fs";

export interface MemWalCredentials {
    /** 64-hex Ed25519 private key seed (32 bytes). NEVER log this. */
    delegatePrivateKey: string;
    /** 64-hex Ed25519 public key derived from the seed. Safe to display. */
    delegatePublicKeyHex: string;
    /** 0x-prefixed 64-hex Sui address derived from the delegate public key. */
    delegateAddress: string;
    /** 0x-prefixed Sui wallet address that signed the add_delegate_key tx. */
    walletAddress: string;
    /** 0x-prefixed Walrus Memory account object id this delegate is registered against. */
    accountId: string;
    /** 0x-prefixed Walrus Memory package id the account lives in. */
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

const CREDS_FILE = "credentials.json";

/** Global, per-machine location. Always the fallback, and the only location
 * before project-scoping existed — a machine with no project-local file keeps
 * behaving exactly as it did. */
function globalCredsPath(): string {
    return join(homedir(), ".memwal", CREDS_FILE);
}

/** Working-directory location, checked first. */
function projectCredsPath(): string {
    return join(process.cwd(), ".memwal", CREDS_FILE);
}

/**
 * Which credentials file this process should read and write.
 *
 * A project-local `.memwal/credentials.json` wins over the global one, the way
 * `.npmrc` and `.git/config` resolve. Signing in from one project otherwise
 * repoints every other project on the machine at a different account and
 * delegate key, silently — memories then land on the wrong account, on
 * immutable storage, with no delete path (GH #628).
 *
 * Presence-based on purpose: creating the local file is the opt-in, so this is
 * purely additive. Resolved per call rather than at module load, because the
 * working directory is not knowable at import time.
 */
export function credsPath(): string {
    const project = projectCredsPath();
    return existsSync(project) ? project : globalCredsPath();
}

/** Load credentials from disk. Returns null if missing or malformed. */
export function loadCreds(): MemWalCredentials | null {
    const path = credsPath();
    if (!existsSync(path)) return null;
    try {
        const raw = readFileSync(path, "utf8");
        const parsed = JSON.parse(raw);
        if (!isValid(parsed)) return null;
        return parsed as MemWalCredentials;
    } catch {
        return null;
    }
}

/**
 * Write credentials with secure (`0600`) permission, to whichever file
 * `credsPath()` resolves to.
 *
 * Replacing a *different* account backs the outgoing file up first. There was
 * no backup of any kind before, so an overwrite was unrecoverable — and the
 * overwrite that matters is exactly the one that switches accounts (GH #628).
 * Same-account rewrites (a label change, a rotated delegate) are not backed up:
 * they are routine, and a backup per login would just churn the directory.
 */
export function saveCreds(creds: MemWalCredentials): SaveCredsResult {
    const path = credsPath();
    const replaced = backupIfReplacingAnotherAccount(path, creds.accountId);
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    writeFileSync(path, JSON.stringify(creds, null, 2), { encoding: "utf8", mode: 0o600 });
    // writeFileSync's `mode` argument is only honored on file creation; ensure
    // the permission on an existing file matches.
    try {
        chmodSync(path, 0o600);
    } catch {
        /* Windows etc. — best effort */
    }
    return { path, ...replaced };
}

/** What `saveCreds` did, so the caller can tell the user precisely — naming
 * both accounts is the difference between a warning they can act on and the
 * silent swap reported in GH #628. */
export interface SaveCredsResult {
    /** File actually written (project-local or global). */
    path: string;
    /** Account whose credentials were displaced. Absent on a first sign-in or
     * a same-account re-save. */
    replacedAccountId?: string;
    /** Where the displaced file was copied. Absent when nothing was replaced,
     * or when the copy failed. */
    backedUpTo?: string;
}

/** Copy the current credentials aside when the incoming ones belong to a
 * different account. Best effort: failing to back up must not block a login. */
function backupIfReplacingAnotherAccount(
    path: string,
    incomingAccountId: string,
): { replacedAccountId?: string; backedUpTo?: string } {
    if (!existsSync(path)) return {};
    const current = loadCreds();
    if (!current || current.accountId === incomingAccountId) return {};
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const backup = join(dirname(path), `credentials.backup-${stamp}.json`);
    try {
        copyFileSync(path, backup);
        chmodSync(backup, 0o600);
        return { replacedAccountId: current.accountId, backedUpTo: backup };
    } catch {
        // Never block sign-in on a failed backup — but still report the
        // replacement, since that is the part the user needs to know.
        return { replacedAccountId: current.accountId };
    }
}

/** Delete credentials. No-op if the file does not exist. */
export function clearCreds(): void {
    const path = credsPath();
    if (existsSync(path)) {
        try {
            unlinkSync(path);
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
