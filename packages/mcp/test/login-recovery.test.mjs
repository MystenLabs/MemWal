/**
 * WALM-332 — reclaiming a delegate key stranded by an interrupted login.
 *
 * The write-ahead record keeps the key alive; these cover turning it back
 * into usable credentials, and the cases where we must NOT.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { existsSync, mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ACCOUNT = `0x${"a".repeat(64)}`;
const OWNER = `0x${"b".repeat(64)}`;
const PACKAGE = `0x${"c".repeat(64)}`;

function freshHome() {
    const home = mkdtempSync(join(tmpdir(), "memwal-recovery-"));
    // HOME alone is not a sandbox. os.homedir() reads USERPROFILE on Windows
    // and ignores HOME, and credsPath() checks for a project-local .memwal
    // above the working directory before it ever consults the home directory —
    // which here is the real checkout. MEMWAL_CREDS_DIR overrides both, and
    // pointing it at the sandbox's .memwal keeps the paths below unchanged.
    process.env.HOME = home;
    process.env.USERPROFILE = home;
    process.env.MEMWAL_CREDS_DIR = join(home, ".memwal");
    mkdirSync(join(home, ".memwal"), { recursive: true });
    return home;
}

const pendingPath = (h) => join(h, ".memwal", "login-pending.json");
const credsPath = (h) => join(h, ".memwal", "credentials.json");

/** A relayer that answers /api/whoami however the test wants. */
function startWhoami(handler) {
    const server = http.createServer((req, res) => {
        const url = new URL(req.url, "http://127.0.0.1");
        if (url.pathname !== "/api/whoami") {
            res.writeHead(404).end();
            return;
        }
        handler(req, res);
    });
    return new Promise((r) =>
        server.listen(0, "127.0.0.1", () =>
            r({ server, url: `http://127.0.0.1:${server.address().port}` }),
        ),
    );
}

const okWhoami = (req, res) => {
    // Assert the client proved possession rather than just asking nicely.
    for (const h of ["x-public-key", "x-signature", "x-timestamp", "x-nonce"]) {
        if (!req.headers[h]) {
            res.writeHead(400).end(JSON.stringify({ missing: h }));
            return;
        }
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ account_id: ACCOUNT, owner: OWNER, package_id: PACKAGE }));
};

function writePending(home, relayerUrl, overrides = {}) {
    const pending = {
        delegatePrivateKey: "11".repeat(32),
        delegatePublicKeyHex: "22".repeat(32),
        delegateAddress: `0x${"3".repeat(64)}`,
        relayerUrl,
        label: "Recovery test",
        createdAt: new Date().toISOString(),
        version: 1,
        ...overrides,
    };
    writeFileSync(pendingPath(home), JSON.stringify(pending), { mode: 0o600 });
    return pending;
}

const importRecovery = () => import(`../dist/recovery.js?t=${Date.now()}${Math.random()}`);

test("a stranded key is reclaimed into usable credentials", async (t) => {
    const home = freshHome();
    const { server, url } = await startWhoami(okWhoami);
    t.after(() => {
        server.close();
        rmSync(home, { recursive: true, force: true });
    });

    const pending = writePending(home, url);
    const { recoverPendingLogin } = await importRecovery();
    const result = await recoverPendingLogin();

    assert.equal(result.outcome, "recovered");

    const creds = JSON.parse(readFileSync(credsPath(home), "utf8"));
    assert.equal(creds.accountId, ACCOUNT, "accountId comes from the relayer");
    assert.equal(creds.walletAddress, OWNER);
    assert.equal(creds.packageId, PACKAGE);
    assert.equal(
        creds.delegatePrivateKey,
        pending.delegatePrivateKey,
        "the reclaimed key must be the one that was registered",
    );
    assert.equal(
        existsSync(pendingPath(home)),
        false,
        "pending record cleared once the key is safe",
    );
});

test("recovery never rolls back a newer sign-in", async (t) => {
    const home = freshHome();
    const { server, url } = await startWhoami(okWhoami);
    t.after(() => {
        server.close();
        rmSync(home, { recursive: true, force: true });
    });

    // Pending login started BEFORE the credentials currently on disk: the user
    // gave up on it and signed in again. Adopting it would silently downgrade
    // them to a key they already abandoned.
    writePending(home, url, { createdAt: new Date(Date.now() - 60_000).toISOString() });
    const current = {
        delegatePrivateKey: "99".repeat(32),
        delegatePublicKeyHex: "88".repeat(32),
        delegateAddress: `0x${"7".repeat(64)}`,
        walletAddress: OWNER,
        accountId: `0x${"d".repeat(64)}`,
        packageId: PACKAGE,
        relayerUrl: url,
        createdAt: new Date().toISOString(),
        version: 1,
    };
    writeFileSync(credsPath(home), JSON.stringify(current), { mode: 0o600 });

    const { recoverPendingLogin } = await importRecovery();
    const result = await recoverPendingLogin();

    assert.equal(result.outcome, "superseded");
    const after = JSON.parse(readFileSync(credsPath(home), "utf8"));
    assert.deepEqual(after, current, "existing credentials must be untouched");
    assert.ok(result.strandedPublicKey, "the abandoned key is still reported so it can be revoked");
});

