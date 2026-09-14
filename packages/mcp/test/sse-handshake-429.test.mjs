/**
 * Regression test for WALM-386 — a 429 on the SSE handshake must be honoured as
 * a THROTTLE, not retried blind.
 *
 * Bug being guarded against: `openSseStream` read the `retry-after` header and
 * then interpolated it into an Error *message string*, so nothing
 * machine-readable survived. Both retry loops (`connectInBackground` and
 * `reconnect`) fell back to the generic geometric backoff, i.e. the first retry
 * after a 429 landed ~500ms later — well inside the window the relayer had just
 * asked for, and pure noise against `ip_active_cap`, which is a CONCURRENT cap
 * that only clears when some other session closes.
 *
 * Repro:
 *   - Mock relayer answers GET /version, then 429s the SSE GET for the first N
 *     attempts (with or without a `retry-after` header), then serves a real
 *     event-stream. Every SSE GET is timestamped.
 *
 * Asserts:
 *   - a `retry-after: 2` is actually waited out (gap between attempts ≈ 2s, not
 *     500ms), and the attempt COUNT over the throttle window stays low;
 *   - a 429 with NO `retry-after` (the `ip_active_cap` shape) falls back to the
 *     throttle floor rather than the sub-second geometric backoff;
 *   - the bridge does not exit and `initialize` is still answered locally
 *     exactly once;
 *   - a tool call buffered during the throttle is served for real once the
 *     relayer stops throttling (the buffering path is untouched);
 *   - stderr says "rate-limiting … not a bad config or bad credentials", so the
 *     user can tell a throttle from a misconfiguration.
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

/**
 * Mock relayer that 429s the SSE handshake `throttleCount` times, then serves a
 * working stream. `retryAfterSeconds: null` reproduces the header-less
 * `ip_active_cap` denial the real relayer sends for a concurrent cap.
 */
