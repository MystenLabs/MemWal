/**
 * Repo credentials cannot silently choose the destination (WALM-639).
 *
 * `.memwal/credentials.json` decides the account a memory is written under and
 * the relayer it is written through — and it lives INSIDE the repository, where
 * anyone who can commit, or who can get a clone opened, can put one. Presence
 * alone used to be the opt-in, so opening a project repointed every memory
 * written from it, with nothing said. The writes are immutable and there is no
 * delete path, which is what made this a P1 rather than a papercut.
 *
 * The gate: a project file is inert until the user approves that exact file,
 * account, delegate and relayer, and the approval lives OUTSIDE the repository
 * so a repo cannot carry its own approval. Anything unapproved falls back to
 * the global credentials rather than failing, because a machine that never had
 * a project file must keep behaving exactly as it did.
 *
 * `auth.js` resolves per call, so each test sets HOME and cwd first and then
 * imports with a cache-busting query — the pattern used by
 * credential-resolution.test.mjs.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
    mkdtempSync,
    mkdirSync,
    writeFileSync,
    readFileSync,
    rmSync,
    existsSync,
    realpathSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";

const GLOBAL_ACCOUNT = "0x" + "a".repeat(64);
const PROJECT_ACCOUNT = "0x" + "b".repeat(64);
const ATTACKER_ACCOUNT = "0x" + "9".repeat(64);
const PRIVATE_KEY = "c".repeat(64);
const GLOBAL_RELAYER = "https://relayer.example";
const PROJECT_RELAYER = "https://project-relayer.example";

function makeCreds(overrides = {}) {
    return {
        delegatePrivateKey: PRIVATE_KEY,
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

function writeCredsAt(root, creds) {
    const path = join(root, ".memwal", "credentials.json");
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(creds), { mode: 0o600 });
    return path;
}

/**
 * A HOME, a working directory, and the module re-imported so it sees them.
 *
 * `MEMWAL_CREDS_DIR` is cleared rather than inherited: it overrides resolution
 * outright, so a stray value in the ambient environment would make every
 * assertion here vacuous.
 */
async function sandbox(t, { global: globalCreds, project: projectCreds } = {}) {
    // Canonicalised for the same reason as credential-resolution.test.mjs:
    // `process.cwd()` and `homedir()` report resolved paths, and on macOS
    // `/tmp` is a symlink. Both HOME and USERPROFILE, so it is portable.
    const home = realpathSync(mkdtempSync(join(tmpdir(), "memwal-approve-home-")));
    const cwd = realpathSync(mkdtempSync(join(tmpdir(), "memwal-approve-cwd-")));
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

    const auth = await import(`../dist/auth.js?walm639=${Date.now()}-${Math.random()}`);
    return { auth, home, cwd };
}

/** The two files a sandbox works with. */
const globalFile = (home) => join(home, ".memwal", "credentials.json");
const projectFile = (cwd) => join(cwd, ".memwal", "credentials.json");

/* --------------------------------------------------------------------- *
 * The reproduction itself.
 * --------------------------------------------------------------------- */

test("a repo credentials file alone does not redirect a write", async (t) => {
    const { auth, home, cwd } = await sandbox(t, {
        global: makeCreds(),
        project: makeCreds({ accountId: PROJECT_ACCOUNT, relayerUrl: PROJECT_RELAYER }),
    });

    // Reads resolve to the user's own account...
    assert.equal(auth.credsPath(), globalFile(home));
    assert.equal(auth.loadCreds()?.accountId, GLOBAL_ACCOUNT);
    assert.equal(auth.loadCreds()?.relayerUrl, GLOBAL_RELAYER);

    // ...and so do writes. This is the assertion the ticket asks for: the file
    // the repo carries must not be the file the process signs and saves with.
    auth.saveCreds(makeCreds({ label: "Re-saved" }));
    assert.equal(JSON.parse(readFileSync(globalFile(home), "utf8")).label, "Re-saved");
    const untouched = JSON.parse(readFileSync(projectFile(cwd), "utf8"));
    assert.equal(untouched.accountId, PROJECT_ACCOUNT, "the repo file must not be written");
    assert.equal(untouched.label, undefined);
});

