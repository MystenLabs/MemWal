/**
 * Credential resolution (GH #628 / WALM-361).
 *
 * Credentials live in a single global file, so authenticating from one project
 * silently repoints every other project at a different account and delegate
 * key. The reporter caught it via the `label` field before writing anything;
 * had they written, memories would have landed on the wrong account, on
 * immutable storage, with no delete path.
 *
 * Decision recorded on WALM-361: a project-local `.memwal/credentials.json`
 * takes precedence over `~/.memwal/credentials.json`, npmrc/git-style. Purely
 * additive — a machine with no project-local file behaves exactly as before.
 *
 * `auth.js` resolves paths at call time, so each test sets HOME and cwd first
 * and then imports with a cache-busting query, the pattern used by
 * login-preflight.test.mjs.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";

const GLOBAL_ACCOUNT = "0x" + "a".repeat(64);
const PROJECT_ACCOUNT = "0x" + "b".repeat(64);

function makeCreds(accountId, label) {
    return {
        delegatePrivateKey: "c".repeat(64),
        delegatePublicKeyHex: "d".repeat(64),
        delegateAddress: "0x" + "e".repeat(64),
        walletAddress: "0x" + "f".repeat(64),
        accountId,
        packageId: "0x" + "1".repeat(64),
        relayerUrl: "https://relayer.example",
        label,
        createdAt: new Date(0).toISOString(),
        version: 1,
    };
}

function writeCredsAt(root, accountId, label) {
    const path = join(root, ".memwal", "credentials.json");
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(makeCreds(accountId, label)), { mode: 0o600 });
    return path;
}

/** Fresh sandbox: a HOME and a working directory, with the module re-imported
 * so it observes them. Returns the module plus both roots. */
async function sandbox(t, { global: globalAccount, project: projectAccount }) {
    // Canonicalise both roots: `process.cwd()` and `homedir()` report resolved
    // paths, so a raw mkdtemp path would not compare equal to what the module
    // computes. Needed on macOS (`/var` is a symlink to `/private/var`) and
    // harmless elsewhere.
    //
    // Both HOME and USERPROFILE are set because `os.homedir()` reads
    // USERPROFILE on Windows and HOME on POSIX — this sandbox is portable.
    const home = realpathSync(mkdtempSync(join(tmpdir(), "memwal-creds-home-")));
    const cwd = realpathSync(mkdtempSync(join(tmpdir(), "memwal-creds-cwd-")));
    const prevHome = process.env.HOME;
    const prevProfile = process.env.USERPROFILE;
    const prevCwd = process.cwd();

    process.env.HOME = home;
    process.env.USERPROFILE = home;
    process.chdir(cwd);

    if (globalAccount) writeCredsAt(home, globalAccount, "Global");
    if (projectAccount) writeCredsAt(cwd, projectAccount, "Project");

    t.after(() => {
        process.chdir(prevCwd);
        process.env.HOME = prevHome;
        process.env.USERPROFILE = prevProfile;
        rmSync(home, { recursive: true, force: true });
        rmSync(cwd, { recursive: true, force: true });
    });

    const auth = await import(`../dist/auth.js?walm361=${Date.now()}-${Math.random()}`);
    return { auth, home, cwd };
}

test("a project-local credentials file takes precedence over the global one", async (t) => {
    const { auth, cwd } = await sandbox(t, {
        global: GLOBAL_ACCOUNT,
        project: PROJECT_ACCOUNT,
    });

    assert.equal(
        auth.loadCreds()?.accountId,
        PROJECT_ACCOUNT,
        "working-directory credentials should win",
    );
    assert.equal(auth.credsPath(), join(cwd, ".memwal", "credentials.json"));
});

test("the global file is still used when the working directory has none", async (t) => {
    const { auth, home } = await sandbox(t, { global: GLOBAL_ACCOUNT });

    assert.equal(
        auth.loadCreds()?.accountId,
        GLOBAL_ACCOUNT,
        "existing single-file setups must be unaffected",
    );
    assert.equal(auth.credsPath(), join(home, ".memwal", "credentials.json"));
});

