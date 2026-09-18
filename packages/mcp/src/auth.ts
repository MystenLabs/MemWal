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
import { randomUUID } from "node:crypto";
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
 * Project credential trust.
 *
 * `projectCredsPath()` finds a `.memwal/credentials.json` by presence alone,
 * and the comment above it calls creating that file "the opt-in". Presence is
 * only an opt-in when the person opting in is the one who put the file there.
 * A repository can put it there too: commit `.memwal/credentials.json` into a
 * template, scaffold or example repo, and every clone an MCP host launches with
 * its cwd inside adopts the committed `accountId`, the committed
 * `delegatePrivateKey`, and — because `bridge.ts` dials `creds.relayerUrl`
 * rather than the resolved config — the committed relayer. No code from the
 * repository has to run for any of that.
 *
 * That is strictly easier than an attack this codebase already refuses to
 * allow. The H4 control in `index.ts` will not let a `--relayer` flag mutate
 * the saved relayer, on the grounds that a pasted config snippet would
 * otherwise mean "even subsequent runs without the flag ship the seed to the
 * attacker". A committed file needs no paste, and survives without the flag by
 * construction.
 *
 * Provenance therefore has to be recorded somewhere the repository cannot
 * write. This ledger sits beside the global credentials file and lists the
 * project directories this machine's user has adopted; a project file whose
 * directory is not listed is ignored in favour of the global file, and the
 * caller is told. Adding `.memwal/` to `.gitignore` — the only mitigation the
 * docs offered — protects your key from being committed and says nothing about
 * adopting someone else's.
 * ------------------------------------------------------------------------- */

const TRUSTED_FILE = "trusted-projects.json";

function trustedProjectsPath(): string {
    return join(homedir(), ".memwal", TRUSTED_FILE);
}

/**
 * Canonical key for a project directory.
 *
 * Resolved, so a symlinked or relative route to the same project compares
 * equal to the one that was adopted — otherwise trust granted through
 * `/Users/x/work/repo` would not cover the same directory reached through a
 * symlinked `/Users/x/w/repo`. Falls back to the literal path when it cannot be
 * resolved, which fails closed: an unresolvable path will not match a stored
 * resolved one.
 */
function projectKey(dir: string): string {
    try {
        return realpathSync(dir);
    } catch {
        return dir;
    }
}

function loadTrustedProjects(): Set<string> {
    try {
        const parsed: unknown = JSON.parse(readFileSync(trustedProjectsPath(), "utf8"));
        const dirs = (parsed as { dirs?: unknown })?.dirs;
        if (!Array.isArray(dirs)) return new Set();
        return new Set(dirs.filter((d): d is string => typeof d === "string"));
    } catch {
        // Missing, unreadable or malformed all mean the same thing: nothing has
        // been adopted. Never fail open.
        return new Set();
    }
}

/** Whether `dir` — the directory *containing* `.memwal`, not `.memwal` itself
 * — has been adopted on this machine. */
export function isProjectDirTrusted(dir: string): boolean {
    return loadTrustedProjects().has(projectKey(dir));
}

/**
 * Record a project directory as one whose credentials file this user adopts.
 *
 * Written through `writeSecretFile` even though the ledger holds no secret: a
 * world-writable ledger would let anything on the machine grant the trust this
 * gate exists to withhold, and the fresh-inode write is what guarantees `0600`
 * on a file something else may have created.
 */
export function trustProjectDir(dir: string): string {
    const key = projectKey(dir);
    const trusted = loadTrustedProjects();
    trusted.add(key);
    writeSecretFile(
        trustedProjectsPath(),
        JSON.stringify({ version: 1, dirs: [...trusted].sort() }, null, 2),
    );
    log.info("creds.project_trusted", { dir: key });
    return key;
}

/** Remove an adopted directory. Returns whether it was listed. */
export function untrustProjectDir(dir: string): boolean {
    const key = projectKey(dir);
    const trusted = loadTrustedProjects();
    if (!trusted.delete(key)) return false;
    writeSecretFile(
        trustedProjectsPath(),
        JSON.stringify({ version: 1, dirs: [...trusted].sort() }, null, 2),
    );
    return true;
}

/**
 * Blanket opt-in for non-interactive contexts — CI, containers, a devcontainer
 * image — where there is no one to run `trust-project` and the checkout is
 * already trusted by whoever configured the job.
 *
 * An environment variable is the right channel precisely because a repository
 * cannot set one. That asymmetry is the whole distinction this gate turns on.
 */
function trustAllProjectsFromEnv(): boolean {
    const v = process.env.MEMWAL_TRUST_PROJECT_CREDS;
    return v === "1" || v === "true";
}

