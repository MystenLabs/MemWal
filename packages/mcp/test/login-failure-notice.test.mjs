/**
 * A background `memwal_login` that never completes must not stay silent.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const BIN = resolve(__dirname, "../dist/bin/memwal-mcp.js");
const WEB = "http://127.0.0.1:9";

function makeCreds(relayerUrl) {
    return {
        delegatePrivateKey: "a".repeat(64),
        delegatePublicKeyHex: "b".repeat(64),
        delegateAddress: "0x" + "1".repeat(64),
        walletAddress: "0x" + "2".repeat(64),
        accountId: "0x" + "3".repeat(64),
        packageId: "0x" + "4".repeat(64),
        relayerUrl,
        label: "timeout-test",
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

test("a sign-in that never completes is reported on the next tool call", async (t) => {
    const home = mkdtempSync(join(tmpdir(), "memwal-test-"));

    const child = spawn(process.execPath, [BIN, "--relayer", WEB, "--web-url", WEB], {
        env: {
            ...process.env,
            HOME: home,
            USERPROFILE: home,
            MEMWAL_CREDS_DIR: home,
            MEMWAL_MCP_LOGIN_TIMEOUT_MS: "600",
        },
        stdio: ["pipe", "pipe", "pipe"],
    });
    const { send, waitFor } = attachStdio(child);

    t.after(() => {
        child.kill("SIGKILL");
        rmSync(home, { recursive: true, force: true });
    });

    send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05" } });
    await waitFor((m) => m.id === 1 && m.result);

    send({
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: { name: "memwal_recall", arguments: { query: "anything" } },
    });
    const before = await waitFor((m) => m.id === 2 && m.result);
    assert.equal(before.result.isError, true);
    assert.ok(
        !before.result.content[0].text.includes("never completed"),
        "a fresh server should not claim a sign-in failed",
    );

    send({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "memwal_login" } });
    await waitFor((m) => m.id === 3 && m.result);

    const warned = await waitFor(
        (m) =>
            m.method === "notifications/message" &&
            m.params?.level === "warning" &&
            String(m.params?.data).includes("did not complete"),
    );
    assert.match(String(warned.params.data), /Walrus Memory sign-in did not complete/);

    send({
        jsonrpc: "2.0",
        id: 4,
        method: "tools/call",
        params: { name: "memwal_recall", arguments: { query: "anything" } },
    });
    const after = await waitFor((m) => m.id === 4 && m.result);
    const text = after.result.content[0].text;

    assert.equal(after.result.isError, true);
    assert.match(text, /never completed/);
    assert.match(text, /left running through the/);
    assert.doesNotMatch(text, /usually works/);
    assert.match(text, /already be registered on your account/);
    assert.match(text, /memwal_login/);
});

test("a signed-in memwal_login timeout still warns", async (t) => {
    const home = mkdtempSync(join(tmpdir(), "memwal-test-"));
    writeFileSync(join(home, "credentials.json"), JSON.stringify(makeCreds(WEB)), { mode: 0o600 });

    const child = spawn(process.execPath, [BIN, "--relayer", WEB, "--web-url", WEB], {
        env: {
            ...process.env,
            HOME: home,
            USERPROFILE: home,
            MEMWAL_CREDS_DIR: home,
            MEMWAL_MCP_LOGIN_TIMEOUT_MS: "600",
        },
        stdio: ["pipe", "pipe", "pipe"],
    });
    const { send, waitFor } = attachStdio(child);

    t.after(() => {
        child.kill("SIGKILL");
        rmSync(home, { recursive: true, force: true });
    });

    send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05" } });
    await waitFor((m) => m.id === 1 && m.result);

    send({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "memwal_login" } });
    const login = await waitFor((m) => m.id === 2 && m.result);
    assert.equal(login.result.isError, false);

    const warned = await waitFor(
        (m) =>
            m.method === "notifications/message" &&
            m.params?.level === "warning" &&
            String(m.params?.data).includes("Existing credentials are unchanged"),
    );
    assert.match(String(warned.params.data), /Walrus Memory sign-in did not complete/);
});

test("loginFlow honors MEMWAL_MCP_LOGIN_TIMEOUT_MS when timeoutMs is omitted", async (t) => {
    const home = mkdtempSync(join(tmpdir(), "memwal-test-"));
    const prevHome = process.env.HOME;
    const prevProfile = process.env.USERPROFILE;
    const prevTimeout = process.env.MEMWAL_MCP_LOGIN_TIMEOUT_MS;
    process.env.HOME = home;
    process.env.USERPROFILE = home;
    process.env.MEMWAL_MCP_LOGIN_TIMEOUT_MS = "400";

    t.after(() => {
        if (prevHome === undefined) delete process.env.HOME;
        else process.env.HOME = prevHome;
        if (prevProfile === undefined) delete process.env.USERPROFILE;
        else process.env.USERPROFILE = prevProfile;
        if (prevTimeout === undefined) delete process.env.MEMWAL_MCP_LOGIN_TIMEOUT_MS;
        else process.env.MEMWAL_MCP_LOGIN_TIMEOUT_MS = prevTimeout;
        rmSync(home, { recursive: true, force: true });
    });

    const { loginFlow } = await import("../dist/login.js");
    await assert.rejects(
        loginFlow({
            openBrowser: false,
            webUrl: "http://127.0.0.1:9",
            relayerUrl: "http://127.0.0.1:9",
            label: "timeout-test",
        }),
        /timed out after 400ms/,
    );
});