test("a rejected key is reported but never deleted", async (t) => {
    const home = freshHome();
    // 401 is ambiguous — on testnet even a valid registered key is rejected
    // for want of an account hint. Deleting here would destroy a paid key.
    const { server, url } = await startWhoami((_req, res) => {
        res.writeHead(401).end("{}");
    });
    t.after(() => {
        server.close();
        rmSync(home, { recursive: true, force: true });
    });

    writePending(home, url);
    const { recoverPendingLogin, formatStrandedLoginNotice } = await importRecovery();
    const result = await recoverPendingLogin();

    assert.equal(result.outcome, "rejected");
    assert.equal(
        existsSync(pendingPath(home)),
        true,
        "the record must survive an ambiguous rejection",
    );
    assert.equal(existsSync(credsPath(home)), false, "no credentials written");

    const notice = formatStrandedLoginNotice(result);
    assert.match(notice, /22{10}/, "the notice names the key so it can be revoked");
    // Signing in again reuses this key, and the dashboard's add_delegate_key
    // aborts on one already registered, so that alone cannot recover an
    // approved key.
    assert.match(
        notice,
        /cannot\s+register a key that is already there/,
        "must not promise that signing in again recovers a key the user approved",
    );
});

test("an unreachable relayer keeps the record for a later attempt", async (t) => {
    const home = freshHome();
    t.after(() => rmSync(home, { recursive: true, force: true }));

    // Nothing is listening on this port.
    writePending(home, "http://127.0.0.1:1");
    const { recoverPendingLogin } = await importRecovery();
    const result = await recoverPendingLogin();

    assert.equal(result.outcome, "unavailable");
    assert.equal(existsSync(pendingPath(home)), true);
});

test("an expired pending record is discarded rather than recovered", async (t) => {
    const home = freshHome();
    const { server, url } = await startWhoami(okWhoami);
    t.after(() => {
        server.close();
        rmSync(home, { recursive: true, force: true });
    });

    writePending(home, url, {
        createdAt: new Date(Date.now() - 25 * 60 * 60_000).toISOString(),
    });
    const { recoverPendingLogin } = await importRecovery();
    const result = await recoverPendingLogin();

    assert.equal(result.outcome, "no-pending");
    assert.equal(existsSync(pendingPath(home)), false, "expired record is cleaned up");
    assert.equal(existsSync(credsPath(home)), false);
});

test("no pending record is a silent no-op", async (t) => {
    const home = freshHome();
    t.after(() => rmSync(home, { recursive: true, force: true }));

    const { recoverPendingLogin, formatStrandedLoginNotice } = await importRecovery();
    const result = await recoverPendingLogin();

    assert.equal(result.outcome, "no-pending");
    assert.equal(formatStrandedLoginNotice(result), null);
});

/**
 * The relayer freshness-checks `x-timestamp` against `Utc::now().timestamp()`
 * — SECONDS. `String(Date.now())` is milliseconds, ~10^12, which is outside
 * every drift window there will ever be, so whoami 401'd on every attempt and
 * recovery could not have worked at all.
 */
test("whoami signs a Unix timestamp in seconds, not milliseconds", async (t) => {
    const home = freshHome();
    let seen = null;
    const { server, url } = await startWhoami((req, res) => {
        seen = req.headers["x-timestamp"];
        okWhoami(req, res);
    });
    t.after(() => {
        server.close();
        rmSync(home, { recursive: true, force: true });
    });

    writePending(home, url);
    const { recoverPendingLogin } = await importRecovery();
    await recoverPendingLogin();

    assert.match(seen ?? "", /^\d{10}$/, `expected 10-digit seconds, got ${seen}`);
    const skew = Math.abs(Number(seen) - Math.floor(Date.now() / 1000));
    assert.ok(skew < 300, `timestamp is ${skew}s from now — outside the relayer's window`);
});

