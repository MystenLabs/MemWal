import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

function startMockRelayer() {
    const sessions = new Map();
    const handshakes = [];
    const posts = [];
    let nextSession = 1;
    let delayNextHandshake = false;
    let delayedHandshake = null;

    function establishSession(sessionId, res) {
        res.write(`event: endpoint\ndata: /api/mcp/messages?sessionId=${sessionId}\n\n`);
        const heartbeat = setInterval(() => res.write(": keepalive\n\n"), 250);
        heartbeat.unref?.();
        res.on("close", () => clearInterval(heartbeat));
    }

    const server = http.createServer((req, res) => {
        const url = new URL(req.url, "http://127.0.0.1");
        if (req.method === "GET" && url.pathname === "/version") {
            res.writeHead(200, { "content-type": "application/json" });
            res.end(
                JSON.stringify({
                    apiVersion: "1.0.0",
                    relayerVersion: "1.0.0",
                    minSupportedSdk: { mcp: "0.0.1" },
                }),
            );
            return;
        }
        if (req.method === "GET" && url.pathname === "/api/mcp/sse") {
            const bearer = req.headers.authorization;
            const accountId = req.headers["x-memwal-account-id"];
            const sessionId = `session-${nextSession++}`;
            handshakes.push({ bearer, accountId, sessionId });
            res.writeHead(200, {
                "content-type": "text/event-stream",
                "cache-control": "no-cache",
                connection: "keep-alive",
            });
            res.flushHeaders();
            sessions.set(sessionId, { res, bearer, accountId });
            if (delayNextHandshake) {
                delayNextHandshake = false;
                delayedHandshake = { sessionId, res };
            } else {
                establishSession(sessionId, res);
            }
            return;
        }
        if (req.method === "POST" && url.pathname === "/api/mcp/messages") {
            const session = sessions.get(url.searchParams.get("sessionId"));
            if (!session) {
                res.writeHead(404);
                res.end();
                return;
            }
            if (
                req.headers.authorization !== session.bearer ||
                req.headers["x-memwal-account-id"] !== session.accountId
            ) {
                res.writeHead(401);
                res.end();
                return;
            }
            let body = "";
            req.on("data", (chunk) => (body += chunk));
            req.on("end", () => {
                res.writeHead(202);
                res.end();
                const msg = JSON.parse(body);
                posts.push({
                    sessionId: url.searchParams.get("sessionId"),
                    bearer: req.headers.authorization,
                    accountId: req.headers["x-memwal-account-id"],
                    method: msg.method,
                    id: msg.id ?? null,
                    name: msg.params?.name ?? null,
                });
                const result =
                    msg.method === "initialize"
                        ? {
                              protocolVersion: "2024-11-05",
                              capabilities: { tools: { listChanged: true } },
                              serverInfo: { name: "memwal", version: "0.0.1" },
                          }
                        : {
                              content: [
                                  {
                                      type: "text",
                                      text: `RECALL_OK account=${session.accountId} bearer=${session.bearer}`,
                                  },
                              ],
                              isError: false,
                          };
                session.res.write(
                    `event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", id: msg.id, result })}\n\n`,
                );
            });
            return;
        }
        res.writeHead(404);
        res.end();
    });

    return new Promise((resolveStart) => {
        server.listen(0, "127.0.0.1", () => {
            const { port } = server.address();
            resolveStart({
                server,
                base: `http://127.0.0.1:${port}`,
                handshakes,
                posts,
                delayNextHandshake() {
                    delayNextHandshake = true;
                },
                closeSession(sessionId) {
                    sessions.get(sessionId)?.res.end();
                },
                releaseDelayedHandshake() {
                    assert.ok(delayedHandshake, "expected a delayed SSE handshake");
                    establishSession(delayedHandshake.sessionId, delayedHandshake.res);
                    delayedHandshake = null;
                },
            });
        });
    });
}