test("running from a subfolder does not redirect a write either", async (t) => {
    // The reporter checked this: the walk that finds the project file climbs,
    // so the gate has to hold at every depth, not just at the project root.
    const { auth, home, cwd } = await sandbox(t, {
        global: makeCreds(),
        project: makeCreds({ accountId: PROJECT_ACCOUNT }),
    });
    const deep = join(cwd, "src", "nested");
    mkdirSync(deep, { recursive: true });
    process.chdir(deep);

    assert.equal(auth.credsPath(), globalFile(home));
    assert.equal(auth.loadCreds()?.accountId, GLOBAL_ACCOUNT);
    assert.equal(auth.resolveCreds().project?.decision, "unapproved");
});

test("the ignored project file is named, along with the destination it wanted", async (t) => {
    // Falling back in silence would be the mirror image of the silent redirect:
    // the user created that file expecting it to be used.
    const { auth, home, cwd } = await sandbox(t, {
        global: makeCreds(),
        project: makeCreds({ accountId: PROJECT_ACCOUNT, relayerUrl: PROJECT_RELAYER }),
    });

    const notice = auth.formatProjectCredsNotice();

    assert.ok(notice, "an ignored project file must be reported");
    assert.ok(notice.includes(projectFile(cwd)), "must name the file that was ignored");
    assert.ok(notice.includes(PROJECT_ACCOUNT), "must name the account it would have used");
    assert.ok(notice.includes(PROJECT_RELAYER), "must name the relayer it would have used");
    assert.ok(notice.includes(globalFile(home)), "must name where memory is going instead");
    assert.match(notice, /approve-project/, "must say how to approve it");
    assert.ok(
        notice.includes(auth.projectApprovalsPath()),
        "must say where the approval is recorded",
    );
});

test("nothing the user can see ever carries the delegate private key", async (t) => {
    const { auth } = await sandbox(t, {
        global: makeCreds(),
        project: makeCreds({ accountId: PROJECT_ACCOUNT }),
    });

    assert.ok(!auth.formatProjectCredsNotice().includes(PRIVATE_KEY));
    auth.approveProjectCreds();
    const record = readFileSync(auth.projectApprovalsPath(), "utf8");
    assert.ok(!record.includes(PRIVATE_KEY), "the approval record must hold no key material");
});

/* --------------------------------------------------------------------- *
 * Approval.
 * --------------------------------------------------------------------- */

test("an approved project file is the one that gets used", async (t) => {
    const { auth, cwd } = await sandbox(t, {
        global: makeCreds(),
        project: makeCreds({ accountId: PROJECT_ACCOUNT, relayerUrl: PROJECT_RELAYER }),
    });

    const result = auth.approveProjectCreds();

    assert.equal(result.outcome, "approved");
    assert.equal(result.accountId, PROJECT_ACCOUNT);
    assert.equal(result.relayerUrl, PROJECT_RELAYER);
    assert.equal(auth.credsPath(), projectFile(cwd));
    assert.equal(auth.loadCreds()?.accountId, PROJECT_ACCOUNT);
    assert.equal(auth.resolveCreds().source, "project");
    assert.equal(auth.formatProjectCredsNotice(), null, "an approved file is not a warning");
});

test("the approval is recorded outside the repository", async (t) => {
    // The whole point: a record the repo could carry is a repo approving itself.
    const { auth, home, cwd } = await sandbox(t, {
        global: makeCreds(),
        project: makeCreds({ accountId: PROJECT_ACCOUNT }),
    });

    auth.approveProjectCreds();

    const approvals = auth.projectApprovalsPath();
    assert.equal(approvals, join(home, ".memwal", "project-approvals.json"));
    assert.ok(!approvals.startsWith(cwd), "the approval must not live in the project");
    assert.equal(existsSync(approvals), true);
});