/** Where a project credentials file's trust is keyed: `<dir>/.memwal/credentials.json`
 * is adopted by adopting `<dir>`. */
export function projectDirOf(credentialsPath: string): string {
    return dirname(dirname(credentialsPath));
}

export interface ResolvedCredsPath {
    /** The file this process actually reads and writes. */
    path: string;
    /** A project-local file that was found but NOT adopted, and is therefore
     * being ignored in favour of `path`. Absent when nothing was skipped. */
    untrustedProjectPath?: string;
}

/**
 * Which credentials file this process should read and write, and what it
 * skipped getting there.
 *
 * The nearest project-local `.memwal/credentials.json` at or above the working
 * directory wins over the global one, the way `.npmrc` and `.git/config`
 * resolve — but only once this machine has adopted that directory. Signing in
 * from one project otherwise repoints every other project on the machine at a
 * different account and delegate key, silently (GH #628); adopting a file the
 * project shipped repoints *this* one at someone else's account and relayer.
 *
 * Resolved per call rather than at module load, because the working directory
 * is not knowable at import time.
 *
 * `MEMWAL_CREDS_DIR` overrides both project and global resolution when set, and
 * is re-read on every call. It is an explicit instruction through a channel the
 * repository cannot reach, so it is not subject to the trust gate.
 */
export function resolveCredsPath(): ResolvedCredsPath {
    const override = process.env.MEMWAL_CREDS_DIR;
    if (override) return { path: join(override, CREDS_FILE) };

    const project = projectCredsPath();
    if (!project) return { path: globalCredsPath() };
    if (trustAllProjectsFromEnv()) return { path: project };
    if (isProjectDirTrusted(projectDirOf(project))) return { path: project };

    return { path: globalCredsPath(), untrustedProjectPath: project };
}

export function credsPath(): string {
    return resolveCredsPath().path;
}

/**
 * The message shown when a project credentials file was found and ignored, or
 * null when none was.
 *
 * Says what was skipped, what is being used instead, and the exact command that
 * adopts it — a refusal the user cannot act on would just push them to
 * `MEMWAL_TRUST_PROJECT_CREDS=1`, which is the blanket version of the thing
 * being withheld.
 */
export function formatUntrustedProjectCredsNotice(
    resolved: ResolvedCredsPath = resolveCredsPath(),
): string | null {
    if (!resolved.untrustedProjectPath) return null;
    return [
        `Ignoring project credentials at ${resolved.untrustedProjectPath}`,
        `  This machine has not adopted that directory. A credentials file can arrive`,
        `  with a repository, and it names the account, the delegate key AND the`,
        `  relayer this client sends them to.`,
        `  Using ${resolved.path} instead.`,
        `  If you put that file there yourself, adopt it with:`,
        `    npx -y @mysten-incubation/memwal-mcp trust-project`,
    ].join("\n");
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

/** Loopback in the forms a URL parser will hand back, IPv6 brackets stripped. */
function isLoopbackHostname(hostname: string): boolean {
    const host = hostname.replace(/^\[/, "").replace(/\]$/, "").toLowerCase();
    if (host === "localhost" || host.endsWith(".localhost")) return true;
    if (host === "::1") return true;
    return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host);
}

/**
 * A relayer URL this client is willing to hand the delegate key to.
 *
 * `relayerUrl` was accepted as any string, and `bridge.ts` dials it — so
 * whatever reaches `credentials.json` chooses the host that receives
 * `Authorization: Bearer <delegatePrivateKey>` on every session. That is the
 * long-lived Ed25519 seed, not a scoped token, so the transport it crosses is
 * not a detail.
 *
 * Two limits, both about the transport rather than the identity of the host —
 * a host allowlist would break every self-hosted and staging deployment, which
 * are supported configurations:
 *
 *   - a non-HTTP scheme is never a relayer. `new URL()` will happily accept
 *     `file:`, `data:` and a long tail of others.
 *   - plaintext `http:` must not carry the seed across a network. Loopback is
 *     exempt: `--local` is a documented preset (`http://127.0.0.1:8000`) and
 *     there is no network segment to read it off.
 */
export function isSafeRelayerUrl(value: string): boolean {
    let url: URL;
    try {
        url = new URL(value);
    } catch {
        return false;
    }
    if (url.protocol === "https:") return true;
    if (url.protocol !== "http:") return false;
    return isLoopbackHostname(url.hostname);
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
        isSafeRelayerUrl(c.relayerUrl) &&
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
        // Recovery signs a `GET /api/whoami` against this URL and, on a 200,
        // writes it into `credentials.json` as the saved relayer. Same reach as
        // the credentials field, so the same limit.
        isSafeRelayerUrl(p.relayerUrl) &&
        typeof p.createdAt === "string" &&
        p.version === 1
    );
}