function collectMessages(child) {
    const received = [];
    const listeners = new Set();
    let stdout = "";
    let stderr = "";
    child.stderr.on("data", (data) => (stderr += data.toString()));
    child.stdout.on("data", (data) => {
        stdout += data.toString();
        let newline;
        while ((newline = stdout.indexOf("\n")) >= 0) {
            const line = stdout.slice(0, newline);
            stdout = stdout.slice(newline + 1);
            if (!line.trim()) continue;
            try {
                const message = JSON.parse(line);
                received.push(message);
                for (const listener of [...listeners]) listener(message);
            } catch {
                // Ignore non-JSON diagnostics.
            }
        }
    });

    return {
        received,
        send: (message) => child.stdin.write(`${JSON.stringify(message)}\n`),
        waitFor(predicate, timeoutMs = 10_000) {
            const existing = received.find(predicate);
            if (existing) return Promise.resolve(existing);
            return new Promise((resolveWait, reject) => {
                const listener = (message) => {
                    if (!predicate(message)) return;
                    clearTimeout(timer);
                    listeners.delete(listener);
                    resolveWait(message);
                };
                const timer = setTimeout(() => {
                    listeners.delete(listener);
                    reject(
                        new Error(
                            `timed out waiting for bridge message\n--- stderr ---\n${stderr}\n--- received ---\n${received.map((message) => JSON.stringify(message)).join("\n")}`,
                        ),
                    );
                }, timeoutMs);
                listeners.add(listener);
            });
        },
    };
}

