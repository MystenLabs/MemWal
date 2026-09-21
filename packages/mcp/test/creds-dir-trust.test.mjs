/**
 * `MEMWAL_CREDS_DIR` cannot relocate the approval store into a repository, and
 * an approved project never receives a plaintext delegate key it did not ask
 * for (review of WALM-639).
 *
 * Two holes the gate itself left open:
 *
 *   A. `trustedStateDir()` was `process.env.MEMWAL_CREDS_DIR ?? …`. `??` keeps
 *      an empty string, and nothing checked that the value was absolute — so
 *      `MEMWAL_CREDS_DIR=""` made `projectApprovalsPath()` the bare relative
 *      string "project-approvals.json", and `MEMWAL_CREDS_DIR=.memwal` made it
 *      `<repo>/.memwal/project-approvals.json`. Both resolve against the
 *      working directory, which is the repository. And because the override
 *      branch of `resolveCreds()` runs BEFORE any approval lookup, a committed
 *      `.cursor/mcp.json` carrying that one env var got the repo's credentials
 *      used with no approval at all — the exact silent redirect WALM-639 is
 *      about, through the escape hatch instead of around it.
 *
 *   B. `pendingLoginPath()` was `join(dirname(credsPath()), …)`. Once a project
 *      was approved that is `<repo>/.memwal/`, so every sign-in wrote a 64-hex
 *      Ed25519 seed, in plaintext, into the working tree.
 *
 * Same sandbox pattern as project-creds-approval.test.mjs: HOME, cwd and the
 * override are set first, then `auth.js` is imported with a cache-busting query.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
    mkdtempSync,
    mkdirSync,
    writeFileSync,
    readFileSync,
    readdirSync,
    rmSync,
    existsSync,
    realpathSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, isAbsolute, relative } from "node:path";

const GLOBAL_ACCOUNT = "0x" + "a".repeat(64);
const PROJECT_ACCOUNT = "0x" + "b".repeat(64);
const CREDS_KEY = "c".repeat(64);
/** Distinct from CREDS_KEY — and from every other filler above, `packageId`
 * included — so "this key never reaches the repo" is a claim about the pending
 * record specifically and cannot be satisfied or broken by another field. */
const PENDING_KEY = "4".repeat(64);
const GLOBAL_RELAYER = "https://relayer.example";
const PROJECT_RELAYER = "https://project-relayer.example";

function makeCreds(overrides = {}) {
    return {
        delegatePrivateKey: CREDS_KEY,
        delegatePublicKeyHex: "d".repeat(64),
        delegateAddress: "0x" + "e".repeat(64),
        walletAddress: "0x" + "f".repeat(64),
        accountId: GLOBAL_ACCOUNT,
        packageId: "0x" + "1".repeat(64),
        relayerUrl: GLOBAL_RELAYER,
        createdAt: new Date(0).toISOString(),
        version: 1,
        ...overrides,
    };
}

function makePending(overrides = {}) {
    return {
        delegatePrivateKey: PENDING_KEY,
        delegatePublicKeyHex: "2".repeat(64),
        delegateAddress: "0x" + "3".repeat(64),
        relayerUrl: PROJECT_RELAYER,
        createdAt: new Date().toISOString(),
        version: 1,
        ...overrides,
    };
}

function writeCredsAt(root, creds) {
    const path = join(root, ".memwal", "credentials.json");
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(creds), { mode: 0o600 });
    return path;
}

/** Same containment question the module asks: `relative` rather than a string
 * prefix, so `/repo` and `/repo-2` do not look like the same directory. */
