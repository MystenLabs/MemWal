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
import { createHash, randomUUID } from "node:crypto";
import { join, dirname, basename } from "node:path";
import {
    mkdirSync,
    readFileSync,
    writeFileSync,
    renameSync,
    unlinkSync,
    existsSync,
    realpathSync,
} from "node:fs";
import { log } from "./logger.js";

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

/**
 * Nearest project-local location: the working directory, then each ancestor.
 *
 * Walking up is what makes the `.npmrc` / `.git/config` comparison true, and it
 * is load-bearing rather than cosmetic. A shell that has `cd src`, or an MCP
 * host launched with its cwd somewhere below the project root, would otherwise
 * miss the project file and silently fall back to the global account — the
 * exact swap GH #628 is about, just one directory deeper.
 *
 * The walk is bounded at the project root, the home directory, or the
 * filesystem root, whichever comes first. Returns null when nothing inside
 * those bounds carries a credentials file.
 */
function projectCredsPath(): string | null {
    const home = homedir();
    const global = globalCredsPath();
    let dir = process.cwd();
    for (;;) {
        // The home directory is where the *global* file lives. Matching it here
        // would relabel it project-local and invert the precedence this whole
        // function exists to establish.
        if (dir === home) return null;

        const candidate = join(dir, ".memwal", CREDS_FILE);
        if (candidate !== global && existsSync(candidate)) return candidate;

        // Stop at the project root. `.git/config` resolution ends here too, and
        // bounding the walk is what keeps it from climbing out of the project
        // into shared parents — including the real home directory, which is
        // reachable from a working directory that is not underneath it (any
        // test that overrides HOME, for one).
        if (existsSync(join(dir, ".git"))) return null;

        const parent = dirname(dir);
        if (parent === dir) return null; // filesystem root
        dir = parent;
    }
}

/* ------------------------------------------------------------------------- *
 * Project credentials are opt-IN, per machine (WALM-639).
 *
 * Presence alone used to be the opt-in: a `.memwal/credentials.json` anywhere
 * at or above the working directory simply won. But that file is INSIDE the
 * repository, so anyone who can commit to a repo — or persuade someone to
 * clone one — could choose the account and the relayer every memory written
 * from that directory goes to. Opening a project silently repointed the
 * destination, and the writes land on immutable storage with no delete path.
 *
 * So a project file is now inert until the user approves that exact file,
 * account, delegate and relayer. The approval record lives beside the GLOBAL
 * credentials, never in the repository, because a record a repository can
 * carry is a repository approving itself.
 * ------------------------------------------------------------------------- */

const APPROVALS_FILE = "project-approvals.json";

/**
 * Where records that a repository must not be able to write are kept.
 *
 * `MEMWAL_CREDS_DIR` is the trusted escape hatch — when it is set it decides
 * the credentials outright and project resolution never runs — so following it
 * here keeps a sandboxed run (tests, CI) from reaching into the real
 * `~/.memwal`, exactly as #705 required for the credentials file itself.
 */
function trustedStateDir(): string {
    return process.env.MEMWAL_CREDS_DIR ?? join(homedir(), ".memwal");
}

/** The approval store. Outside every repository, on purpose. */
export function projectApprovalsPath(): string {
    return join(trustedStateDir(), APPROVALS_FILE);
}

/**
 * What approval is granted against: the destination, not the file's bytes.
 *
 * Account, delegate and relayer are the three fields that decide WHERE a
 * memory ends up and WHO signs for it. Hashing them means a project file may
 * be re-saved, relabelled or reformatted freely, while any edit that moves the
 * destination invalidates the approval and has to be approved again. The
 * delegate private key is deliberately NOT part of it — it must never be read
 * into a record that gets written back out.
 */
export function credentialsFingerprint(creds: {
    accountId: string;
    delegateAddress: string;
    relayerUrl: string;
}): string {
    return createHash("sha256")
        .update(`${creds.accountId}\n${creds.delegateAddress}\n${creds.relayerUrl}`)
        .digest("hex");
}

