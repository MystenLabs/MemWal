/**
 * A sign-in that DOES complete must say so.
 *
 * The banner is a ONE-SHOT. Success is an event, not a state.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const BIN = resolve(__dirname, "../dist/bin/memwal-mcp.js");

function attachStdio(child) {
    const received = [];
    const listeners = new Set();
    let buf = "";
    child.stdout.on("data", (d) => {
        buf += d.toString();
        let nl;
        while ((nl = buf.indexOf("\n")) >= 0) {
            const line = buf.slice(0, nl);
            buf = buf.slice(nl + 1);
            if (!line.trim()) continue;
            let msg;
            try {
                msg = JSON.parse(line);
            } catch {
                continue;
            }
            received.push(msg);
            for (const l of [...listeners]) l(msg);
        }
    });
    const send = (obj) => child.stdin.write(JSON.stringify(obj) + "\n");
    const waitFor = (pred, ms = 15000) => {
        const hit = received.find(pred);
        if (hit) return Promise.resolve(hit);
        return new Promise((res, rej) => {
            const timer = setTimeout(() => {
                listeners.delete(l);
                const seen = received
                    .map((m) => (m.id !== undefined ? `id=${m.id}` : m.method))
                    .join(", ");
                rej(new Error(`timed out waiting for message; received: [${seen}]`));
            }, ms);
            const l = (m) => {
                if (pred(m)) {
                    clearTimeout(timer);
                    listeners.delete(l);
                    res(m);
                }
            };
            listeners.add(l);
        });
    };
    return { send, waitFor };
}

async function completeSignIn(loginText, webUrl) {
    const match = loginText.match(/http:\/\/127\.0\.0\.1:\d+\/connect\/mcp\?\S+/);
    assert.ok(match, `login result should carry a connect URL, got: ${loginText.slice(0, 300)}`);
    const connectUrl = new URL(match[0].replace(/[)`\s]+$/, ""));

    const port = connectUrl.searchParams.get("port");
    const publicKey = connectUrl.searchParams.get("publicKey");
    const state = connectUrl.searchParams.get("connectState");
    assert.match(port ?? "", /^\d+$/);

    const post = (path, body) =>
        fetch(`http://127.0.0.1:${port}${path}`, {
            method: "POST",
            headers: { "content-type": "application/json", origin: webUrl },
            body: JSON.stringify(body),
        });

    const preflight = await post("/preflight", { state, publicKey, relayer: webUrl });
    assert.equal(preflight.status, 200, "preflight should be accepted");

    const callback = await post("/callback", {
        state,
        accountId: `0x${"1".repeat(64)}`,
        walletAddress: `0x${"2".repeat(64)}`,
        packageId: `0x${"3".repeat(64)}`,
        label: "Test MCP",
    });
    assert.equal(callback.status, 200, "callback should be accepted");
}

function spawnSignedOut(webUrl, credsDir) {
    return spawn(process.execPath, [BIN, "--relayer", webUrl, "--web-url", webUrl], {
        env: {
            ...process.env,
            MEMWAL_CREDS_DIR: credsDir,
            HOME: credsDir,
            USERPROFILE: credsDir,
            MEMWAL_MCP_LOGIN_TIMEOUT_MS: "15000",
        },
        stdio: ["pipe", "pipe", "pipe"],
    });
}

function seedCreds(credsDir, relayerUrl) {
    const path = join(credsDir, "credentials.json");
    mkdirSync(credsDir, { recursive: true });
    writeFileSync(
        path,
        JSON.stringify({
            delegatePrivateKey: "a".repeat(64),
            delegatePublicKeyHex: "b".repeat(64),
            delegateAddress: `0x${"4".repeat(64)}`,
            walletAddress: `0x${"2".repeat(64)}`,
            accountId: `0x${"1".repeat(64)}`,
            packageId: `0x${"3".repeat(64)}`,
            relayerUrl,
            label: "Existing MCP",
            createdAt: new Date(0).toISOString(),
            version: 1,
        }),
        { mode: 0o600 },
    );
}

const WEB = "http://127.0.0.1:9";

test("re-signing in while already signed in is confirmed on both surfaces", async (t) => {
    const credsDir = mkdtempSync(join(tmpdir(), "memwal-success-relogin-"));
    seedCreds(credsDir, WEB);
    const child = spawnSignedOut(WEB, credsDir);
    const { send, waitFor } = attachStdio(child);

    t.after(() => {
        child.kill("SIGKILL");
        rmSync(credsDir, { recursive: true, force: true });
    });

    send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05" } });
    await waitFor((m) => m.id === 1 && m.result);

    send({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "memwal_login" } });
    const login = await waitFor((m) => m.id === 2 && m.result);
    assert.equal(login.result.isError, false);
    assert.match(
        login.result.content[0].text,
        /already signed in/i,
        "a stored key IS about to be replaced; the prompt has to say so",
    );

    await completeSignIn(login.result.content[0].text, WEB);

    const announced = await waitFor(
        (m) =>
            m.method === "notifications/message" &&
            String(m.params?.data).includes("sign-in complete"),
    );
    assert.match(String(announced.params.data), /0x1{4}/, "should name the account signed in as");

    send({
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: { name: "memwal_health", arguments: {} },
    });
    const after = await waitFor((m) => m.id === 3 && m.result);
    const text = after.result.content[0].text;
    assert.match(text, /Signed in to Walrus Memory/, "the re-login should carry the banner too");

    send({
        jsonrpc: "2.0",
        id: 4,
        method: "tools/call",
        params: { name: "memwal_health", arguments: {} },
    });
    const second = await waitFor((m) => m.id === 4 && m.result);
    assert.doesNotMatch(
        second.result.content[0].text,
        /Signed in to Walrus Memory/,
        "the banner is a one-shot on the re-login path as well",
    );
});

test("a completed sign-in is confirmed on the next tool call", async (t) => {
    const credsDir = mkdtempSync(join(tmpdir(), "memwal-success-"));
    const child = spawnSignedOut(WEB, credsDir);
    const { send, waitFor } = attachStdio(child);

    t.after(() => {
        child.kill("SIGKILL");
        rmSync(credsDir, { recursive: true, force: true });
    });

    send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05" } });
    await waitFor((m) => m.id === 1 && m.result);

    send({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "memwal_login" } });
    const login = await waitFor((m) => m.id === 2 && m.result);
    assert.equal(login.result.isError, false);

    await completeSignIn(login.result.content[0].text, WEB);

    const announced = await waitFor(
        (m) =>
            m.method === "notifications/message" &&
            String(m.params?.data).includes("sign-in complete"),
    );
    assert.match(String(announced.params.data), /0x1{4}/, "should name the account signed in as");

    send({
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: { name: "memwal_health", arguments: {} },
    });
    const after = await waitFor((m) => m.id === 3 && m.result);
    const text = after.result.content[0].text;

    assert.match(text, /Signed in to Walrus Memory/);
    assert.match(text, /0x1{4}/, "banner should name the account");
    assert.match(text, /credentials\.json/, "banner should name where credentials landed");
    assert.match(text, /no client restart needed/i);
});

test("the sign-in confirmation is not repeated on later calls", async (t) => {
    const credsDir = mkdtempSync(join(tmpdir(), "memwal-success-once-"));
    const child = spawnSignedOut(WEB, credsDir);
    const { send, waitFor } = attachStdio(child);

    t.after(() => {
        child.kill("SIGKILL");
        rmSync(credsDir, { recursive: true, force: true });
    });

    send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05" } });
    await waitFor((m) => m.id === 1 && m.result);

    send({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "memwal_login" } });
    const login = await waitFor((m) => m.id === 2 && m.result);
    await completeSignIn(login.result.content[0].text, WEB);
    await waitFor(
        (m) =>
            m.method === "notifications/message" &&
            String(m.params?.data).includes("sign-in complete"),
    );

    send({
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: { name: "memwal_health", arguments: {} },
    });
    const first = await waitFor((m) => m.id === 3 && m.result);
    assert.match(
        first.result.content[0].text,
        /Signed in to Walrus Memory/,
        "precondition: the first call carries the banner",
    );

    send({
        jsonrpc: "2.0",
        id: 4,
        method: "tools/call",
        params: { name: "memwal_health", arguments: {} },
    });
    const second = await waitFor((m) => m.id === 4 && m.result);
    assert.doesNotMatch(
        second.result.content[0].text,
        /Signed in to Walrus Memory/,
        "the banner is consumed by the call that shows it — a signed-in session must not repeat it",
    );
});