/**
 * `rejected` tells the user to sign in again and revoke the key. That advice is
 * actively harmful when the relayer merely could not reach Sui: the key is
 * fine, and re-registering costs gas for nothing.
 */
for (const [label, status, headers] of [
    ["a 503 with AUTH_UPSTREAM_UNAVAILABLE", 503, { "x-auth-error": "AUTH_UPSTREAM_UNAVAILABLE" }],
    ["a bare 500", 500, {}],
    ["a 429", 429, {}],
    ["a 404 from a relayer without the route", 404, {}],
]) {
    test(`${label} is retryable, not a rejection`, async (t) => {
        const home = freshHome();
        const { server, url } = await startWhoami((_req, res) => {
            res.writeHead(status, headers).end("{}");
        });
        t.after(() => {
            server.close();
            rmSync(home, { recursive: true, force: true });
        });

        writePending(home, url);
        const { recoverPendingLogin, formatStrandedLoginNotice } = await importRecovery();
        const result = await recoverPendingLogin();

        assert.equal(result.outcome, "unavailable", `status ${status} should not read as a denial`);
        assert.equal(existsSync(pendingPath(home)), true, "the record must survive");

        const notice = formatStrandedLoginNotice(result);
        assert.doesNotMatch(
            notice,
            /revoke/i,
            "must not send the user to revoke a key that may be perfectly good",
        );
        assert.match(notice, /retried/i, "should say it will be retried");
    });
}

test("a 401 carrying AUTH_UPSTREAM_UNAVAILABLE is still retryable", async (t) => {
    // The status alone is not enough: the header is what distinguishes
    // "we could not check" from "we checked and said no".
    const home = freshHome();
    const { server, url } = await startWhoami((_req, res) => {
        res.writeHead(401, { "x-auth-error": "AUTH_UPSTREAM_UNAVAILABLE" }).end("{}");
    });
    t.after(() => {
        server.close();
        rmSync(home, { recursive: true, force: true });
    });

    writePending(home, url);
    const { recoverPendingLogin } = await importRecovery();
    assert.equal((await recoverPendingLogin()).outcome, "unavailable");
});

test("a 200 that is not a whoami body is retryable, not a rejection", async (t) => {
    // Means we are not talking to the endpoint we think we are — nothing has
    // denied this key.
    const home = freshHome();
    const { server, url } = await startWhoami((_req, res) => {
        res.writeHead(200, { "content-type": "application/json" }).end('{"hello":"world"}');
    });
    t.after(() => {
        server.close();
        rmSync(home, { recursive: true, force: true });
    });

    writePending(home, url);
    const { recoverPendingLogin } = await importRecovery();
    assert.equal((await recoverPendingLogin()).outcome, "unavailable");
});

test("a plain 401 is still a rejection", async (t) => {
    // Regression guard on the split above: widening `unavailable` must not
    // swallow the one case where the relayer really did deny the identity.
    const home = freshHome();
    const { server, url } = await startWhoami((_req, res) => {
        res.writeHead(401).end("{}");
    });
    t.after(() => {
        server.close();
        rmSync(home, { recursive: true, force: true });
    });

    writePending(home, url);
    const { recoverPendingLogin } = await importRecovery();
    assert.equal((await recoverPendingLogin()).outcome, "rejected");
});

/* ------------------------------------------------------------------------- *
 * WALM-646 — recovery must say when it changed the active account.
 *
 * `recoverPendingLogin` called `saveCreds` and threw the result away, so the
 * user saw only "Recovered credentials from an interrupted sign-in (delegate
 * 0x…)". Nothing was lost — `backupIfReplacingAnotherAccount` still ran — but
 * nothing said the ACTIVE ACCOUNT HAD CHANGED either.
 *
 * It changes across accounts more easily than it looks. The supersede guard
 * bails only when `existing.createdAt >= pending.createdAt`, so a pending
 * record newer than the saved credentials wins — right for the same account,
 * but it fires across accounts too. Sign in as A, start a sign-in for B,
 * abandon it after wallet approval, and the next client start is B. Every
 * memory appears to have vanished and the only clue was a log line.
 *
 * These stub `fetch` rather than standing up a server like the tests above.
 * What is under test is the save-and-report path, not the HTTP contract — the
 * reclaim tests already prove the client signs its whoami — and a stub keeps
 * the account timeline explicit instead of hidden behind a live handler.
 * ------------------------------------------------------------------------- */

const ACCOUNT_B = `0x${"d".repeat(64)}`;

