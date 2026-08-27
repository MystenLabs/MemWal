/**
 * WALM-332 — the login flow must not lose the delegate private key.
 *
 * The browser registers the delegate key on-chain (a paid, irreversible
 * action) and only then POSTs the callback that causes us to save it. If this
 * process dies in that window, the in-memory keypair is destroyed and the
 * user is left with an on-chain registration nobody holds the key to.
 *
 * The fix is write-ahead: persist the pending keypair BEFORE the browser is
 * able to act on it, and clear it once credentials are safely saved.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, statSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const WEB = "https://memory.example";
const RELAYER = "https://relayer.example";

function freshHome() {
    const home = mkdtempSync(join(tmpdir(), "memwal-writeahead-"));
    // HOME alone is not a sandbox. os.homedir() reads USERPROFILE on Windows
    // and ignores HOME, and credsPath() checks for a project-local .memwal
    // above the working directory before it ever consults the home directory —
    // which here is the real checkout. MEMWAL_CREDS_DIR overrides both, and
    // pointing it at the sandbox's .memwal keeps the paths below unchanged.
    process.env.HOME = home;
    process.env.USERPROFILE = home;
    process.env.MEMWAL_CREDS_DIR = join(home, ".memwal");
    return home;
}

const pendingPath = (home) => join(home, ".memwal", "login-pending.json");
const credsPath = (home) => join(home, ".memwal", "credentials.json");

/** Start a login flow and resolve once the connect URL has been published. */
async function startLogin(overrides = {}) {
    const { loginFlow } = await import(`../dist/login.js?t=${Date.now()}${Math.random()}`);
    let publishUrl;
    const urlReady = new Promise((resolve) => {
        publishUrl = resolve;
    });
    const flow = loginFlow({
        webUrl: WEB,
        relayerUrl: RELAYER,
        label: "Write-ahead test",
        timeoutMs: 4_000,
        openBrowser: false,
        onUrl: publishUrl,
        ...overrides,
    });
    // The flow rejects on timeout; nobody is going to complete it in these
    // tests, so absorb it rather than tripping an unhandled rejection.
    flow.catch(() => {});
    return { flow, url: new URL(await urlReady) };
}

test("the delegate keypair is on disk before the browser is given the connect URL", async (t) => {
    const home = freshHome();
    t.after(() => rmSync(home, { recursive: true, force: true }));

    const { url } = await startLogin();

    // The URL is what the user clicks; by the time it exists, the browser can
    // register this public key on-chain. The private half must already be safe.
    assert.ok(
        existsSync(pendingPath(home)),
        "login-pending.json must exist by the time the connect URL is published",
    );

    const pending = JSON.parse(readFileSync(pendingPath(home), "utf8"));
    const publicKeyInUrl = url.searchParams.get("publicKey");

    assert.equal(
        pending.delegatePublicKeyHex?.toLowerCase(),
        publicKeyInUrl?.toLowerCase(),
        "the persisted record must be for the exact key the browser was sent",
    );
    assert.match(
        pending.delegatePrivateKey ?? "",
        /^(0x)?[0-9a-f]{64}$/i,
        "the private key must be recoverable from the record",
    );
    assert.equal(pending.relayerUrl, RELAYER);
    assert.ok(pending.createdAt, "record needs a timestamp so it can expire");

    // Same handling as credentials.json — owner-only.
    assert.equal(
        statSync(pendingPath(home)).mode & 0o777,
        0o600,
        "pending login must be owner-only, like credentials.json",
    );

    // Nothing has completed, so no credentials yet.
    assert.equal(existsSync(credsPath(home)), false);
});

test("a completed login clears the pending record", async (t) => {
    const home = freshHome();
    t.after(() => rmSync(home, { recursive: true, force: true }));

    const { flow, url } = await startLogin({ timeoutMs: 15_000 });
    const port = url.searchParams.get("port");
    const state = url.searchParams.get("connectState");
    const publicKey = url.searchParams.get("publicKey");

    assert.ok(existsSync(pendingPath(home)), "precondition: pending record written");

    const post = (path, body) =>
        fetch(`http://127.0.0.1:${port}${path}`, {
            method: "POST",
            headers: { "content-type": "application/json", origin: WEB },
            body: JSON.stringify(body),
        });

    await post("/preflight", { state, publicKey, relayer: RELAYER });
    await post("/callback", {
        state,
        accountId: `0x${"1".repeat(64)}`,
        walletAddress: `0x${"2".repeat(64)}`,
        packageId: `0x${"3".repeat(64)}`,
    });

    await flow;

    assert.equal(existsSync(credsPath(home)), true, "credentials should be saved");
    assert.equal(
        existsSync(pendingPath(home)),
        false,
        "pending record must be cleared once the key is safely in credentials.json",
    );
});