/** One approved project credentials file. Contains no secret. */
export interface ProjectApproval {
    /** Canonical path of the approved `.memwal/credentials.json`. */
    path: string;
    fingerprint: string;
    accountId: string;
    delegateAddress: string;
    relayerUrl: string;
    approvedAt: string;
}

interface ApprovalsFile {
    version: 1;
    approvals: ProjectApproval[];
}

/** Compare paths the way the filesystem does. `process.cwd()` reports a
 * resolved path and an approval may have been recorded through a symlink (or
 * on macOS, `/tmp` → `/private/tmp`), so both sides go through this. */
function canonicalPath(path: string): string {
    try {
        return realpathSync(path);
    } catch {
        return path;
    }
}

function isValidApproval(obj: unknown): obj is ProjectApproval {
    if (!obj || typeof obj !== "object") return false;
    const a = obj as Record<string, unknown>;
    return (
        typeof a.path === "string" &&
        typeof a.fingerprint === "string" &&
        typeof a.accountId === "string" &&
        typeof a.delegateAddress === "string" &&
        typeof a.relayerUrl === "string"
    );
}

/** Approvals on record. A missing, malformed or unreadable store approves
 * nothing — the safe direction, since the consequence is falling back to the
 * user's own global account rather than adopting someone else's. */
function loadApprovals(): ProjectApproval[] {
    const path = projectApprovalsPath();
    if (!existsSync(path)) return [];
    try {
        const parsed = JSON.parse(readFileSync(path, "utf8")) as ApprovalsFile;
        if (!parsed || parsed.version !== 1 || !Array.isArray(parsed.approvals)) return [];
        return parsed.approvals.filter(isValidApproval);
    } catch {
        return [];
    }
}

/** Through the same writer as the credentials file: it creates the directory
 * at `0700` and the file at `0600`. The record holds no secret, but it decides
 * where memories go, so it should not be writable by anything that could not
 * already write the credentials beside it. */
function saveApprovals(approvals: ProjectApproval[]): void {
    writeSecretFile(
        projectApprovalsPath(),
        JSON.stringify({ version: 1, approvals } satisfies ApprovalsFile, null, 2),
    );
}

/** Why a project credentials file was, or was not, used. */
export type ProjectCredsDecision =
    /** Approved for exactly this account + delegate + relayer: in use. */
    | "approved"
    /** Never approved on this machine. Ignored. */
    | "unapproved"
    /** Approved once, but the destination has since changed. Ignored. */
    | "changed"
    /** Present but not valid credentials, so there is nothing to approve. */
    | "unreadable";

export interface ProjectCredsInfo {
    /** The project-local file that was found. */
    path: string;
    decision: ProjectCredsDecision;
    /** Destination it points at. Absent when the file could not be read — and
     * never the delegate private key, which no caller of this ever needs. */
    accountId?: string;
    relayerUrl?: string;
}

/** Which file won, and what happened to any project-local file that did not. */
export interface CredsResolution {
    /** The file this process reads and writes. */
    path: string;
    source: "override" | "project" | "global";
    /** The project-local file found by the walk, if any — present whether or
     * not it was used, so callers can report one they ignored. */
    project?: ProjectCredsInfo;
}

/**
 * Which credentials file this process should read and write, and why.
 *
 * `MEMWAL_CREDS_DIR` wins outright: it is the trusted, explicitly-set escape
 * hatch and cannot come from a checkout. Otherwise the nearest project-local
 * `.memwal/credentials.json` at or above the working directory is used IF the
 * user has approved that exact destination on this machine (WALM-639), and the
 * global file is used in every other case — including an unapproved, altered
 * or malformed project file. Falling back rather than failing keeps a machine
 * that has never seen a project file behaving exactly as it always did.
 *
 * Resolved per call rather than at module load, because neither the working
 * directory nor the approval store is knowable at import time.
 */
