/**
 * In-session `memwal_login` replaces credentials.json. The next tool call
 * reloads the file — no SSE reconnect.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const BIN = resolve(__dirname, "../dist/bin/memwal-mcp.js");
const INITIAL_BEARER = "a".repeat(64);
const ACCOUNT_A = `0x${"1".repeat(64)}`;
const ACCOUNT_B = `0x${"2".repeat(64)}`;
const WALLET = `0x${"3".repeat(64)}`;
const PACKAGE = `0x${"4".repeat(64)}`;
const WEB = "http://127.0.0.1:9";

function makeCreds(relayerUrl) {
    return {
        delegatePrivateKey: INITIAL_BEARER,
        delegatePublicKeyHex: "b".repeat(64),
        delegateAddress: `0x${"5".repeat(64)}`,
        walletAddress: WALLET,
        accountId: ACCOUNT_A,
        packageId: PACKAGE,
        relayerUrl,
        label: "Live Login Test",
        createdAt: new Date(0).toISOString(),
        version: 1,
    };
}

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
                rej(new Error("timed out waiting for message"));
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

async function completeLogin(connectUrl, accountId) {
    const url = new URL(connectUrl);
    const callbackBase = `http://127.0.0.1:${url.searchParams.get("port")}`;
    const state = url.searchParams.get("connectState");
    const publicKey = url.searchParams.get("publicKey");
    const relayer = url.searchParams.get("relayer");
    const headers = { origin: url.origin, "content-type": "application/json" };

    const preflight = await fetch(`${callbackBase}/preflight`, {
        method: "POST",
        headers,
        body: JSON.stringify({ state, publicKey, relayer }),
    });
    assert.equal(preflight.status, 200);

    const callback = await fetch(`${callbackBase}/callback`, {
        method: "POST",
        headers,
        body: JSON.stringify({ state, accountId, walletAddress: WALLET, packageId: PACKAGE }),
    });
    assert.equal(callback.status, 200);
}

test("in-session memwal_login replaces credentials.json with the new account", async (t) => {
    const credsDir = mkdtempSync(join(tmpdir(), "memwal-live-login-"));
    const credsPath = join(credsDir, "credentials.json");
    writeFileSync(credsPath, JSON.stringify(makeCreds(WEB)), { mode: 0o600 });

    const child = spawn(process.execPath, [BIN, "--relayer", WEB, "--web-url", WEB], {
        env: {
            ...process.env,
            MEMWAL_CREDS_DIR: credsDir,
            HOME: credsDir,
            USERPROFILE: credsDir,
            MEMWAL_MCP_LOGIN_TIMEOUT_MS: "15000",
        },
        stdio: ["pipe", "pipe", "pipe"],
    });
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
    const match = login.result.content[0].text.match(/http:\/\/127\.0\.0\.1:\d+\/connect\/mcp\?\S+/);
    assert.ok(match, "login should return a connect URL");

    await completeLogin(match[0].replace(/[)`\s]+$/, ""), ACCOUNT_B);

    await waitFor(
        (m) =>
            m.method === "notifications/message" &&
            String(m.params?.data).includes("sign-in complete"),
    );

    const saved = JSON.parse(readFileSync(credsPath, "utf8"));
    assert.equal(saved.accountId, ACCOUNT_B);
    assert.notEqual(saved.delegatePrivateKey, INITIAL_BEARER);
});