function startThrottlingRelayer({ throttleCount, retryAfterSeconds }) {
    /** ms-since-start of every SSE GET, so the test can measure the gaps. */
    const sseGetAt = [];
    const startedAt = Date.now();
    const sessions = new Map();
    let sseGetCount = 0;
    const openStreams = [];

    const server = http.createServer((req, res) => {
        const u = new URL(req.url, "http://127.0.0.1");
        if (req.method === "GET" && u.pathname === "/version") {
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
        if (req.method === "GET" && u.pathname === "/api/mcp/sse") {
            if (!hasBridgeAuth(req)) {
                res.writeHead(401);
                res.end();
                return;
            }
            sseGetCount += 1;
            sseGetAt.push(Date.now() - startedAt);
            if (sseGetCount <= throttleCount) {
                // Same envelope the relayer's `rateLimitDeny` sends.
                const headers = { "content-type": "application/json" };
                if (retryAfterSeconds != null) {
                    headers["retry-after"] = String(retryAfterSeconds);
                }
                res.writeHead(429, headers);
                res.end(
                    JSON.stringify({
                        jsonrpc: "2.0",
                        error: {
                            code: -32000,
                            message:
                                retryAfterSeconds == null
                                    ? "MCP rate limit: ip_active_cap. Close another MCP session, then retry."
                                    : `MCP rate limit: ip_burst_cap. Try again in ${retryAfterSeconds}s.`,
                        },
                        id: null,
                    }),
                );
                return;
            }
            const sessionId = `session-${sseGetCount}`;
            res.writeHead(200, {
                "content-type": "text/event-stream",
                "cache-control": "no-cache",
                connection: "keep-alive",
            });
            res.write(`event: endpoint\ndata: /api/mcp/messages?sessionId=${sessionId}\n\n`);
            sessions.set(sessionId, { res });
            openStreams.push(res);
            const hb = setInterval(() => {
                if (!res.writableEnded) res.write(":\n\n");
                else clearInterval(hb);
            }, 200);
            hb.unref?.();
            res.on("close", () => clearInterval(hb));
            return;
        }
        if (req.method === "POST" && u.pathname === "/api/mcp/messages") {
            if (!hasBridgeAuth(req)) {
                res.writeHead(401);
                res.end();
                return;
            }
            const session = sessions.get(u.searchParams.get("sessionId"));
            let body = "";
            req.on("data", (c) => (body += c));
            req.on("end", () => {
                let msg;
                try {
                    msg = JSON.parse(body);
                } catch {
                    res.writeHead(202);
                    res.end();
                    return;
                }
                if (!session) {
                    res.writeHead(404);
                    res.end();
                    return;
                }
                res.writeHead(202);
                res.end();
                if (msg.method === "initialize") return; // suppressed by the bridge
                if (msg.method === "tools/call") {
                    session.res.write(
                        `event: message\ndata: ${JSON.stringify({
                            jsonrpc: "2.0",
                            id: msg.id,
                            result: {
                                content: [{ type: "text", text: "RECALLED" }],
                                isError: false,
                            },
                        })}\n\n`,
                    );
                }
            });
            return;
        }
        res.writeHead(404);
        res.end();
    });

    return new Promise((res) => {
        server.listen(0, "127.0.0.1", () => {
            res({
                server,
                base: `http://127.0.0.1:${server.address().port}`,
                sseGetAt,
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
        label: "SSE 429 Test",
        createdAt: new Date(0).toISOString(),
        version: 1,
    };
}

/** Spawn the bridge against `mock`, wired with the usual line-splitter. */
function startBridge(t, mock, env = {}) {
    const home = mkdtempSync(join(tmpdir(), "memwal-sse-429-test-"));
    const credsPath = join(home, ".memwal", "credentials.json");
    mkdirSync(dirname(credsPath), { recursive: true });
    writeFileSync(credsPath, JSON.stringify(makeCreds(mock.base)), { mode: 0o600 });

    const child = spawn(process.execPath, [BIN, "--relayer", mock.base, "--web-url", mock.base], {
        env: { ...process.env, HOME: home, USERPROFILE: home, ...env },
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

    t.after(() => {
        child.kill("SIGKILL");
        mock.closeStreams();
        mock.server.close();
        rmSync(home, { recursive: true, force: true });
    });

    return {
        child,
        received,
        send: (obj) => child.stdin.write(JSON.stringify(obj) + "\n"),
        stderr: () => stderrBuf,
        waitFor: (pred, ms = 15000) => {
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
        },
    };
}

test("a 429 with Retry-After is waited out, not retried after 500ms", async (t) => {
    const mock = await startThrottlingRelayer({ throttleCount: 2, retryAfterSeconds: 2 });
    // Floor set well BELOW the advertised interval so a passing gap can only
    // come from the header, never from the no-header fallback.
    const bridge = startBridge(t, mock, { MEMWAL_MCP_THROTTLE_FLOOR_MS: "250" });

    // initialize is answered locally even while the relayer is throttling — the
    // whole reason a throttled bridge should not look like a broken one.
    bridge.send({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
    const init = await bridge.waitFor((m) => m.id === 1 && m.result, 5_000);
    assert.equal(init.result.serverInfo.name, "memwal");

    // Buffered during the throttle; must be served for real after recovery.
    bridge.send({
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: { name: "memwal_recall", arguments: { query: "anything" } },
    });

    // 2 denials × 2s ≈ 4s before the third attempt succeeds.
    const recall = await bridge.waitFor((m) => m.id === 2, 20_000);

    // The regression guard. Pre-fix the gaps were ~500ms / ~1s (geometric).
    const gaps = mock.sseGetAt.slice(1).map((t2, i) => t2 - mock.sseGetAt[i]);
    assert.ok(
        gaps.length >= 2,
        `expected at least 3 SSE attempts, saw ${mock.sseGetAt.length}: ${JSON.stringify(mock.sseGetAt)}`,
    );
    for (const [i, gap] of gaps.entries()) {
        assert.ok(
            gap >= 1_600,
            `attempt ${i + 2} came ${gap}ms after attempt ${i + 1}; a retry-after of 2s must be honoured (gaps: ${JSON.stringify(gaps)})`,
        );
    }
    // Attempt count is the flake-resistant half of the same signal: a 500ms
    // geometric backoff would have burned ~7 attempts by the time this lands.
    assert.ok(
        mock.getSseGetCount() <= 4,
        `expected the throttle to be respected, but the bridge made ${mock.getSseGetCount()} SSE attempts`,
    );

    // Recovery: the buffered call is served, not error-enveloped.
    assert.equal(
        recall.result?.isError,
        false,
        `buffered call should be served after the throttle clears, got ${JSON.stringify(recall)}`,
    );

    // Still alive, and initialize answered exactly once.
    assert.equal(bridge.child.exitCode, null, "bridge should still be running, not exited");
    const initReplies = bridge.received.filter((m) => m.id === 1 && (m.result || m.error));
    assert.equal(
        initReplies.length,
        1,
        `initialize (id=1) must be answered exactly once; saw ${initReplies.length}`,
    );

    // The user must be able to tell "throttled" from "misconfigured".
    const stderr = bridge.stderr();
    assert.match(stderr, /rate-limiting new MCP sessions \(HTTP 429\)/);
    assert.match(stderr, /not a bad config or bad credentials/);
    assert.doesNotMatch(
        stderr,
        /rejected credentials \(HTTP 401\)/,
        "a throttle must not be reported as a credential problem",
    );
});

test("a 429 with Retry-After: 0 falls back to the floor, not to 500ms", async (t) => {
    // `0` parses, so it used to satisfy `advised ?? floor` and set the wait to
    // zero — the backoff collapsed to the ~500ms geometric retry this whole
    // feature exists to remove, and `serverAdvised` stayed true, suppressing
    // the concurrent-cap hint as well. It is only reachable in production
    // since the relayer started forwarding `retry-after` at all.
    const mock = await startThrottlingRelayer({ throttleCount: 1, retryAfterSeconds: 0 });
    const bridge = startBridge(t, mock, { MEMWAL_MCP_THROTTLE_FLOOR_MS: "2500" });

    bridge.send({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
    await bridge.waitFor((m) => m.id === 1 && m.result, 5_000);

    bridge.send({
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: { name: "memwal_recall", arguments: { query: "anything" } },
    });
    await bridge.waitFor((m) => m.id === 2, 20_000);

    assert.ok(
        mock.sseGetAt.length >= 2,
        `expected a retry after the 429, saw ${mock.sseGetAt.length} attempts`,
    );
    const gap = mock.sseGetAt[1] - mock.sseGetAt[0];
    assert.ok(
        gap >= 2_000,
        `a zero Retry-After must be ignored in favour of the floor; retry came after ${gap}ms`,
    );

    assert.equal(bridge.child.exitCode, null, "bridge should still be running, not exited");
    // Treating it as no usable header also restores `serverAdvised: false`,
    // so the user still gets the one remediation that clears a live cap.
    assert.match(bridge.stderr(), /closing another\s+MCP client/);
});

test("a 429 with no Retry-After falls back to the throttle floor", async (t) => {
    // The ip_active_cap shape: a concurrent cap, so the relayer deliberately
    // sends no header — there is no honest ETA to give.
    const mock = await startThrottlingRelayer({ throttleCount: 1, retryAfterSeconds: null });
    const bridge = startBridge(t, mock, { MEMWAL_MCP_THROTTLE_FLOOR_MS: "2500" });

    bridge.send({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
    await bridge.waitFor((m) => m.id === 1 && m.result, 5_000);

    bridge.send({
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: { name: "memwal_recall", arguments: { query: "anything" } },
    });
    await bridge.waitFor((m) => m.id === 2, 20_000);

    assert.ok(
        mock.sseGetAt.length >= 2,
        `expected a retry after the 429, saw ${mock.sseGetAt.length} attempts`,
    );
    const gap = mock.sseGetAt[1] - mock.sseGetAt[0];
    assert.ok(
        gap >= 2_000,
        `header-less 429 must fall back to the throttle floor; retry came after ${gap}ms`,
    );

    assert.equal(bridge.child.exitCode, null, "bridge should still be running, not exited");
    // The no-ETA branch tells the user what actually clears a concurrent cap.
    assert.match(bridge.stderr(), /closing another\s+MCP client/);
});
