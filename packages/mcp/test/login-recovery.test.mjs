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
    process.env.HOME = home;
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
