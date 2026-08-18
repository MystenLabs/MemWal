/**
 * Regression test for GH #415 (graceful-degradation gate) — a hung relayer must
 * NOT be fatal (no SIGTERM), and must not corrupt the handshake.
 *
 * Repro:
 *   - Mock relayer answers GET /version, accepts the SSE GET, then goes SILENT
 *     forever (never sends the endpoint event) — a relayer that's up enough to
 *     accept the socket but never completes the MCP handshake.
 *   - With MEMWAL_MCP_CONNECT_TIMEOUT_MS small, each connect attempt aborts at
 *     the bound and retries with backoff.
 *
 * Asserts the corrected degraded-path behaviour (post adversarial review):
 *   - `initialize` is answered locally EXACTLY ONCE (guards the double-reply bug
 *     where the connect-failure path wrote a second envelope for the same id).
 *   - a buffered `tools/call` is NOT eager-failed between retries (a call the
 *     next attempt could serve must not get a spurious error; this also protects
 *     the auth-required hot-handoff request).
 *   - the process stays alive throughout (no SIGTERM / startup failure).
 *   - on shutdown (stdin close) the still-open call is closed out with an error
 *     envelope rather than left hanging.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const BIN = resolve(__dirname, "../dist/bin/memwal-mcp.js");
const EXPECTED_BEARER = "a".repeat(64);
const EXPECTED_ACCOUNT_ID = "0x" + "3".repeat(64);

function hasBridgeAuth(req) {
    return (
        req.headers.authorization === `Bearer ${EXPECTED_BEARER}` &&
        req.headers["x-memwal-account-id"] === EXPECTED_ACCOUNT_ID
    );
}

/** Mock relayer that accepts the SSE GET but NEVER sends the endpoint event —
 * the initial connect hangs until the bridge's bounded timeout aborts it. */
function startHungRelayer() {
    let sseGetCount = 0;
    const openStreams = [];
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
            if (!hasBridgeAuth(req)) {
                res.writeHead(401);
                res.end();
                return;
            }
            sseGetCount += 1;
            res.writeHead(200, {
                "content-type": "text/event-stream",
                "cache-control": "no-cache",
                connection: "keep-alive",
            });
            // Deliberately send nothing else — the handshake never completes.
            openStreams.push(res);
            return;
        }
        // No messages endpoint is ever reached (no session established).
        res.writeHead(404);
        res.end();
    });
    return new Promise((res) => {
        server.listen(0, "127.0.0.1", () => {
            const { port } = server.address();
            res({
                server,
                base: `http://127.0.0.1:${port}`,
                getSseGetCount: () => sseGetCount,
                closeStreams: () => openStreams.forEach((r) => r.end()),
            });
        });
    });
}

function makeCreds(relayerUrl) {
    return {
        delegatePrivateKey: EXPECTED_BEARER,
        delegatePublicKeyHex: "b".repeat(64),
        delegateAddress: "0x" + "1".repeat(64),
        walletAddress: "0x" + "2".repeat(64),
        accountId: EXPECTED_ACCOUNT_ID,
        packageId: "0x" + "4".repeat(64),
        relayerUrl,
        label: "Coldstart Timeout Test",
        createdAt: new Date(0).toISOString(),
        version: 1,
    };
}

test("a hung relayer bounds the connect and returns a tool-call error instead of hanging", async (t) => {
    const mock = await startHungRelayer();
    const home = mkdtempSync(join(tmpdir(), "memwal-coldstart-timeout-test-"));
    const credsPath = join(home, ".memwal", "credentials.json");
    mkdirSync(dirname(credsPath), { recursive: true });
    writeFileSync(credsPath, JSON.stringify(makeCreds(mock.base)), { mode: 0o600 });

    const child = spawn(process.execPath, [BIN, "--relayer", mock.base, "--web-url", mock.base], {
        env: {
            ...process.env,
            HOME: home,
            USERPROFILE: home,
            MEMWAL_MCP_CONNECT_TIMEOUT_MS: "1000",
        },
        stdio: ["pipe", "pipe", "pipe"],
    });

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
    let stderrBuf = "";
    child.stderr.on("data", (d) => (stderrBuf += d.toString()));

    const send = (obj) => child.stdin.write(JSON.stringify(obj) + "\n");
    const waitFor = (pred, ms = 15000) => {
        const hit = received.find(pred);
        if (hit) return Promise.resolve(hit);
        return new Promise((res, rej) => {
            const timer = setTimeout(() => {
                listeners.delete(l);
                rej(
                    new Error(
                        `timed out waiting for message\n--- stderr ---\n${stderrBuf}\n--- received ---\n${received.map((m) => JSON.stringify(m)).join("\n")}`,
                    ),
                );
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

    t.after(() => {
        child.kill("SIGKILL");
        mock.closeStreams();
        mock.server.close();
        rmSync(home, { recursive: true, force: true });
    });

    // initialize is still answered locally even though the relayer never
    // completes its handshake.
    send({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
    const init = await waitFor((m) => m.id === 1 && m.result, 5_000);
    assert.equal(init.result.serverInfo.name, "memwal");

    // A tool call buffered before connect. The relayer never comes up, so the
    // connect retries with backoff. The call must NOT be eager-failed between
    // attempts (a call the next attempt could serve must not get a spurious
    // error — that also protects the auth-required hot-handoff request). It
    // stays pending; the client's own per-tool timeout would handle it.
    send({
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: { name: "memwal_recall", arguments: { query: "anything" } },
    });

    // Wait out several connect-retry cycles (timeout 1s + backoff). During this
    // window the buffered call must NOT have been answered with an error.
    await new Promise((r) => setTimeout(r, 4_500));
    assert.ok(
        !received.some((m) => m.id === 2),
        `id=2 must stay buffered during retries, but got a reply: ${JSON.stringify(received.find((m) => m.id === 2))}`,
    );

    // Regression guard for the double-`initialize` bug: id=1 must have been
    // answered EXACTLY once (the local reply) — never a second envelope from the
    // connect-failure path.
    const initReplies = received.filter((m) => m.id === 1 && (m.result || m.error));
    assert.equal(
        initReplies.length,
        1,
        `initialize (id=1) must be answered exactly once; saw ${initReplies.length}: ${JSON.stringify(initReplies)}`,
    );

    // Process is still alive despite the hung relayer — the whole point is no
    // SIGTERM / startup failure.
    assert.equal(child.exitCode, null, "bridge should still be running, not exited");

    // On shutdown (stdin closes) the still-buffered tool call is closed out with
    // an error envelope instead of being left hanging.
    child.stdin.end();
    const recall = await waitFor((m) => m.id === 2, 5_000);
    assert.equal(recall.result?.isError, true, `expected isError envelope on shutdown, got ${JSON.stringify(recall)}`);
    assert.match(JSON.stringify(recall.result), /relayer unavailable/i);
});