export function resolveCreds(): CredsResolution {
    const override = process.env.MEMWAL_CREDS_DIR;
    if (override) return { path: join(override, CREDS_FILE), source: "override" };

    const global = globalCredsPath();
    const projectPath = projectCredsPath();
    if (!projectPath) return { path: global, source: "global" };

    const project = readCredsFile(projectPath);
    if (!project) {
        return {
            path: global,
            source: "global",
            project: { path: projectPath, decision: "unreadable" },
        };
    }

    const approval = loadApprovals().find((a) => a.path === canonicalPath(projectPath));
    const decision: ProjectCredsDecision = !approval
        ? "unapproved"
        : approval.fingerprint === credentialsFingerprint(project)
          ? "approved"
          : "changed";
    const info: ProjectCredsInfo = {
        path: projectPath,
        decision,
        accountId: project.accountId,
        relayerUrl: project.relayerUrl,
    };
    return decision === "approved"
        ? { path: projectPath, source: "project", project: info }
        : { path: global, source: "global", project: info };
}

/** The credentials file in use. Thin wrapper over {@link resolveCreds} so the
 * many callers that only need a path are unchanged. */
export function credsPath(): string {
    return resolveCreds().path;
}

/** Read and validate one credentials file. Returns null if missing or
 * malformed — the caller decides what that means. */
function readCredsFile(path: string): MemWalCredentials | null {
    if (!existsSync(path)) return null;
    try {
        const parsed = JSON.parse(readFileSync(path, "utf8"));
        if (!isValid(parsed)) return null;
        return parsed as MemWalCredentials;
    } catch {
        return null;
    }
}

/** Load credentials from disk. Returns null if missing or malformed. */
export function loadCreds(): MemWalCredentials | null {
    return readCredsFile(credsPath());
}

/** What {@link approveProjectCreds} did. */
export interface ApproveProjectResult {
    outcome:
        /** Newly approved. */
        | "approved"
        /** Approved again after the destination changed. */
        | "reapproved"
        /** Already approved for this exact destination; nothing written. */
        | "already-approved"
        /** No project-local credentials file at or above the working directory. */
        | "none"
        /** A project file exists but is not valid credentials. */
        | "unreadable"
        /** `MEMWAL_CREDS_DIR` is set, so project resolution never runs. */
        | "overridden";
    projectPath?: string;
    accountId?: string;
    relayerUrl?: string;
    /** Destination the previous approval covered, when this replaced one. */
    previousAccountId?: string;
    previousRelayerUrl?: string;
    approvalsPath: string;
}

/**
 * Approve the project-local credentials found from the working directory.
 *
 * Deliberately takes no arguments: it approves what resolution would otherwise
 * ignore, from the same directory, so "what am I approving" and "what will be
 * used" cannot drift apart.
 */
export function approveProjectCreds(): ApproveProjectResult {
    const approvalsPath = projectApprovalsPath();
    if (process.env.MEMWAL_CREDS_DIR) return { outcome: "overridden", approvalsPath };

    const projectPath = projectCredsPath();
    if (!projectPath) return { outcome: "none", approvalsPath };
    const creds = readCredsFile(projectPath);
    if (!creds) return { outcome: "unreadable", projectPath, approvalsPath };

    const key = canonicalPath(projectPath);
    const fingerprint = credentialsFingerprint(creds);
    const approvals = loadApprovals();
    const existing = approvals.find((a) => a.path === key);
    if (existing?.fingerprint === fingerprint) {
        return {
            outcome: "already-approved",
            projectPath,
            accountId: creds.accountId,
            relayerUrl: creds.relayerUrl,
            approvalsPath,
        };
    }

    saveApprovals([
        ...approvals.filter((a) => a.path !== key),
        {
            path: key,
            fingerprint,
            accountId: creds.accountId,
            delegateAddress: creds.delegateAddress,
            relayerUrl: creds.relayerUrl,
            approvedAt: new Date().toISOString(),
        },
    ]);
    return {
        outcome: existing ? "reapproved" : "approved",
        projectPath,
        accountId: creds.accountId,
        relayerUrl: creds.relayerUrl,
        previousAccountId: existing?.accountId,
        previousRelayerUrl: existing?.relayerUrl,
        approvalsPath,
    };
}

/** What {@link revokeProjectCredsApproval} did. */
export interface RevokeProjectResult {
    outcome: "revoked" | "none";
    projectPath?: string;
    approvalsPath: string;
}