function isInside(root, path) {
    const rel = relative(root, path);
    return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

/** Every file at or under `root`, so a secret can be searched for across a
 * whole working tree rather than at the one path a test remembered to check. */
function filesUnder(root) {
    const out = [];
    for (const entry of readdirSync(root, { withFileTypes: true })) {
        const path = join(root, entry.name);
        if (entry.isDirectory()) out.push(...filesUnder(path));
        else if (entry.isFile()) out.push(path);
    }
    return out;
}

/** Paths under `root` whose bytes contain `needle`. */
function filesContaining(root, needle) {
    return filesUnder(root).filter((path) => {
        try {
            return readFileSync(path, "utf8").includes(needle);
        } catch {
            return false;
        }
    });
}

/**
 * A HOME, a working directory, a fresh module, and MEMWAL_CREDS_DIR cleared.
 *
 * Canonicalised because `process.cwd()` and `homedir()` report resolved paths
 * and macOS routes /tmp through /private/tmp — the containment check under test
 * has to hold for the same directory spelled either way.
 */
async function sandbox(t, { global: globalCreds, project: projectCreds, git = false } = {}) {
    const home = realpathSync(mkdtempSync(join(tmpdir(), "memwal-trust-home-")));
    const cwd = realpathSync(mkdtempSync(join(tmpdir(), "memwal-trust-cwd-")));
    const previous = {
        home: process.env.HOME,
        profile: process.env.USERPROFILE,
        credsDir: process.env.MEMWAL_CREDS_DIR,
        cwd: process.cwd(),
    };

    process.env.HOME = home;
    process.env.USERPROFILE = home;
    delete process.env.MEMWAL_CREDS_DIR;
    process.chdir(cwd);

    if (git) mkdirSync(join(cwd, ".git"), { recursive: true });
    if (globalCreds) writeCredsAt(home, globalCreds);
    if (projectCreds) writeCredsAt(cwd, projectCreds);

    t.after(() => {
        process.chdir(previous.cwd);
        process.env.HOME = previous.home;
        process.env.USERPROFILE = previous.profile;
        if (previous.credsDir === undefined) delete process.env.MEMWAL_CREDS_DIR;
        else process.env.MEMWAL_CREDS_DIR = previous.credsDir;
        rmSync(home, { recursive: true, force: true });
        rmSync(cwd, { recursive: true, force: true });
    });

    const bust = `${Date.now()}-${Math.random()}`;
    const auth = await import(`../dist/auth.js?walm639trust=${bust}`);
    return { auth, home, cwd, bust };
}

const globalFile = (home) => join(home, ".memwal", "credentials.json");
const projectFile = (cwd) => join(cwd, ".memwal", "credentials.json");

/* --------------------------------------------------------------------- *
 * A. An empty value means unset — never "the working directory".
 * --------------------------------------------------------------------- */

test('MEMWAL_CREDS_DIR="" does not relocate the approval store into the repo', async (t) => {
    const { auth, home, cwd } = await sandbox(t, {
        global: makeCreds(),
        project: makeCreds({ accountId: PROJECT_ACCOUNT, relayerUrl: PROJECT_RELAYER }),
        git: true,
    });
    process.env.MEMWAL_CREDS_DIR = "";

    const approvals = auth.projectApprovalsPath();

    // The reported repro: `??` kept the empty string, so `join("", FILE)` came
    // back as the bare relative name and resolved against the repo.
    assert.equal(isAbsolute(approvals), true, `approvals path is relative: ${approvals}`);
    assert.notEqual(approvals, "project-approvals.json");
    assert.equal(approvals, join(home, ".memwal", "project-approvals.json"));
    assert.equal(isInside(cwd, approvals), false, "the store must stay out of the repository");
});

test('MEMWAL_CREDS_DIR="" does not silently approve the repo credentials file', async (t) => {
    // The override branch returns before any approval lookup, so an empty value
    // that counted as "set" adopted the repo's account with nothing asked.
    const { auth, home } = await sandbox(t, {
        global: makeCreds(),
        project: makeCreds({ accountId: PROJECT_ACCOUNT, relayerUrl: PROJECT_RELAYER }),
        git: true,
    });
    process.env.MEMWAL_CREDS_DIR = "";

    assert.equal(auth.resolveCreds().source, "global");
    assert.equal(auth.credsPath(), globalFile(home));
    assert.equal(auth.loadCreds()?.accountId, GLOBAL_ACCOUNT);
    assert.equal(auth.resolveCreds().project?.decision, "unapproved");
    assert.ok(auth.formatProjectCredsNotice(), "the ignored repo file is still reported");
});

test('MEMWAL_CREDS_DIR="" lets no repository approve its own credentials', async (t) => {
    // The sharp end of the empty-string bug. `join("", APPROVALS_FILE)` is the
    // bare name "project-approvals.json", which resolves against the working
    // directory — so a repo that commits that one file at its root IS the
    // approval store, and approves the credentials it also ships. Everything
    // the gate does is decided by a file the attacker wrote.
    const { auth, home, cwd } = await sandbox(t, {
        global: makeCreds(),
        project: makeCreds({ accountId: PROJECT_ACCOUNT, relayerUrl: PROJECT_RELAYER }),
        git: true,
    });
    const delegateAddress = "0x" + "e".repeat(64);
    writeFileSync(
        join(cwd, "project-approvals.json"),
        JSON.stringify({
            version: 1,
            approvals: [
                {
                    path: projectFile(cwd),
                    fingerprint: auth.credentialsFingerprint({
                        accountId: PROJECT_ACCOUNT,
                        delegateAddress,
                        relayerUrl: PROJECT_RELAYER,
                    }),
                    accountId: PROJECT_ACCOUNT,
                    delegateAddress,
                    relayerUrl: PROJECT_RELAYER,
                    approvedAt: new Date().toISOString(),
                },
            ],
        }),
    );
    process.env.MEMWAL_CREDS_DIR = "";

    assert.equal(auth.credsPath(), globalFile(home), "a repo approved itself");
    assert.equal(auth.loadCreds()?.accountId, GLOBAL_ACCOUNT);
    assert.equal(auth.resolveCreds().project?.decision, "unapproved");
});

/* --------------------------------------------------------------------- *
 * A. A relative value is refused, loudly.
 * --------------------------------------------------------------------- */

for (const value of [".memwal", "creds", "./.memwal", "../elsewhere", ".claude/state"]) {
    test(`a relative MEMWAL_CREDS_DIR (${value}) is refused, not followed`, async (t) => {
        const { auth, cwd } = await sandbox(t, {
            global: makeCreds(),
            project: makeCreds({ accountId: PROJECT_ACCOUNT, relayerUrl: PROJECT_RELAYER }),
            git: true,
        });
        process.env.MEMWAL_CREDS_DIR = value;

        const refuses = /MEMWAL_CREDS_DIR is a relative path/;
        assert.throws(() => auth.projectApprovalsPath(), refuses);
        assert.throws(() => auth.credsPath(), refuses);
        assert.throws(() => auth.resolveCreds(), refuses);
        assert.throws(() => auth.loadCreds(), refuses);
        // Refusing rather than falling back: a silent fallback would hide a
        // misconfigured — or planted — client config.
        assert.throws(() => auth.approveProjectCreds(), refuses);
        assert.throws(() => auth.saveCreds(makeCreds()), refuses);

        // And nothing landed in the working tree on the way to refusing.
        assert.deepEqual(
            filesUnder(cwd).filter((p) => p.includes("project-approvals")),
            [],
            "an approval record was written inside the repository",
        );
    });
}

test("a relative MEMWAL_CREDS_DIR leaves the repo file unapproved once cleared", async (t) => {
    // The failure mode worth pinning: refusing must not be a disguised approval
    // that shows up the moment the variable goes away.
    const { auth, home, cwd } = await sandbox(t, {
        global: makeCreds(),
        project: makeCreds({ accountId: PROJECT_ACCOUNT, relayerUrl: PROJECT_RELAYER }),
        git: true,
    });
    process.env.MEMWAL_CREDS_DIR = ".memwal";
    assert.throws(() => auth.approveProjectCreds());

    delete process.env.MEMWAL_CREDS_DIR;

    assert.equal(auth.credsPath(), globalFile(home));
    assert.equal(auth.resolveCreds().project?.decision, "unapproved");
    assert.equal(existsSync(join(cwd, ".memwal", "project-approvals.json")), false);
});

test("the refusal is loud at the CLI, not swallowed into a fallback", async (t) => {
    const { cwd, bust } = await sandbox(t, {
        global: makeCreds(),
        project: makeCreds({ accountId: PROJECT_ACCOUNT }),
        git: true,
    });
    const { main } = await import(`../dist/index.js?walm639trust=${bust}`);

    const realTty = process.stdin.isTTY;
    t.after(() => {
        process.stdin.isTTY = realTty;
    });
    process.stdin.isTTY = true;
    process.env.MEMWAL_CREDS_DIR = join(cwd, ".memwal");

    // `bin/memwal-mcp.ts` turns this into `[memwal-mcp] fatal: …` and exit 1,
    // which is the behaviour the launcher already has for a relative runtime
    // directory.
    await assert.rejects(main(["approve-project"]), /MEMWAL_CREDS_DIR/);
});

/* --------------------------------------------------------------------- *
 * A. An absolute value inside the project is refused the same way.
 * --------------------------------------------------------------------- */

test("an absolute MEMWAL_CREDS_DIR inside the project is refused", async (t) => {
    // `${workspaceFolder}` is expanded by editors inside the very config files
    // an attacker can commit, so "absolute" is not evidence a human typed it.
    const { auth, cwd } = await sandbox(t, {
        global: makeCreds(),
        project: makeCreds({ accountId: PROJECT_ACCOUNT }),
        git: true,
    });
    process.env.MEMWAL_CREDS_DIR = join(cwd, ".memwal");

    assert.throws(() => auth.resolveCreds(), /points inside the current project/);
    assert.throws(() => auth.projectApprovalsPath(), /points inside the current project/);
});

test("the refusal is against the project root, not just the working directory", async (t) => {
    // Running from `src/nested` must not launder an override that points at the
    // repository root — the creds walk climbs, so this check has to as well.
    const { auth, cwd } = await sandbox(t, {
        global: makeCreds(),
        project: makeCreds({ accountId: PROJECT_ACCOUNT }),
        git: true,
    });
    const deep = join(cwd, "src", "nested");
    mkdirSync(deep, { recursive: true });
    process.chdir(deep);
    process.env.MEMWAL_CREDS_DIR = join(cwd, ".memwal");

    assert.throws(() => auth.resolveCreds(), /points inside the current project/);
});

/* --------------------------------------------------------------------- *
 * A. The legitimate use keeps working, byte for byte.
 * --------------------------------------------------------------------- */

test("an absolute MEMWAL_CREDS_DIR outside the project still decides everything", async (t) => {
    const { auth, cwd } = await sandbox(t, {
        global: makeCreds(),
        project: makeCreds({ accountId: PROJECT_ACCOUNT, relayerUrl: PROJECT_RELAYER }),
        git: true,
    });
    const override = realpathSync(mkdtempSync(join(tmpdir(), "memwal-trust-override-")));
    t.after(() => rmSync(override, { recursive: true, force: true }));
    process.env.MEMWAL_CREDS_DIR = override;

    assert.equal(auth.credsPath(), join(override, "credentials.json"));
    assert.equal(auth.resolveCreds().source, "override");
    assert.equal(auth.projectApprovalsPath(), join(override, "project-approvals.json"));
    assert.equal(auth.pendingLoginPath(), join(override, "login-pending.json"));
    assert.equal(auth.formatProjectCredsNotice(), null, "an override has nothing to warn about");
    assert.equal(auth.approveProjectCreds().outcome, "overridden");

    // And it is genuinely usable, not merely accepted.
    auth.saveCreds(makeCreds({ label: "sandboxed" }));
    assert.equal(auth.loadCreds()?.label, "sandboxed");
    assert.equal(
        JSON.parse(readFileSync(projectFile(cwd), "utf8")).label,
        undefined,
        "the repo file must not have been written",
    );
});

/* --------------------------------------------------------------------- *
 * B. An approved project never receives a plaintext delegate key.
 * --------------------------------------------------------------------- */

test("the pending-login record for an approved project is not written into it", async (t) => {
    const { auth, home, cwd } = await sandbox(t, {
        global: makeCreds(),
        project: makeCreds({ accountId: PROJECT_ACCOUNT, relayerUrl: PROJECT_RELAYER }),
        git: true,
    });
    auth.approveProjectCreds();
    assert.equal(auth.credsPath(), projectFile(cwd), "precondition: the project file is in use");

    auth.savePendingLogin(makePending());

    const path = auth.pendingLoginPath();
    assert.equal(isInside(cwd, path), false, `the write-ahead record landed in the repo: ${path}`);
    assert.equal(isInside(join(home, ".memwal"), path), true, "it belongs in the trusted dir");
    assert.equal(existsSync(join(cwd, ".memwal", "login-pending.json")), false);
    assert.deepEqual(
        filesContaining(cwd, PENDING_KEY),
        [],
        "a plaintext delegate seed was written somewhere inside the repository",
    );
    // Still a working write-ahead record, which is the whole point of it.
    assert.equal(auth.loadPendingLogin()?.delegatePrivateKey, PENDING_KEY);
    assert.equal(auth.reusablePendingLogin(PROJECT_RELAYER)?.delegatePrivateKey, PENDING_KEY);
    auth.clearPendingLogin();
    assert.equal(auth.loadPendingLogin(), null);
});

test("one project's pending record is not another project's", async (t) => {
    // Keying it by project is why it could live in the repo at all; moving it
    // out must not turn it into one shared record.
    const { auth, cwd } = await sandbox(t, {
        global: makeCreds(),
        project: makeCreds({ accountId: PROJECT_ACCOUNT, relayerUrl: PROJECT_RELAYER }),
        git: true,
    });
    auth.approveProjectCreds();
    auth.savePendingLogin(makePending());
    const first = auth.pendingLoginPath();

    const other = realpathSync(mkdtempSync(join(tmpdir(), "memwal-trust-other-")));
    t.after(() => rmSync(other, { recursive: true, force: true }));
    mkdirSync(join(other, ".git"), { recursive: true });
    writeCredsAt(other, makeCreds({ accountId: PROJECT_ACCOUNT, relayerUrl: PROJECT_RELAYER }));
    process.chdir(other);
    auth.approveProjectCreds();

    assert.notEqual(auth.pendingLoginPath(), first, "two projects share one record");
    assert.equal(auth.loadPendingLogin(), null, "a sign-in leaked across projects");
});

test("the global pending-login path is exactly where it always was", async (t) => {
    const { auth, home } = await sandbox(t, { global: makeCreds() });

    assert.equal(auth.pendingLoginPath(), join(home, ".memwal", "login-pending.json"));
    auth.savePendingLogin(makePending());
    assert.equal(existsSync(join(home, ".memwal", "login-pending.json")), true);
});

/* --------------------------------------------------------------------- *
 * B. And the user is told, rather than left to find the key in a diff.
 * --------------------------------------------------------------------- */

test("approving says a private key will be written inside the repository", async (t) => {
    const { auth, cwd, bust } = await sandbox(t, {
        global: makeCreds(),
        project: makeCreds({ accountId: PROJECT_ACCOUNT, relayerUrl: PROJECT_RELAYER }),
        git: true,
    });
    const { main } = await import(`../dist/index.js?walm639trust=${bust}`);

    const realTty = process.stdin.isTTY;
    const realWrite = process.stderr.write.bind(process.stderr);
    let output = "";
    t.after(() => {
        process.stdin.isTTY = realTty;
        process.stderr.write = realWrite;
    });
    process.stdin.isTTY = true;
    process.stderr.write = (chunk) => {
        output += chunk;
        return true;
    };

    await main(["approve-project"]);
    process.stderr.write = realWrite;

    assert.match(output, /Approved /, "precondition: it approved");
    assert.match(output, /PRIVATE KEY/, `approval said nothing about the key:\n${output}`);
    assert.match(output, /\.gitignore/, "no suggestion for keeping it out of the repo");
    assert.ok(output.includes(join(cwd, ".memwal")), "must name the directory in the repo");
});

test("the warning is repeated at the last moment before a key is written", async (t) => {
    // Approval may have happened months ago, or on someone else's shift. The
    // sign-in warning is the last point the user can back out for free.
    const { auth, cwd } = await sandbox(t, {
        global: makeCreds(),
        project: makeCreds({ accountId: PROJECT_ACCOUNT, relayerUrl: PROJECT_RELAYER }),
        git: true,
    });
    auth.approveProjectCreds();

    const warning = auth.formatPendingSignInWarning();

    assert.ok(warning.includes(projectFile(cwd)), "must name the file being replaced");
    assert.match(warning, /PRIVATE KEY/);
    assert.match(warning, /\.gitignore/);
});

test("a global sign-in is not nagged about a repository it is not in", async (t) => {
    const { auth, home } = await sandbox(t, { global: makeCreds() });

    const warning = auth.formatPendingSignInWarning();

    assert.ok(warning.includes(globalFile(home)));
    assert.doesNotMatch(warning, /gitignore/, "nothing repo-shaped to say about the global file");
});

test("nothing the storage warning prints is key material", async (t) => {
    const { auth, cwd } = await sandbox(t, {
        global: makeCreds(),
        project: makeCreds({ accountId: PROJECT_ACCOUNT }),
    });

    const warning = auth.formatProjectCredsStorageWarning(projectFile(cwd));

    assert.ok(!warning.includes(CREDS_KEY));
    assert.ok(!warning.includes(PENDING_KEY));
});