/** Answer /api/whoami as `accountId`, with no socket involved. */
function stubWhoami(t, accountId) {
    const real = globalThis.fetch;
    globalThis.fetch = async () =>
        new Response(
            JSON.stringify({ account_id: accountId, owner: OWNER, package_id: PACKAGE }),
            { status: 200, headers: { "content-type": "application/json" } },
        );
    t.after(() => {
        globalThis.fetch = real;
    });
}

/** Credentials already on disk, older than any pending record written after. */
function writeExistingCreds(home, accountId) {
    const creds = {
        delegatePrivateKey: "99".repeat(32),
        delegatePublicKeyHex: "88".repeat(32),
        delegateAddress: `0x${"7".repeat(64)}`,
        walletAddress: OWNER,
        accountId,
        packageId: PACKAGE,
        relayerUrl: "https://relayer.example",
        label: "Already signed in",
        createdAt: new Date(Date.now() - 60_000).toISOString(),
        version: 1,
    };
    writeFileSync(credsPath(home), JSON.stringify(creds), { mode: 0o600 });
    return creds;
}

test("recovery onto a different account reports the switch", async (t) => {
    const home = freshHome();
    t.after(() => rmSync(home, { recursive: true, force: true }));
    writeExistingCreds(home, ACCOUNT);
    writePending(home, "https://relayer.example");
    stubWhoami(t, ACCOUNT_B);

    const { recoverPendingLogin } = await importRecovery();
    const result = await recoverPendingLogin();

    assert.equal(result.outcome, "recovered");
    assert.ok(result.saved, "the saveCreds result must be consumed, not discarded");
    assert.equal(result.saved.replacedAccountId, ACCOUNT, "names the account being left");
    assert.ok(result.replacementNotice, "a cross-account recovery must produce a notice");
    assert.match(result.replacementNotice, new RegExp(ACCOUNT), "must name the outgoing account");
    assert.match(result.replacementNotice, new RegExp(ACCOUNT_B), "must name the incoming account");
});

test("the recovery notice is word-for-word the one the normal login path prints", async (t) => {
    const home = freshHome();
    t.after(() => rmSync(home, { recursive: true, force: true }));
    writeExistingCreds(home, ACCOUNT);
    writePending(home, "https://relayer.example");
    stubWhoami(t, ACCOUNT_B);

    const { recoverPendingLogin } = await importRecovery();
    const result = await recoverPendingLogin();

    // Two paths describing the same event differently is its own bug. Both go
    // through formatReplacementNotice, and this pins that they still do.
    const { formatReplacementNotice } = await import(`../dist/auth.js?t=${Date.now()}`);
    assert.equal(result.replacementNotice, formatReplacementNotice(result.saved, ACCOUNT_B));
});

test("recovery within the same account stays quiet", async (t) => {
    const home = freshHome();
    t.after(() => rmSync(home, { recursive: true, force: true }));
    writeExistingCreds(home, ACCOUNT);
    writePending(home, "https://relayer.example");
    stubWhoami(t, ACCOUNT);

    const { recoverPendingLogin } = await importRecovery();
    const result = await recoverPendingLogin();

    assert.equal(result.outcome, "recovered");
    // Reclaiming your own interrupted sign-in is routine. Warning about it
    // would train the user to skip the warning that matters.
    assert.equal(result.replacementNotice, undefined);
    assert.equal(result.saved.replacedAccountId, undefined);
});

test("a first-ever recovery has no account to report leaving", async (t) => {
    const home = freshHome();
    t.after(() => rmSync(home, { recursive: true, force: true }));
    writePending(home, "https://relayer.example");
    stubWhoami(t, ACCOUNT_B);

    const { recoverPendingLogin } = await importRecovery();
    const result = await recoverPendingLogin();

    assert.equal(result.outcome, "recovered");
    assert.equal(result.replacementNotice, undefined, "nothing was displaced");
});

test("the displaced account's file is still backed up, and the notice points at it", async (t) => {
    const home = freshHome();
    t.after(() => rmSync(home, { recursive: true, force: true }));
    writeExistingCreds(home, ACCOUNT);
    writePending(home, "https://relayer.example");
    stubWhoami(t, ACCOUNT_B);

    const { recoverPendingLogin } = await importRecovery();
    const result = await recoverPendingLogin();

    assert.ok(result.saved.backedUpTo, "the outgoing account's file must be recoverable");
    assert.equal(existsSync(result.saved.backedUpTo), true);
    assert.match(result.replacementNotice, /credentials\.backup/, "tell the user where it went");
    const backed = JSON.parse(readFileSync(result.saved.backedUpTo, "utf8"));
    assert.equal(backed.accountId, ACCOUNT);
});