test("an approvals file committed inside the repo approves nothing", async (t) => {
    const { auth, cwd, home } = await sandbox(t, {
        global: makeCreds(),
        project: makeCreds({ accountId: ATTACKER_ACCOUNT, relayerUrl: PROJECT_RELAYER }),
    });

    // Exactly what the repo would have to ship to self-approve: a well-formed
    // record, in the project's own .memwal, naming its own credentials file.
    const { createHash } = await import("node:crypto");
    const fingerprint = createHash("sha256")
        .update(`${ATTACKER_ACCOUNT}\n0x${"e".repeat(64)}\n${PROJECT_RELAYER}`)
        .digest("hex");
    writeFileSync(
        join(cwd, ".memwal", "project-approvals.json"),
        JSON.stringify({
            version: 1,
            approvals: [
                {
                    path: projectFile(cwd),
                    fingerprint,
                    accountId: ATTACKER_ACCOUNT,
                    delegateAddress: "0x" + "e".repeat(64),
                    relayerUrl: PROJECT_RELAYER,
                    approvedAt: new Date().toISOString(),
                },
            ],
        }),
    );

    assert.equal(auth.credsPath(), globalFile(home), "a repo must not approve itself");
    assert.equal(auth.loadCreds()?.accountId, GLOBAL_ACCOUNT);
    assert.equal(auth.resolveCreds().project?.decision, "unapproved");
});

test("approving one project does not approve another", async (t) => {
    const { auth, home, cwd } = await sandbox(t, {
        global: makeCreds(),
        project: makeCreds({ accountId: PROJECT_ACCOUNT }),
    });
    auth.approveProjectCreds();

    // A second checkout, with the same credentials in it. Approval is per
    // project path, so opening this one is a fresh decision.
    const other = realpathSync(mkdtempSync(join(tmpdir(), "memwal-approve-other-")));
    t.after(() => rmSync(other, { recursive: true, force: true }));
    writeCredsAt(other, makeCreds({ accountId: PROJECT_ACCOUNT }));
    process.chdir(other);

    assert.equal(auth.credsPath(), globalFile(home));
    assert.equal(auth.resolveCreds().project?.decision, "unapproved");
});

/* --------------------------------------------------------------------- *
 * Re-approval after the destination moves.
 * --------------------------------------------------------------------- */

for (const [what, mutation] of [
    ["account", { accountId: ATTACKER_ACCOUNT }],
    ["relayer", { relayerUrl: "https://attacker.example" }],
    ["delegate key", { delegateAddress: "0x" + "7".repeat(64) }],
]) {
    test(`changing the ${what} after approval requires approval again`, async (t) => {
        const { auth, home, cwd } = await sandbox(t, {
            global: makeCreds(),
            project: makeCreds({ accountId: PROJECT_ACCOUNT, relayerUrl: PROJECT_RELAYER }),
        });
        auth.approveProjectCreds();
        assert.equal(auth.credsPath(), projectFile(cwd), "precondition: approved and in use");

        // A later commit edits the file the user already approved.
        writeCredsAt(
            cwd,
            makeCreds({
                accountId: PROJECT_ACCOUNT,
                relayerUrl: PROJECT_RELAYER,
                ...mutation,
            }),
        );

        assert.equal(auth.credsPath(), globalFile(home), "a moved destination must not be used");
        assert.equal(auth.resolveCreds().project?.decision, "changed");
        const notice = auth.formatProjectCredsNotice();
        assert.match(notice, /changed since you/, `notice did not report the change:\n${notice}`);
    });
}

test("re-approving adopts the new destination and names the old one", async (t) => {
    const { auth, cwd } = await sandbox(t, {
        global: makeCreds(),
        project: makeCreds({ accountId: PROJECT_ACCOUNT, relayerUrl: PROJECT_RELAYER }),
    });
    auth.approveProjectCreds();
    writeCredsAt(cwd, makeCreds({ accountId: ATTACKER_ACCOUNT, relayerUrl: PROJECT_RELAYER }));

    const result = auth.approveProjectCreds();

    assert.equal(result.outcome, "reapproved");
    assert.equal(result.previousAccountId, PROJECT_ACCOUNT, "must name what it replaced");
    assert.equal(result.accountId, ATTACKER_ACCOUNT);
    assert.equal(auth.credsPath(), projectFile(cwd));
});

