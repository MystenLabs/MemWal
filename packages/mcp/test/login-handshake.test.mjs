/**
 * Security test for the pre-sign handshake added in issue #368.
 *
 * The consent page must be able to prove a request came from a bridge running
 * on THIS machine before it signs `add_delegate_key` on-chain. `loginFlow`
 * exposes `GET /handshake?state=` for exactly that: it answers `{ ok: true }`
 * only when the supplied state matches the single-use token the bridge minted
 * and embedded in the URL it opened. A phishing link carries an attacker-chosen
 * state (or reaches no bridge at all), so it must be rejected.
 *
 * We drive the real localhost listener `loginFlow` starts (openBrowser: false),
 * probe the handshake with correct / wrong / missing tokens, then complete the
 * flow with a valid callback so the server shuts down cleanly.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { loginFlow } from "../dist/login.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
void resolve(__dirname);

const WEB_URL = "http://localhost:41234"; // expected Origin; no real server needed
const ACCOUNT_ID = "0x" + "a".repeat(64);
const WALLET = "0x" + "b".repeat(64);
const PACKAGE_ID = "0x" + "c".repeat(64);

/** POST a JSON callback to the bridge with a controllable Origin header. */
function postCallback(port, bodyObj, origin = WEB_URL) {
    const body = JSON.stringify(bodyObj);
    return new Promise((res, rej) => {
        const req = http.request(
            {
                host: "127.0.0.1",
                port,
                path: "/callback",
                method: "POST",
                headers: {
                    "content-type": "application/json",
                    "content-length": Buffer.byteLength(body),
                    origin,
                },
            },
            (r) => {
                let buf = "";
                r.on("data", (c) => (buf += c));
                r.on("end", () => res({ status: r.statusCode, body: buf }));
            },
        );
        req.on("error", rej);
        req.end(body);
    });
}

test("GET /handshake gates the flow on the single-use state token", async (t) => {
    const home = mkdtempSync(join(tmpdir(), "memwal-handshake-"));
    const prevHome = process.env.HOME;
    const prevUserProfile = process.env.USERPROFILE;
    // saveCreds writes under HOME on a successful callback — keep it off the
    // real ~/.memwal.
    process.env.HOME = home;
    process.env.USERPROFILE = home;
    t.after(() => {
        process.env.HOME = prevHome;
        process.env.USERPROFILE = prevUserProfile;
        rmSync(home, { recursive: true, force: true });
    });

    let connectUrl = "";
    const flow = loginFlow({
        openBrowser: false,
        webUrl: WEB_URL,
        relayerUrl: "http://127.0.0.1:1",
        label: "Handshake Test",
        timeoutMs: 20_000,
        onUrl: (u) => {
            connectUrl = u;
        },
    });

    // Wait for the listener to be ready and surface its URL.
    await new Promise((r) => setTimeout(r, 100));
    assert.ok(connectUrl, "loginFlow should surface the connect URL via onUrl");

    const parsed = new URL(connectUrl);
    const port = parsed.searchParams.get("port");
    const token = parsed.searchParams.get("connectState");
    assert.match(port ?? "", /^\d+$/, "URL should carry a numeric port");
    assert.match(token ?? "", /^[0-9a-f]{64}$/, "URL should carry a 64-hex state token");

    const handshake = (state) =>
        fetch(`http://127.0.0.1:${port}/handshake?state=${state}`).then(async (r) => ({
            status: r.status,
            body: await r.json().catch(() => null),
        }));

    // Probe before asserting so the server is always torn down via the callback
    // below even if an expectation fails.
    const good = await handshake(token);
    const wrong = await handshake("f".repeat(64));
    const missing = await fetch(`http://127.0.0.1:${port}/handshake`).then(async (r) => ({
        status: r.status,
        body: await r.json().catch(() => null),
    }));

    // Complete the flow with a legitimate callback so loginFlow resolves and
    // closes its listener.
    const cb = await postCallback(port, {
        accountId: ACCOUNT_ID,
        walletAddress: WALLET,
        packageId: PACKAGE_ID,
        state: token,
        txDigest: "0x" + "d".repeat(64),
        label: "Handshake Test",
    });
    const creds = await flow;

    // Correct token → authorized.
    assert.equal(good.status, 200, "correct state should return 200");
    assert.equal(good.body?.ok, true, "correct state should return { ok: true }");

    // Attacker-chosen token → refused (this is what defeats the phishing link).
    assert.equal(wrong.status, 403, "wrong state should return 403");
    assert.equal(wrong.body?.ok, false, "wrong state should return { ok: false }");

    // Missing token → refused.
    assert.equal(missing.status, 403, "missing state should return 403");
    assert.equal(missing.body?.ok, false, "missing state should return { ok: false }");

    // Sanity: the legitimate callback still works end-to-end.
    assert.equal(cb.status, 200, "valid callback should return 200");
    assert.equal(creds.accountId, ACCOUNT_ID, "credentials should carry the account id");
});