async function completeLogin(connectUrl, accountId) {
    const url = new URL(connectUrl);
    const callbackBase = `http://127.0.0.1:${url.searchParams.get("port")}`;
    const state = url.searchParams.get("connectState");
    const publicKey = url.searchParams.get("publicKey");
    const relayer = url.searchParams.get("relayer");
    const origin = url.origin;
    const headers = { origin, "content-type": "application/json" };

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

async function waitUntil(predicate, timeoutMs = 10_000) {
    const started = Date.now();
    while (!predicate()) {
        if (Date.now() - started > timeoutMs) throw new Error("timed out waiting for condition");
        await new Promise((resolveWait) => setTimeout(resolveWait, 25));
    }
}

test("in-session memwal_login reconnects the bridge with the new credentials", async (t) => {
    const mock = await startMockRelayer();
    const home = mkdtempSync(join(tmpdir(), "memwal-live-login-test-"));
    const credentialsPath = join(home, ".memwal", "credentials.json");
    mkdirSync(dirname(credentialsPath), { recursive: true });
    writeFileSync(credentialsPath, JSON.stringify(makeCreds(mock.base)), { mode: 0o600 });

    const child = spawn(process.execPath, [BIN, "--relayer", mock.base, "--web-url", mock.base], {
        env: { ...process.env, HOME: home, USERPROFILE: home },
        stdio: ["pipe", "pipe", "pipe"],
    });
    const bridge = collectMessages(child);

    t.after(() => {
        child.kill("SIGKILL");
        mock.server.close();
        rmSync(home, { recursive: true, force: true });
    });

    bridge.send({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
    await bridge.waitFor((message) => message.id === 1 && message.result);
    // `initialize` is answered locally and the relayer connect runs in the
    // background, so the SSE handshake lands shortly AFTER the init reply rather
    // than synchronously with it — wait for it before asserting.
    await waitUntil(() => mock.handshakes.length >= 1);
    assert.equal(mock.handshakes[0].bearer, `Bearer ${INITIAL_BEARER}`);
    assert.equal(mock.handshakes[0].accountId, ACCOUNT_A);

    // Force a reconnect whose SSE endpoint event is delayed. Login completes
    // while this old-credential handshake is in progress, reproducing the race
    // where a shared reconnect promise previously published a stale session.
    mock.delayNextHandshake();
    mock.closeSession(mock.handshakes[0].sessionId);
    await waitUntil(() => mock.handshakes.length >= 2);
    assert.equal(mock.handshakes[1].bearer, `Bearer ${INITIAL_BEARER}`);
    assert.equal(mock.handshakes[1].accountId, ACCOUNT_A);

    bridge.send({
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: { name: "memwal_login", arguments: {} },
    });
    const login = await bridge.waitFor((message) => message.id === 2);
    const text = login.result.content[0].text;
    const connectUrl = text.match(/\*\*URL:\*\* (http[^\n]+)/)?.[1];
    assert.ok(connectUrl, "memwal_login should return the browser URL");

    await completeLogin(connectUrl, ACCOUNT_B);
    mock.releaseDelayedHandshake();
    await waitUntil(() => mock.handshakes.some((entry) => entry.accountId === ACCOUNT_B));

    const updatedHandshake = mock.handshakes.find((entry) => entry.accountId === ACCOUNT_B);
    assert.notEqual(updatedHandshake.bearer, `Bearer ${INITIAL_BEARER}`);
    const saved = JSON.parse(readFileSync(credentialsPath, "utf8"));
    assert.equal(updatedHandshake.bearer, `Bearer ${saved.delegatePrivateKey}`);

    bridge.send({
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: { name: "memwal_recall", arguments: { query: "new account" } },
    });
    const recall = await bridge.waitFor((message) => message.id === 3);
    assert.notEqual(recall.result?.isError, true);
    assert.match(recall.result.content[0].text, new RegExp(`account=${ACCOUNT_B}`));
    assert.match(recall.result.content[0].text, new RegExp(`bearer=${updatedHandshake.bearer}`));
});

test("a request buffered during cold start is NOT flushed to a new account after an in-session login", async (t) => {
    // Merge-composition regression (#415 × #597): a request buffered while the
    // relayer is still cold-starting (sse not yet up) must not survive an
    // account-change login and be flushed to the NEW account's session. It must
    // be failed with the -32001 account-change error, and the new account must
    // never receive it.
    const mock = await startMockRelayer();
    const home = mkdtempSync(join(tmpdir(), "memwal-coldstart-login-test-"));
    const credentialsPath = join(home, ".memwal", "credentials.json");
    mkdirSync(dirname(credentialsPath), { recursive: true });
    writeFileSync(credentialsPath, JSON.stringify(makeCreds(mock.base)), { mode: 0o600 });

    // Delay the FIRST handshake so the initial connect never completes before
    // the login — the bridge stays in cold start, buffering into pendingForward.
    mock.delayNextHandshake();

    const child = spawn(process.execPath, [BIN, "--relayer", mock.base, "--web-url", mock.base], {
        env: { ...process.env, HOME: home, USERPROFILE: home },
        stdio: ["pipe", "pipe", "pipe"],
    });
    const bridge = collectMessages(child);
    t.after(() => {
        child.kill("SIGKILL");
        mock.server.close();
        rmSync(home, { recursive: true, force: true });
    });

    // initialize is answered locally; the connect is delayed (handshake held).
    bridge.send({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
    await bridge.waitFor((message) => message.id === 1 && message.result);
    await waitUntil(() => mock.handshakes.length >= 1); // the (delayed) GET arrived
    assert.equal(mock.handshakes[0].accountId, ACCOUNT_A);

    // A recall for account A — buffered into pendingForward (connect not up).
    bridge.send({
        jsonrpc: "2.0",
        id: 5,
        method: "tools/call",
        params: { name: "memwal_recall", arguments: { query: "account A secret" } },
    });

    // Log into a DIFFERENT account (B) while id=5 sits buffered.
    bridge.send({
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: { name: "memwal_login", arguments: {} },
    });
    const login = await bridge.waitFor((message) => message.id === 2);
    const connectUrl = login.result.content[0].text.match(/\*\*URL:\*\* (http[^\n]+)/)?.[1];
    assert.ok(connectUrl, "memwal_login should return the browser URL");
    await completeLogin(connectUrl, ACCOUNT_B);

    // Now release the held handshake so the connect can proceed / reconnect.
    mock.releaseDelayedHandshake();

    // The buffered account-A recall must come back as the -32001 account-change
    // error — NOT an account-B recall result.
    const recallReply = await bridge.waitFor((message) => message.id === 5);
    assert.equal(recallReply.error?.code, -32001, `id=5 must be the account-change error, got ${JSON.stringify(recallReply)}`);
    assert.equal(recallReply.result, undefined, "id=5 must not carry a recall result");

    // Give the bridge time to (wrongly) flush id=5 if the bug were present.
    await new Promise((r) => setTimeout(r, 500));

    // No account-B session may have received the account-A recall (id=5), and
    // id=5 must have been answered exactly once (no double response).
    const id5Replies = bridge.received.filter((m) => m.id === 5);
    assert.equal(id5Replies.length, 1, `id=5 answered exactly once, saw ${id5Replies.length}: ${JSON.stringify(id5Replies)}`);
    const bAccountRecall = bridge.received.find(
        (m) => m.id === 5 && m.result && /account A secret/.test(JSON.stringify(m)),
    );
    assert.ok(!bAccountRecall, "the account-A recall must never be served by account B");
});

test("same-account login during cold start delivers each buffered call once on the new bearer", async (t) => {
    // Same-account memwal_login must not let connectInBackground flush
    // pendingForward after reconnect() already replayed inFlight.
    const mock = await startMockRelayer();
    const home = mkdtempSync(join(tmpdir(), "memwal-same-account-coldstart-"));
    const credentialsPath = join(home, ".memwal", "credentials.json");
    mkdirSync(dirname(credentialsPath), { recursive: true });
    writeFileSync(credentialsPath, JSON.stringify(makeCreds(mock.base)), { mode: 0o600 });

    mock.delayNextHandshake();

    const child = spawn(process.execPath, [BIN, "--relayer", mock.base, "--web-url", mock.base], {
        env: { ...process.env, HOME: home, USERPROFILE: home },
        stdio: ["pipe", "pipe", "pipe"],
    });
    const bridge = collectMessages(child);
    t.after(() => {
        child.kill("SIGKILL");
        mock.server.close();
        rmSync(home, { recursive: true, force: true });
    });

    bridge.send({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
    await bridge.waitFor((message) => message.id === 1 && message.result);
    await waitUntil(() => mock.handshakes.length >= 1);

    bridge.send({
        jsonrpc: "2.0",
        id: 5,
        method: "tools/call",
        params: { name: "memwal_recall", arguments: { query: "same account" } },
    });

    bridge.send({
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: { name: "memwal_login", arguments: {} },
    });
    const login = await bridge.waitFor((message) => message.id === 2);
    const connectUrl = login.result.content[0].text.match(/\*\*URL:\*\* (http[^\n]+)/)?.[1];
    assert.ok(connectUrl, "memwal_login should return the browser URL");
    await completeLogin(connectUrl, ACCOUNT_A);

    mock.releaseDelayedHandshake();

    const recall = await bridge.waitFor((message) => message.id === 5);
    assert.notEqual(recall.result?.isError, true);
    const saved = JSON.parse(readFileSync(credentialsPath, "utf8"));
    assert.match(recall.result.content[0].text, new RegExp(`account=${ACCOUNT_A}`));
    assert.match(
        recall.result.content[0].text,
        new RegExp(`bearer=Bearer ${saved.delegatePrivateKey}`),
    );

    await new Promise((r) => setTimeout(r, 400));
    const id1 = bridge.received.filter((m) => m.id === 1);
    const id5 = bridge.received.filter((m) => m.id === 5);
    assert.equal(id1.length, 1, `initialize answered once, saw ${id1.length}`);
    assert.equal(id5.length, 1, `recall answered once, saw ${id5.length}`);

    const recallPosts = mock.posts.filter((p) => p.name === "memwal_recall" && p.id === 5);
    assert.equal(
        recallPosts.length,
        1,
        `recall POSTed once, saw ${recallPosts.length}: ${JSON.stringify(recallPosts)}`,
    );
    assert.equal(recallPosts[0].bearer, `Bearer ${saved.delegatePrivateKey}`);
    assert.equal(recallPosts[0].accountId, ACCOUNT_A);

    const initPosts = mock.posts.filter((p) => p.method === "initialize");
    assert.equal(initPosts.length, 1, `initialize POSTed once, saw ${JSON.stringify(initPosts)}`);
    assert.equal(initPosts[0].bearer, `Bearer ${saved.delegatePrivateKey}`);

    bridge.send({
        jsonrpc: "2.0",
        id: 6,
        method: "tools/call",
        params: { name: "memwal_recall", arguments: { query: "after login" } },
    });
    const followUp = await bridge.waitFor((message) => message.id === 6);
    assert.notEqual(followUp.result?.isError, true);
    assert.match(
        followUp.result.content[0].text,
        new RegExp(`bearer=Bearer ${saved.delegatePrivateKey}`),
    );
});