test("approving the same destination twice writes nothing new", async (t) => {
    const { auth } = await sandbox(t, {
        global: makeCreds(),
        project: makeCreds({ accountId: PROJECT_ACCOUNT }),
    });
    auth.approveProjectCreds();

    assert.equal(auth.approveProjectCreds().outcome, "already-approved");
    const stored = JSON.parse(readFileSync(auth.projectApprovalsPath(), "utf8"));
    assert.equal(stored.approvals.length, 1, "approvals must not accumulate duplicates");
});

test("revoking sends memory back to the global account", async (t) => {
    const { auth, home, cwd } = await sandbox(t, {
        global: makeCreds(),
        project: makeCreds({ accountId: PROJECT_ACCOUNT }),
    });
    auth.approveProjectCreds();
    assert.equal(auth.credsPath(), projectFile(cwd));

    const revoked = auth.revokeProjectCredsApproval();

    assert.equal(revoked.outcome, "revoked");
    assert.equal(auth.credsPath(), globalFile(home));
    assert.equal(auth.revokeProjectCredsApproval().outcome, "none", "revoking twice is a no-op");
});

/* --------------------------------------------------------------------- *
 * The escape hatch, and the cases that must stay quiet.
 * --------------------------------------------------------------------- */

test("MEMWAL_CREDS_DIR still overrides both files, approved or not", async (t) => {
    const { auth, cwd } = await sandbox(t, {
        global: makeCreds(),
        project: makeCreds({ accountId: PROJECT_ACCOUNT }),
    });
    auth.approveProjectCreds();
    assert.equal(auth.credsPath(), projectFile(cwd), "precondition: the project file is in use");

    const override = realpathSync(mkdtempSync(join(tmpdir(), "memwal-approve-override-")));
    t.after(() => {
        delete process.env.MEMWAL_CREDS_DIR;
        rmSync(override, { recursive: true, force: true });
    });
    process.env.MEMWAL_CREDS_DIR = override;

    assert.equal(auth.credsPath(), join(override, "credentials.json"));
    assert.equal(auth.resolveCreds().source, "override");
    assert.equal(auth.formatProjectCredsNotice(), null, "an override has nothing to warn about");
    assert.equal(
        auth.approveProjectCreds().outcome,
        "overridden",
        "there is nothing to approve while the override decides",
    );
});

test("a malformed project credentials file falls back to the global one", async (t) => {
    const { auth, home, cwd } = await sandbox(t, { global: makeCreds() });
    mkdirSync(join(cwd, ".memwal"), { recursive: true });
    writeFileSync(projectFile(cwd), "{ not json");

    assert.equal(auth.credsPath(), globalFile(home));
    assert.equal(auth.loadCreds()?.accountId, GLOBAL_ACCOUNT, "a broken repo file is not a logout");
    assert.equal(auth.resolveCreds().project?.decision, "unreadable");
    assert.match(auth.formatProjectCredsNotice(), /not a valid/);
    assert.equal(auth.approveProjectCreds().outcome, "unreadable");
});

test("a machine with no project file behaves exactly as it always did", async (t) => {
    const { auth, home } = await sandbox(t, { global: makeCreds() });

    assert.equal(auth.credsPath(), globalFile(home));
    assert.equal(auth.loadCreds()?.accountId, GLOBAL_ACCOUNT);
    assert.equal(auth.resolveCreds().source, "global");
    assert.equal(auth.formatProjectCredsNotice(), null, "nothing to report, so nothing is said");
    assert.equal(auth.approveProjectCreds().outcome, "none");
    assert.equal(existsSync(auth.projectApprovalsPath()), false, "no file is created for nothing");
});

test("an unapproved project file does not leave the user signed out", async (t) => {
    // Falling back must not be a fail-closed: a user with only a repo file and
    // no global one still gets the normal signed-out sign-in path, not an error.
    const { auth, home } = await sandbox(t, {
        project: makeCreds({ accountId: PROJECT_ACCOUNT }),
    });

    assert.equal(auth.credsPath(), globalFile(home));
    assert.equal(auth.loadCreds(), null);
    assert.ok(auth.formatProjectCredsNotice(), "and the ignored file is still explained");
});
