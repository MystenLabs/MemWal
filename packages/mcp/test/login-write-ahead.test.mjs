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
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync, statSync, rmSync, chmodSync } from "node:fs";
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
    // A flow that fails BEFORE publishing — the write-ahead record cannot be
    // written, say — must surface here as a rejection. Awaiting `urlReady`
    // alone would hang forever on a URL that is never coming.
    const failedEarly = flow.then(() => {
        throw new Error("login resolved without ever publishing a URL");
    });
    failedEarly.catch(() => {});
    return { flow, url: new URL(await Promise.race([urlReady, failedEarly])) };
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

    // Same handling as credentials.json — owner-only. Windows does not enforce
    // POSIX mode bits, and `savePendingLogin` treats `chmodSync` as best-effort
    // there, so asserting them would test the platform rather than the code.
    if (process.platform !== "win32") {
        assert.equal(
            statSync(pendingPath(home)).mode & 0o777,
            0o600,
            "pending login must be owner-only, like credentials.json",
        );
    }

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

/**
 * Recovery only runs at process start, and is skipped for `--login` /
 * `forceLogin`. So a login that times out, followed by `memwal_login` in the
 * same process, used to mint a fresh keypair and overwrite the record — and if
 * the browser had already paid for `add_delegate_key` on the first key, the
 * private half went with it.
 */
test("a second login for the same relayer reuses the stranded keypair", async (t) => {
    const home = freshHome();
    t.after(() => rmSync(home, { recursive: true, force: true }));

    const first = await startLogin();
    const stranded = JSON.parse(readFileSync(pendingPath(home), "utf8"));
    first.flow.catch(() => {});

    const second = await startLogin();
    const after = JSON.parse(readFileSync(pendingPath(home), "utf8"));
    second.flow.catch(() => {});

    assert.equal(
        after.delegatePrivateKey,
        stranded.delegatePrivateKey,
        "the paid-for key must not be replaced by a second attempt",
    );
    assert.equal(
        second.url.searchParams.get("publicKey")?.toLowerCase(),
        stranded.delegatePublicKeyHex.toLowerCase(),
        "the browser should be sent the key that may already be registered",
    );
    assert.equal(
        after.createdAt,
        stranded.createdAt,
        "reusing must not extend the TTL past the attempt that may have registered it",
    );
});

test("a login against a different relayer does not reuse the record", async (t) => {
    // A key registered against one relayer's account proves nothing to
    // another, and recovery must never repoint a record at a new relayer.
    const home = freshHome();
    t.after(() => rmSync(home, { recursive: true, force: true }));

    const first = await startLogin();
    const stranded = JSON.parse(readFileSync(pendingPath(home), "utf8"));
    first.flow.catch(() => {});

    const second = await startLogin({ relayerUrl: "https://other-relayer.example" });
    const after = JSON.parse(readFileSync(pendingPath(home), "utf8"));
    second.flow.catch(() => {});

    assert.notEqual(after.delegatePrivateKey, stranded.delegatePrivateKey);
    assert.equal(after.relayerUrl, "https://other-relayer.example");
});

test("a login refuses to start when the write-ahead record cannot be persisted", async (t) => {
    // The whole invariant is that the key is durable before its public half can
    // reach a browser that will pay to register it. Continuing anyway would
    // publish the URL while only pretending to hold that.
    const home = freshHome();
    const dir = join(home, ".memwal");
    mkdirSync(dir, { recursive: true });
    t.after(() => {
        try {
            chmodSync(dir, 0o700);
        } catch {
            /* nothing to restore */
        }
        rmSync(home, { recursive: true, force: true });
    });

    // Read-only directory. Root ignores mode bits, and Windows does not
    // enforce them at all, so only assert where the setup actually bites.
    chmodSync(dir, 0o500);
    let writable = true;
    try {
        writeFileSync(join(dir, ".probe"), "x");
    } catch {
        writable = false;
    }
    t.diagnostic(`credentials dir writable after chmod 0500: ${writable}`);
    if (writable) {
        t.skip("the sandbox directory is still writable — cannot provoke the failure here");
        return;
    }

    await assert.rejects(
        () => startLogin(),
        /write-ahead/i,
        "the login must fail loudly rather than publish a URL it cannot back",
    );
    assert.equal(existsSync(pendingPath(home)), false, "nothing should have been written");
});

/**
 * `clearPendingLogin()` used to run only after a successful callback. CLI
 * `--logout` and the `memwal_logout` tool both cleared `credentials.json`
 * alone, so an interrupted re-login left the pending key behind and the next
 * start's `recoverPendingLogin` signed the user straight back in — a logout
 * that undid itself.
 */
test("logging out discards the pending record, not just the credentials", async (t) => {
    const home = freshHome();
    t.after(() => rmSync(home, { recursive: true, force: true }));

    const { flow } = await startLogin();
    flow.catch(() => {});
    assert.ok(existsSync(pendingPath(home)), "precondition: a pending record exists");

    const { main } = await import(`../dist/index.js?t=${Date.now()}${Math.random()}`);
    await main(["--logout"]);

    assert.equal(
        existsSync(pendingPath(home)),
        false,
        "an explicit logout must not leave a key that signs the user back in",
    );
});

test("clearing credentials on its own keeps the pending record", async (t) => {
    // Discarding a key that may still be reclaimable is a decision only an
    // explicit sign-out gets to make, which is why the pending clear lives in
    // the logout paths rather than inside `clearCreds` (which is exported, and
    // which a relayer 401 deliberately does not call).
    const home = freshHome();
    t.after(() => rmSync(home, { recursive: true, force: true }));

    const { flow } = await startLogin();
    flow.catch(() => {});
    assert.ok(existsSync(pendingPath(home)), "precondition: a pending record exists");

    const { clearCreds } = await import(`../dist/auth.js?t=${Date.now()}${Math.random()}`);
    clearCreds();

    assert.ok(
        existsSync(pendingPath(home)),
        "clearCreds must not discard a key that may still be reclaimable",
    );
});
