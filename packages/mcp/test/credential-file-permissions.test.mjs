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
    renameSync,
    existsSync,
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

// Windows does not enforce POSIX mode bits. `statSync().mode` there is
// synthesized from the read-only attribute, so a `0o600` assertion tests
// nothing, and `writeSecretFile` falls back to an in-place write when the
// destination is locked. NTFS ACLs carry the protection instead, inherited
// from the containing directory. Tests whose premise IS the mode bit are
// skipped rather than weakened into passing everywhere.
const POSIX_ONLY = {
    skip: process.platform === "win32" ? "POSIX mode bits are not enforced on Windows" : false,
};

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

test("saveCreds never writes the new secret through a pre-existing permissive file", POSIX_ONLY, async (t) => {
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

test("saveCreds creates a new credentials file at 0600", POSIX_ONLY, async (t) => {
    const { auth, path } = await sandbox(t);

    auth.saveCreds(makeCreds(ACCOUNT, NEW_KEY));

    assert.equal(modeOf(path), 0o600);
    assert.equal(modeOf(dirname(path)), 0o700, "the containing directory stays owner-only");
});

test("the backup of a displaced account is written at 0600", async (t) => {
    const { auth } = await sandbox(t, { existingFileMode: 0o600 });

    const saved = auth.saveCreds(makeCreds(OTHER_ACCOUNT, NEW_KEY));

    assert.equal(saved.replacedAccountId, ACCOUNT, "the outgoing account should be reported");
    assert.ok(saved.backedUpTo, "a different incoming account should be backed up");
    if (process.platform !== "win32") {
        assert.equal(modeOf(saved.backedUpTo), 0o600, "the backup holds the same plaintext key");
    }
    assert.equal(JSON.parse(readFileSync(saved.backedUpTo, "utf8")).delegatePrivateKey, OLD_KEY);
});

test("saveCreds leaves no temporary file behind", async (t) => {
    const { auth, home } = await sandbox(t, { existingFileMode: 0o644 });

    auth.saveCreds(makeCreds(ACCOUNT, NEW_KEY));

    const stray = readdirSync(join(home, ".memwal")).filter((name) => name.endsWith(".tmp"));
    assert.deepEqual(stray, [], "a completed save should not leave a temporary file in the directory");
});

/**
 * The Windows locked-destination fallback.
 *
 * CI has no Windows runner, so these drive `replaceWithTemp` directly with an
 * injected platform and a `rename` that fails the way `MoveFileEx` does when
 * another handle holds the destination. The fallback returns SUCCESSFULLY, so
 * nothing upstream cleans up after it — a leaked temp here is a second
 * plaintext copy of the delegate key, which is the exact class of bug this
 * file exists to prevent.
 */
const lockedRename = (code) => () => {
    const err = new Error(`${code}: locked`);
    err.code = code;
    throw err;
};

/** A temp file already written at 0600, as `writeSecretFile` leaves it. */
function stageTemp(t, contents = "SECRET_KEY_MATERIAL") {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "memwal-replace-")));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const tmp = join(dir, ".credentials.json.123.abc.tmp");
    const dest = join(dir, "credentials.json");
    writeFileSync(tmp, contents, { mode: 0o600 });
    return { dir, tmp, dest, contents };
}

for (const code of ["EPERM", "EACCES", "EBUSY"]) {
    test(`a destination locked with ${code} still lands, leaving no temp behind`, async (t) => {
        const { auth } = await sandbox(t);
        const { dir, tmp, dest, contents } = stageTemp(t);

        auth.replaceWithTemp(tmp, dest, contents, {
            platform: "win32",
            rename: lockedRename(code),
            sleep: () => {},
        });

        assert.equal(readFileSync(dest, "utf8"), contents, "the save must still land");
        assert.equal(
            existsSync(tmp),
            false,
            "the temp still holds the plaintext key — it must not survive the fallback",
        );
        assert.deepEqual(
            readdirSync(dir).filter((n) => n.endsWith(".tmp")),
            [],
            "no temporary file may remain in the credentials directory",
        );
    });
}

test("repeated locked saves do not accumulate copies of the key", async (t) => {
    // The regression the fallback introduced: the old in-place writeFileSync
    // never created a sibling file, so nothing used to pile up here.
    const { auth } = await sandbox(t);
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "memwal-replace-many-")));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const dest = join(dir, "credentials.json");

    for (let i = 0; i < 3; i++) {
        const tmp = join(dir, `.credentials.json.123.run${i}.tmp`);
        writeFileSync(tmp, `SECRET_${i}`, { mode: 0o600 });
        auth.replaceWithTemp(tmp, dest, `SECRET_${i}`, {
            platform: "win32",
            rename: lockedRename("EPERM"),
            sleep: () => {},
        });
    }

    assert.equal(readFileSync(dest, "utf8"), "SECRET_2", "the last save wins");
    assert.deepEqual(
        readdirSync(dir).filter((n) => n.endsWith(".tmp")),
        [],
        "three locked saves must not leave three copies of the delegate key",
    );
});

test("a lock that clears before the attempts run out renames instead of falling back", async (t) => {
    const { auth } = await sandbox(t);
    const { tmp, dest, contents } = stageTemp(t);

    let calls = 0;
    auth.replaceWithTemp(tmp, dest, contents, {
        platform: "win32",
        sleep: () => {},
        rename: (from, to) => {
            calls++;
            if (calls < 3) lockedRename("EPERM")();
            renameSync(from, to);
        },
    });

    assert.equal(calls, 3, "should have retried rather than given up on the first refusal");
    assert.equal(readFileSync(dest, "utf8"), contents);
    assert.equal(existsSync(tmp), false, "the rename consumed the temp");
});

test("a non-lock rename error is not swallowed by the Windows path", async (t) => {
    // Only lock codes get the retry-and-fall-back treatment. Anything else is
    // a real failure and must reach `writeSecretFile`, which removes the temp.
    const { auth } = await sandbox(t);
    const { tmp, dest, contents } = stageTemp(t);

    assert.throws(
        () =>
            auth.replaceWithTemp(tmp, dest, contents, {
                platform: "win32",
                rename: lockedRename("ENOSPC"),
                sleep: () => {},
            }),
        /ENOSPC/,
    );
    assert.equal(existsSync(dest), false, "nothing should have been written");
});

test("POSIX does not retry or fall back", async (t) => {
    // There the mode IS the protection, and rename(2) replaces a destination
    // regardless of who holds it open, so a refusal is a real error.
    const { auth } = await sandbox(t);
    const { tmp, dest, contents } = stageTemp(t);

    let calls = 0;
    assert.throws(
        () =>
            auth.replaceWithTemp(tmp, dest, contents, {
                platform: "linux",
                rename: () => {
                    calls++;
                    lockedRename("EPERM")();
                },
            }),
        /EPERM/,
    );
    assert.equal(calls, 1, "POSIX must not retry");
    assert.equal(existsSync(dest), false, "and must not write in place");
});