/**
 * Withdraw the approval for the project-local credentials here.
 *
 * Keyed on the path rather than on the file's current contents, so an approval
 * can be withdrawn even after the file it covered was edited or deleted — a
 * revoke that only worked while the destination still matched would be
 * useless exactly when it is wanted.
 */
export function revokeProjectCredsApproval(): RevokeProjectResult {
    const approvalsPath = projectApprovalsPath();
    const projectPath = projectCredsPath() ?? join(process.cwd(), ".memwal", CREDS_FILE);
    const key = canonicalPath(projectPath);
    const approvals = loadApprovals();
    const remaining = approvals.filter((a) => a.path !== key);
    if (remaining.length === approvals.length) return { outcome: "none", projectPath, approvalsPath };
    saveApprovals(remaining);
    return { outcome: "revoked", projectPath, approvalsPath };
}

/**
 * The warning for a project credentials file that was found and NOT used, or
 * null when there is nothing to report.
 *
 * Says which file was ignored, where memory is going instead, and the exact
 * command that approves it — a silent fallback would be the mirror image of
 * the silent redirect this gate exists to stop. Never contains a key: the only
 * fields it reads are the account id and the relayer URL.
 */
export function formatProjectCredsNotice(
    resolution: CredsResolution = resolveCreds(),
): string | null {
    const project = resolution.project;
    if (!project || project.decision === "approved") return null;

    const destination = `account ${project.accountId} on ${project.relayerUrl}`;
    const head =
        project.decision === "unreadable"
            ? [
                  `Ignored the project credentials at ${project.path}: the file is not a valid`,
                  `Walrus Memory credentials file, so there is nothing to approve.`,
              ]
            : project.decision === "changed"
              ? [
                    `Ignored the project credentials at ${project.path}: they changed since you`,
                    `approved them and now point at ${destination}.`,
                    `Approving again is required whenever the account, delegate key or relayer moves.`,
                ]
              : [
                    `Ignored the project credentials at ${project.path}, which would send memory to`,
                    `${destination}.`,
                    `A file inside a repository can be committed by anyone, so it is not used until`,
                    `you approve it on this machine.`,
                ];

    const lines = [...head, `Memory is going to ${resolution.path} instead.`];
    if (project.decision !== "unreadable") {
        lines.push(
            `To use it, run \`memwal-mcp approve-project\` in a terminal from this directory.`,
            `The approval is recorded in ${projectApprovalsPath()}, outside the repository.`,
        );
    }
    return lines.join("\n");
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
    writeSecretFile(path, JSON.stringify(creds, null, 2));
    return { path, ...replaced };
}

/**
 * Write a file whose bytes are only ever reachable through an inode this call
 * created at `0600`.
 *
 * The obvious version — write to the final path, then `chmod` it — does not
 * hold that property. `writeFileSync`'s `mode` follows POSIX `open()`: the
 * kernel applies it when it creates the inode and ignores it for one that
 * already exists. So a credentials file that anything outside this code left
 * world-readable (a manual `chmod`, a restored backup, another tool) would
 * receive the plaintext delegate key under the *old* mode, with a second,
 * separate syscall to tighten it afterwards. Anyone reading the path in
 * between gets the key.
 *
 * Writing a fresh file and renaming removes that window instead of shortening
 * it. `rename(2)` repoints the name atomically, so a reader sees either the
 * whole old file or the whole new one, never a permissive inode holding a new
 * secret. `wx` (`O_EXCL`) makes a temp path that already exists — an
 * interrupted earlier run, or a file planted by someone else — a hard failure
 * rather than a write through a file this code did not create.
 */
function writeSecretFile(path: string, contents: string): void {
    const dir = dirname(path);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    // Named off the target and randomised, so concurrent saves cannot collide
    // on it and no one can guess it ahead of time. Dot-prefixed to keep a
    // crashed run's leftovers out of the way of directory listings.
    const tmp = join(dir, `.${basename(path)}.${process.pid}.${randomUUID()}.tmp`);
    try {
        writeFileSync(tmp, contents, { encoding: "utf8", mode: 0o600, flag: "wx" });
        replaceWithTemp(tmp, path, contents);
    } catch (err) {
        // Never leave a temp file holding the secret behind on a failed write.
        try {
            unlinkSync(tmp);
        } catch {
            /* already gone, or never created */
        }
        throw err;
    }
}