test("saveCreds writes back to the project-local file when that is the one in use", async (t) => {
    const { auth, home, cwd } = await sandbox(t, {
        global: GLOBAL_ACCOUNT,
        project: PROJECT_ACCOUNT,
    });

    const updated = makeCreds(PROJECT_ACCOUNT, "Renamed");
    auth.saveCreds(updated);

    const projectFile = JSON.parse(
        (await import("node:fs")).readFileSync(join(cwd, ".memwal", "credentials.json"), "utf8"),
    );
    const globalFile = JSON.parse(
        (await import("node:fs")).readFileSync(join(home, ".memwal", "credentials.json"), "utf8"),
    );

    assert.equal(projectFile.label, "Renamed", "the in-use file should be updated");
    assert.equal(
        globalFile.accountId,
        GLOBAL_ACCOUNT,
        "the global file must not be touched when a project-local one is in use",
    );
});

test("replacing credentials for a different account backs up the outgoing file", async (t) => {
    const { auth, home } = await sandbox(t, { global: GLOBAL_ACCOUNT });

    auth.saveCreds(makeCreds(PROJECT_ACCOUNT, "Incoming"));

    const dir = join(home, ".memwal");
    const backups = (await import("node:fs"))
        .readdirSync(dir)
        .filter((f) => f.startsWith("credentials.backup"));
    assert.equal(backups.length, 1, `expected one backup, saw: ${backups.join(", ")}`);

    const backed = JSON.parse(
        (await import("node:fs")).readFileSync(join(dir, backups[0]), "utf8"),
    );
    assert.equal(
        backed.accountId,
        GLOBAL_ACCOUNT,
        "the backup must hold the credentials being replaced",
    );
    assert.equal(existsSync(join(dir, "credentials.json")), true);
});

test("saveCreds reports what it replaced, so callers can warn with both account ids", async (t) => {
    const { auth, home } = await sandbox(t, { global: GLOBAL_ACCOUNT });

    const result = auth.saveCreds(makeCreds(PROJECT_ACCOUNT, "Incoming"));

    assert.equal(result.path, join(home, ".memwal", "credentials.json"));
    assert.equal(result.replacedAccountId, GLOBAL_ACCOUNT);
    assert.ok(
        result.backedUpTo?.includes("credentials.backup"),
        `expected a backup path, got ${result.backedUpTo}`,
    );
});

test("a same-account save reports no replacement and writes no backup", async (t) => {
    const { auth, home } = await sandbox(t, { global: GLOBAL_ACCOUNT });

    const result = auth.saveCreds(makeCreds(GLOBAL_ACCOUNT, "Relabelled"));

    assert.equal(result.replacedAccountId, undefined, "same account is not a replacement");
    assert.equal(result.backedUpTo, undefined, "routine re-saves must not churn backups");
    const dir = join(home, ".memwal");
    const backups = (await import("node:fs"))
        .readdirSync(dir)
        .filter((f) => f.startsWith("credentials.backup"));
    assert.equal(backups.length, 0);
});

test("the replacement notice names both accounts and the backup", async (t) => {
    const { auth } = await sandbox(t, { global: GLOBAL_ACCOUNT });

    const notice = auth.formatReplacementNotice(
        {
            path: "/home/u/.memwal/credentials.json",
            replacedAccountId: GLOBAL_ACCOUNT,
            backedUpTo: "/home/u/.memwal/credentials.backup-2026.json",
        },
        PROJECT_ACCOUNT,
    );

    assert.ok(notice, "a replacement must produce a notice");
    assert.match(notice, new RegExp(GLOBAL_ACCOUNT), "must name the account being replaced");
    assert.match(notice, new RegExp(PROJECT_ACCOUNT), "must name the incoming account");
    assert.match(notice, /credentials\.backup-2026\.json/, "must point at the backup");
});

test("no notice when nothing was replaced", async (t) => {
    const { auth } = await sandbox(t, { global: GLOBAL_ACCOUNT });

    assert.equal(
        auth.formatReplacementNotice({ path: "/home/u/.memwal/credentials.json" }, GLOBAL_ACCOUNT),
        null,
        "a first sign-in or same-account re-save must stay quiet",
    );
});

