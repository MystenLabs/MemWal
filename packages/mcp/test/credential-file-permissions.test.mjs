/**
 * Credential file permissions (GH #520 / WALM-312).
 *
 * `saveCreds` wrote the new delegate private key straight to the final path and
 * only then called `chmodSync(0600)`. `writeFileSync`'s `mode` follows POSIX
 * `open()` — it applies when the kernel creates the inode, never to an existing
 * one. So a `credentials.json` left at broader permissions by anything outside
 * this code (a manual chmod, a restored backup, another tool) received the new
 * secret under the *old* mode, and only the second, non-atomic syscall tightened
 * it.
 *
 * The window itself is a race and cannot be asserted by watching for it. What
 * can be asserted is the property that closes it: the new secret is never
 * written through the old inode at all. A reader that already holds that inode
 * open — the attacker in the report — is the observer that makes this
 * deterministic. It sees the old bytes forever if the write went to a fresh
 * 0600 inode that was then renamed over the name, and the new key the moment
 * the write went through the old permissive inode in place.
 *
 * `auth.js` resolves paths at call time, so each test sets HOME and cwd first
 * and then imports with a cache-busting query — the pattern used by
 * credential-resolution.test.mjs.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
    mkdtempSync,
    mkdirSync,
    writeFileSync,
    readFileSync,
    readdirSync,
    readSync,
    openSync,
    closeSync,
    statSync,
    rmSync,
    realpathSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";

const ACCOUNT = "0x" + "a".repeat(64);
const OTHER_ACCOUNT = "0x" + "b".repeat(64);
const OLD_KEY = "1".repeat(64);
const NEW_KEY = "2".repeat(64);

function makeCreds(accountId, delegatePrivateKey) {
    return {
        delegatePrivateKey,
        delegatePublicKeyHex: "d".repeat(64),
        delegateAddress: "0x" + "e".repeat(64),
        walletAddress: "0x" + "f".repeat(64),
        accountId,
        packageId: "0x" + "1".repeat(64),
        relayerUrl: "https://relayer.example",
        label: "Test",
        createdAt: new Date(0).toISOString(),
        version: 1,
    };
}

/** Permission bits only — `statSync().mode` carries the file type as well. */
function modeOf(path) {
    return statSync(path).mode & 0o777;
}

/**
 * Fresh HOME with the module re-imported so it observes it. The working
 * directory is moved to an empty sandbox too, so no project-local
 * `.memwal` from the real checkout can win over the global file under test.
 */
async function sandbox(t, { existingFileMode } = {}) {
    // Canonicalised for the same reason as credential-resolution.test.mjs:
    // `homedir()` and `process.cwd()` report resolved paths, and on macOS
    // `/var` is a symlink to `/private/var`.
    const home = realpathSync(mkdtempSync(join(tmpdir(), "memwal-perm-home-")));
    const cwd = realpathSync(mkdtempSync(join(tmpdir(), "memwal-perm-cwd-")));
    const prevHome = process.env.HOME;
    const prevProfile = process.env.USERPROFILE;
    const prevCwd = process.cwd();

    process.env.HOME = home;
    process.env.USERPROFILE = home;
    process.chdir(cwd);

    const path = join(home, ".memwal", "credentials.json");
    if (existingFileMode !== undefined) {
        mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
        writeFileSync(path, JSON.stringify(makeCreds(ACCOUNT, OLD_KEY)), {
            mode: existingFileMode,
        });
    }

    t.after(() => {
        process.chdir(prevCwd);
        process.env.HOME = prevHome;
        process.env.USERPROFILE = prevProfile;
        rmSync(home, { recursive: true, force: true });
        rmSync(cwd, { recursive: true, force: true });
    });

    const auth = await import(`../dist/auth.js?walm312=${Date.now()}-${Math.random()}`);
    return { auth, home, path };
}

/** Read through an already-open descriptor, which follows the inode rather
 * than the name — so this reports what a holder of the *old* file sees, even
 * after the name has been repointed at a different inode. */
function readThroughOpenFd(fd) {
    const buffer = Buffer.alloc(4096);
    const bytes = readSync(fd, buffer, 0, buffer.length, 0);
    return buffer.subarray(0, bytes).toString("utf8");
}

test("saveCreds never writes the new secret through a pre-existing permissive file", async (t) => {
    const { auth, path } = await sandbox(t, { existingFileMode: 0o644 });

    // The attacker's handle, opened while the file is still world-readable and
    // held across the save. Same accountId as the file already on disk, so this
    // is a plain same-account key rotation with no backup in the way.
    const attackerFd = openSync(path, "r");
    t.after(() => closeSync(attackerFd));

    auth.saveCreds(makeCreds(ACCOUNT, NEW_KEY));

    const seenByAttacker = readThroughOpenFd(attackerFd);
    assert.ok(
        !seenByAttacker.includes(NEW_KEY),
        "the new delegate private key must never be readable through the pre-existing 0644 inode",
    );
    assert.ok(
        seenByAttacker.includes(OLD_KEY),
        "the displaced inode should still hold the old content, proving it was replaced rather than truncated in place",
    );

    // Positive control: the save really did happen, at the right permission.
    assert.equal(JSON.parse(readFileSync(path, "utf8")).delegatePrivateKey, NEW_KEY);
    assert.equal(modeOf(path), 0o600, "the file in place after the save must be 0600");
});

test("saveCreds creates a new credentials file at 0600", async (t) => {
    const { auth, path } = await sandbox(t);

    auth.saveCreds(makeCreds(ACCOUNT, NEW_KEY));

    assert.equal(modeOf(path), 0o600);
    assert.equal(modeOf(dirname(path)), 0o700, "the containing directory stays owner-only");
});

test("the backup of a displaced account is written at 0600", async (t) => {
    const { auth, home } = await sandbox(t, { existingFileMode: 0o600 });

    const saved = auth.saveCreds(makeCreds(OTHER_ACCOUNT, NEW_KEY));

    assert.equal(saved.replacedAccountId, ACCOUNT, "the outgoing account should be reported");
    assert.ok(saved.backedUpTo, "a different incoming account should be backed up");
    assert.equal(modeOf(saved.backedUpTo), 0o600, "the backup holds the same plaintext key");
    assert.equal(JSON.parse(readFileSync(saved.backedUpTo, "utf8")).delegatePrivateKey, OLD_KEY);
});

test("saveCreds leaves no temporary file behind", async (t) => {
    const { auth, home } = await sandbox(t, { existingFileMode: 0o644 });

    auth.saveCreds(makeCreds(ACCOUNT, NEW_KEY));

    const stray = readdirSync(join(home, ".memwal")).filter((name) => name.endsWith(".tmp"));
    assert.deepEqual(stray, [], "a completed save should not leave a temporary file in the directory");
});