/** Windows errors for "someone else holds the destination open". */
const WIN32_LOCKED_CODES = new Set(["EPERM", "EACCES", "EBUSY"]);
const WIN32_RENAME_ATTEMPTS = 5;
const WIN32_RENAME_BACKOFF_MS = 20;

/** Block the calling thread. `saveCreds` is synchronous all the way up. */
function sleepSync(ms: number): void {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Move `tmp` onto `path`, atomically where the platform can.
 *
 * POSIX `rename(2)` replaces a destination regardless of who has it open, so
 * there is nothing to handle there and any error is a real one. Windows
 * implements the same call as `MoveFileEx(MOVEFILE_REPLACE_EXISTING)`, which
 * refuses with EPERM / EACCES / EBUSY while another handle holds the
 * destination — an antivirus scan or a backup agent touching
 * `credentials.json` is enough. Before this file wrote through a temp inode,
 * `writeFileSync` to the final path survived that; `login.ts` turns a thrown
 * `saveCreds` into an HTTP 500, so a lock that lasts a few milliseconds would
 * otherwise become a failed sign-in.
 *
 * So on Windows: retry briefly, then write in place rather than fail. That
 * fallback gives up the atomic swap, but not the property this function exists
 * for — Windows does not enforce POSIX mode bits at all, so `0600` was never
 * doing the work there; NTFS ACLs are, and they are inherited from the
 * directory either way. On POSIX, where the mode IS the protection, there is no
 * fallback and no retry.
 *
 * `deps` is a seam for tests. CI has no Windows runner, and the fallback is the
 * one branch here that can leave a second plaintext copy of the delegate key on
 * disk, so it must be exercisable off Windows.
 */
export function replaceWithTemp(
    tmp: string,
    path: string,
    contents: string,
    deps: {
        platform?: string;
        rename?: (from: string, to: string) => void;
        sleep?: (ms: number) => void;
    } = {},
): void {
    const platform = deps.platform ?? process.platform;
    const rename = deps.rename ?? renameSync;
    const sleep = deps.sleep ?? sleepSync;

    if (platform !== "win32") {
        rename(tmp, path);
        return;
    }
    for (let attempt = 1; ; attempt++) {
        try {
            rename(tmp, path);
            return;
        } catch (err) {
            const code = (err as NodeJS.ErrnoException).code ?? "";
            if (!WIN32_LOCKED_CODES.has(code)) throw err;
            if (attempt < WIN32_RENAME_ATTEMPTS) {
                sleep(WIN32_RENAME_BACKOFF_MS * attempt);
                continue;
            }
            // Still locked. Write through the existing handle's inode rather
            // than failing the sign-in.
            writeFileSync(path, contents, { encoding: "utf8", mode: 0o600 });
            // This returns SUCCESSFULLY, so `writeSecretFile`'s catch never
            // runs and nothing else will remove `tmp` — which still holds the
            // plaintext delegate key. Every locked save would otherwise leave
            // another copy of it beside the credentials file, which is the
            // opposite of what this whole helper is for.
            //
            // Best-effort: a temp that cannot be unlinked must not fail a save
            // that has already landed.
            try {
                unlinkSync(tmp);
            } catch {
                /* nothing more to do; the destination write already succeeded */
            }
            return;
        }
    }
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

/**
 * The message shown *before* a sign-in that would overwrite existing
 * credentials, or null when there is nothing to lose.
 *
 * Deliberately shown ahead of the browser step: that is the last moment the
 * user can back out for free. The incoming account is not known until the
 * callback arrives, by which point a delegate key has already been registered
 * on-chain — so a warning that waits for both ids is a warning that arrives
 * too late to act on.
 */
export function formatPendingSignInWarning(): string | null {
    const current = loadCreds();
    if (!current) return null;
    return (
        `Signing in will replace the credentials in ${credsPath()} ` +
        `(currently account ${current.accountId}). ` +
        `The existing file is backed up if the new sign-in is a different account.`
    );
}

/**
 * The message shown when a sign-in displaced a different account, or null when
 * nothing was replaced.
 *
 * Both ids on purpose: "your credentials changed" is useless without knowing
 * which account you left and which you are now on — that ambiguity is the whole
 * of GH #628. Kept here as a pure function so the wording is testable without
 * driving a browser login.
 */
export function formatReplacementNotice(
    saved: SaveCredsResult,
    incomingAccountId: string,
): string | null {
    if (!saved.replacedAccountId) return null;
    const lines = [
        `Replaced credentials for a DIFFERENT account in ${saved.path}:`,
        `  was: ${saved.replacedAccountId}`,
        `  now: ${incomingAccountId}`,
    ];
    if (saved.backedUpTo) lines.push(`  previous file backed up to ${saved.backedUpTo}`);
    return lines.join("\n");
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
        // Through the same writer as the credentials file itself: the backup is
        // a second copy of the same plaintext delegate key, and `copyFileSync`
        // would create it under the process umask before any tightening.
        writeSecretFile(backup, readFileSync(path, "utf8"));
        return { replacedAccountId: current.accountId, backedUpTo: backup };
    } catch {
        // Never block sign-in on a failed backup — but still report the
        // replacement, since that is the part the user needs to know.
        return { replacedAccountId: current.accountId };
    }
}

/** What `clearCreds` did. Reported rather than printed, for the same reason
 * `saveCreds` reports: persistence should not own user-facing output. */
export interface ClearCredsResult {
    /** File actually deleted. Absent when there was nothing to remove, or the
     * unlink failed. */
    removedPath?: string;
    /** Credentials that take over from the next run, because removing the file
     * above them re-exposed them. Absent when signing out was complete. */
    fallbackPath?: string;
}

/**
 * Delete the credentials this process resolves to. No-op if none exist.
 *
 * Resolution happens *before* the unlink on purpose: once the file is gone
 * `credsPath()` reports the next one down the chain, so a caller that asked
 * afterwards would name a file it never touched. That same survivor is what
 * the next run loads, so removing a project file while a global one exists is
 * not a full sign-out — `fallbackPath` is how the caller can say so instead of
 * leaving the user to discover a different account later (GH #628).
 */
export function clearCreds(): ClearCredsResult {
    const path = credsPath();
    if (!existsSync(path)) return {};
    try {
        unlinkSync(path);
    } catch {
        // Nothing was removed; claiming otherwise would be worse than silence.
        return {};
    }
    const survivor = credsPath();
    return existsSync(survivor) && survivor !== path
        ? { removedPath: path, fallbackPath: survivor }
        : { removedPath: path };
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

/* ------------------------------------------------------------------------- *
 * Pending login — write-ahead for the delegate keypair (WALM-332).
 *
 * The browser registers our delegate public key on-chain, which costs gas and
 * cannot be undone, and only afterwards POSTs the callback that makes us save
 * the matching private key. Losing this process in that window used to destroy
 * the only copy of the key, stranding a paid registration nobody could use.
 *
 * So the keypair is written here BEFORE the browser is given the connect URL,
 * and cleared once `saveCreds` has the key safely in `credentials.json`. A
 * record that outlives its flow is recovered on next start.
 * ------------------------------------------------------------------------- */

const PENDING_FILE = "login-pending.json";

/**
 * How long a stranded record stays recoverable.
 *
 * Deliberately far longer than the 5-minute login timeout: the whole point is
 * to survive a client restart, and a user who quits for the evening and comes
 * back tomorrow is exactly the case worth covering. The cost of holding it is
 * an unregistered key on disk, which grants nothing.
 */
export const PENDING_LOGIN_TTL_MS = 24 * 60 * 60_000;

export interface PendingLogin {
    /** 64-hex Ed25519 private key seed. NEVER log this. */
    delegatePrivateKey: string;
    delegatePublicKeyHex: string;
    delegateAddress: string;
    /** Relayer the flow was started against — recovery must not repoint. */
    relayerUrl: string;
    label?: string;
    /** ISO timestamp, for TTL expiry. */
    createdAt: string;
    version: 1;
}

/** Sits beside whichever credentials file `credsPath()` resolves to, so a
 * project-local sign-in recovers into that same project. */
export function pendingLoginPath(): string {
    return join(dirname(credsPath()), PENDING_FILE);
}

/**
 * Persist the pending keypair. Throws if it cannot.
 *
 * Deliberately NOT best-effort. The invariant this record exists to hold is
 * that the delegate private key is on disk before its public half can reach a
 * browser that will pay gas to register it. Swallowing the error would publish
 * the connect URL while claiming a durability that does not exist — the
 * original WALM-332 loss, now silent.
 *
 * Failing the login costs the user nothing: this file sits beside
 * `credentials.json`, so a directory that cannot take it cannot take the
 * credentials either. The same login would have failed at the callback anyway,
 * one on-chain `add_delegate_key` later.
 */
export function savePendingLogin(pending: PendingLogin): void {
    const path = pendingLoginPath();
    try {
        // The record holds the same plaintext private key as `credentials.json`,
        // so it gets the same fresh-inode write.
        writeSecretFile(path, JSON.stringify(pending, null, 2));
    } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        log.error("login.pending.write_failed", { path, msg });
        throw new Error(
            `Could not write the login write-ahead record at ${path}: ${msg}. ` +
                `Refusing to start a sign-in that could register a delegate key on-chain ` +
                `without being able to save it.`,
        );
    }
}

/**
 * A pending record this login can adopt instead of minting a new keypair.
 *
 * `loginFlow` used to generate a fresh keypair every call and overwrite the
 * record unconditionally. Recovery only runs at process start and is skipped
 * for `--login` / `forceLogin`, so a timed-out login followed by `memwal_login`
 * in the same process replaced the only copy of a key the browser may already
 * have paid to register. Reusing the record keeps that key reclaimable.
 *
 * Scoped to the same relayer: a key registered against one relayer's account
 * proves nothing to another, and `recovery` must never repoint. TTL and shape
 * are already enforced by {@link loadPendingLogin}.
 */
export function reusablePendingLogin(relayerUrl: string): PendingLogin | null {
    const pending = loadPendingLogin();
    if (!pending) return null;
    if (pending.relayerUrl !== relayerUrl) {
        log.warn("login.pending.relayer_changed", {
            publicKey: pending.delegatePublicKeyHex,
            from: pending.relayerUrl,
            to: relayerUrl,
        });
        return null;
    }
    return pending;
}

/**
 * Load a pending record, or null if there is none, it is malformed, or it has
 * aged out. An expired record is deleted on read rather than left to linger.
 */
export function loadPendingLogin(): PendingLogin | null {
    const path = pendingLoginPath();
    if (!existsSync(path)) return null;
    let parsed: unknown;
    try {
        parsed = JSON.parse(readFileSync(path, "utf8"));
    } catch {
        clearPendingLogin();
        return null;
    }
    if (!isValidPending(parsed)) {
        clearPendingLogin();
        return null;
    }
    const age = Date.now() - Date.parse(parsed.createdAt);
    if (!Number.isFinite(age) || age > PENDING_LOGIN_TTL_MS) {
        clearPendingLogin();
        return null;
    }
    return parsed;
}

/** Remove the pending record. Safe to call when there isn't one. */
export function clearPendingLogin(): void {
    try {
        const path = pendingLoginPath();
        if (existsSync(path)) unlinkSync(path);
    } catch {
        /* best effort */
    }
}

function isValidPending(obj: unknown): obj is PendingLogin {
    if (!obj || typeof obj !== "object") return false;
    const p = obj as Record<string, unknown>;
    return (
        typeof p.delegatePrivateKey === "string" &&
        /^[0-9a-fA-F]{64}$/.test(p.delegatePrivateKey) &&
        typeof p.delegatePublicKeyHex === "string" &&
        /^[0-9a-fA-F]{64}$/.test(p.delegatePublicKeyHex) &&
        typeof p.delegateAddress === "string" &&
        typeof p.relayerUrl === "string" &&
        typeof p.createdAt === "string" &&
        p.version === 1
    );
}