test("a pending sign-in warns which account it will replace, before approval", async (t) => {
    const { auth, home } = await sandbox(t, { global: GLOBAL_ACCOUNT });

    const warning = auth.formatPendingSignInWarning();

    assert.ok(warning, "an existing sign-in must be announced before it is replaced");
    assert.match(warning, new RegExp(GLOBAL_ACCOUNT), "must name the account at risk");
    assert.ok(
        warning.includes(join(home, ".memwal", "credentials.json")),
        "must name the file that will be overwritten",
    );
});

test("a first sign-in has nothing to warn about", async (t) => {
    const { auth } = await sandbox(t, {});

    assert.equal(auth.formatPendingSignInWarning(), null);
});

/**
 * Resolution walks up from the working directory (review on PR #701).
 *
 * Checking only `process.cwd()` meant `cd src` — or an MCP host launched with
 * its cwd below the project root — missed the project file and silently used
 * the global account, which is GH #628 one directory deeper. The walk is
 * bounded at the project root so it cannot climb into shared parents.
 */

/** Move into a directory beneath `root`, creating it first. Restoring cwd is
 * left to `sandbox`, whose `t.after` runs first and would delete these roots
 * out from under a second chdir. */
function chdirBelow(root, ...segments) {
    const dir = join(root, ...segments);
    mkdirSync(dir, { recursive: true });
    process.chdir(dir);
    return dir;
}

test("a subdirectory of the project resolves to the project's credentials", async (t) => {
    const { auth, cwd } = await sandbox(t, {
        global: GLOBAL_ACCOUNT,
        project: PROJECT_ACCOUNT,
    });
    chdirBelow(cwd, "src", "nested");

    assert.equal(
        auth.credsPath(),
        join(cwd, ".memwal", "credentials.json"),
        "running from a subfolder must still find the project file",
    );
    assert.equal(auth.loadCreds()?.accountId, PROJECT_ACCOUNT);
});

test("the walk stops at the project root and does not climb into shared parents", async (t) => {
    const { auth, home, cwd } = await sandbox(t, {
        global: GLOBAL_ACCOUNT,
        project: PROJECT_ACCOUNT,
    });
    // `cwd/.memwal` now stands in for a stray file in a shared parent — a home
    // directory, /tmp, a workspace root holding unrelated checkouts. A repo
    // below it must not adopt credentials from outside itself.
    const repo = join(cwd, "repo");
    mkdirSync(join(repo, ".git"), { recursive: true });
    chdirBelow(repo, "src");

    assert.equal(
        auth.credsPath(),
        join(home, ".memwal", "credentials.json"),
        "a file above the project root is out of scope; fall back to global",
    );
    assert.equal(auth.loadCreds()?.accountId, GLOBAL_ACCOUNT);
});

test("clearCreds reports the file it actually removed", async (t) => {
    const { auth, home } = await sandbox(t, { global: GLOBAL_ACCOUNT });
    const path = join(home, ".memwal", "credentials.json");

    const result = auth.clearCreds();

    assert.equal(result.removedPath, path);
    assert.equal(result.fallbackPath, undefined, "nothing survives a complete sign-out");
    assert.equal(existsSync(path), false);
});

test("removing a project file reports the global one that takes over", async (t) => {
    const { auth, home, cwd } = await sandbox(t, {
        global: GLOBAL_ACCOUNT,
        project: PROJECT_ACCOUNT,
    });

    const result = auth.clearCreds();

    // Without this the caller names the global file as "removed" and the user
    // is silently switched to another account on the next run.
    assert.equal(result.removedPath, join(cwd, ".memwal", "credentials.json"));
    assert.equal(result.fallbackPath, join(home, ".memwal", "credentials.json"));
    assert.equal(auth.loadCreds()?.accountId, GLOBAL_ACCOUNT, "the global file is untouched");
});

test("clearCreds with nothing to remove reports nothing", async (t) => {
    const { auth } = await sandbox(t, {});

    assert.deepEqual(auth.clearCreds(), {});
});
