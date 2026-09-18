/**
 * A tool call that timed out used to reach the agent as
 * `Tool error: This operation was aborted` — no step, no word on whether the
 * relayer was up, nothing to decide between retrying, waiting and reporting.
 * `wrapTool` now names the cause, checks the relayer's health when the cause
 * is the connection, and says what to do next (WALM-396).
 */
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import test from "node:test";
import type { MemWalSession } from "../auth.js";
import {
    classifyToolError,
    describeFailure,
    probeRelayerHealth,
} from "../tools/failure.js";
import { wrapTool } from "../tools/util.js";

/** A relayer whose `/health` answers however `respond` says. */
async function fakeRelayer(
    respond: (res: http.ServerResponse) => void,
): Promise<{ url: string; close: () => Promise<void> }> {
    const server = http.createServer((req, res) => {
        if (req.url === "/health") respond(res);
        else res.writeHead(404).end();
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as AddressInfo;
    return {
        url: `http://127.0.0.1:${port}`,
        close: () =>
            new Promise((resolve) => {
                server.closeAllConnections();
                server.close(() => resolve());
            }),
    };
}

/** A port nothing listens on, so a connect is refused at once. */
async function closedPortUrl(): Promise<string> {
    const probe = await fakeRelayer(() => {});
    await probe.close();
    return probe.url;
}

const healthy = (res: http.ServerResponse) =>
    res
        .writeHead(200, { "content-type": "application/json" })
        .end(JSON.stringify({ status: "ok", version: "1.4.2" }));

function sessionAt(relayerUrl: string): MemWalSession {
    return {
        accountId: `0x${"b".repeat(64)}`,
        relayerUrl,
        agentClient: "claude-code",
    } as unknown as MemWalSession;
}

function recallTimeout(stage: string): Error {
    const body = {
        error: `Recall timed out after 14001ms during ${stage}`,
        message: `Recall timed out after 14001ms during ${stage}`,
        code: "RECALL_TIMEOUT",
        stage,
        elapsed_ms: 14001,
    };
    const err = new Error(`Walrus Memory server error (504): ${body.message}`) as Error & {
        status: number;
        serverCode: string;
    };
    err.status = 504;
    err.serverCode = "RECALL_TIMEOUT";
    err.cause = JSON.stringify(body);
    return err;
}

function named(name: string, message = "boom"): Error {
    const err = new Error(message);
    err.name = name;
    return err;
}

async function textOf(
    session: MemWalSession,
    tool: string,
    err: unknown,
): Promise<{ text: string; isError?: boolean }> {
    const originalError = console.error;
    console.error = () => {};
    const originalWrite = process.stderr.write.bind(process.stderr);
    (process.stderr as unknown as { write: unknown }).write = () => true;
    try {
        const result = await wrapTool(session, tool, async () => {
            throw err;
        })({});
        return { text: result.content[0].text, isError: result.isError };
    } finally {
        console.error = originalError;
        (process.stderr as unknown as { write: unknown }).write = originalWrite;
    }
}

// ── classifyToolError ────────────────────────────────────────────────────

test("a relayer RECALL_TIMEOUT is read with its stage and time", () => {
    assert.deepEqual(classifyToolError(recallTimeout("walrus_download")), {
        kind: "recall_timeout",
        stage: "walrus_download",
        elapsedMs: 14001,
    });
});

test("every shape the SDK gives up in reads as a timeout", () => {
    // 0.1.7 aborts recall with a bare AbortError; 0.1.8 names its own.
    for (const name of ["AbortError", "TimeoutError", "MemWalRequestTimeout"]) {
        assert.deepEqual(classifyToolError(named(name)), { kind: "timeout" }, name);
    }
});

test("a failed connect reads as unreachable, with the socket's code", () => {
    const err = new TypeError("fetch failed", {
        cause: Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" }),
    });
    assert.deepEqual(classifyToolError(err), {
        kind: "unreachable",
        code: "ECONNREFUSED",
        host: null,
    });
});

test("a failed DNS lookup keeps the host it was for", () => {
    const err = new TypeError("fetch failed", {
        cause: Object.assign(new Error("getaddrinfo ENOTFOUND fullnode.example"), {
            code: "ENOTFOUND",
            hostname: "fullnode.example",
        }),
    });
    assert.deepEqual(classifyToolError(err), {
        kind: "unreachable",
        code: "ENOTFOUND",
        host: "fullnode.example",
    });
});

test("anything else keeps today's handling", () => {
    assert.deepEqual(classifyToolError(new Error("bad input")), { kind: "other" });
    // The remember tools name their own timeouts; those keep their prefixes.
    assert.deepEqual(classifyToolError(named("MemWalRememberJobTimeout")), { kind: "other" });
    assert.deepEqual(classifyToolError("not even an error"), { kind: "other" });
});

// ── probeRelayerHealth ───────────────────────────────────────────────────

test("a healthy relayer is reported with its version", async (t) => {
    const relayer = await fakeRelayer(healthy);
    t.after(relayer.close);
    const probe = await probeRelayerHealth(relayer.url, 2000);
    assert.equal(probe.kind, "ok");
    assert.equal(probe.kind === "ok" && probe.version, "1.4.2");
});

test("an unhealthy relayer is reported by status", async (t) => {
    const relayer = await fakeRelayer((res) => res.writeHead(503).end());
    t.after(relayer.close);
    const probe = await probeRelayerHealth(relayer.url, 2000);
    assert.equal(probe.kind, "http");
    assert.equal(probe.kind === "http" && probe.status, 503);
});

test("a relayer that never answers is reported as a timeout, on time", async (t) => {
    const relayer = await fakeRelayer(() => {});
    t.after(relayer.close);
    const started = Date.now();
    const probe = await probeRelayerHealth(relayer.url, 200);
    assert.equal(probe.kind, "timeout");
    assert.ok(Date.now() - started < 2000, "the probe must not outlive its budget");
});

test("paused writes show in the health line, since /health still answers 200", async (t) => {
    const relayer = await fakeRelayer((res) =>
        res
            .writeHead(200, { "content-type": "application/json" })
            .end(JSON.stringify({ status: "ok", version: "1.4.2", writes: "paused" })),
    );
    t.after(relayer.close);
    const probe = await probeRelayerHealth(relayer.url, 2000);
    assert.equal(probe.kind === "ok" && probe.writesUnavailable, true);
    assert.match(
        describeFailure("memwal_remember", { kind: "timeout" }, probe),
        /Relayer health: ok \(\d+ms, v1\.4\.2, writes unavailable\)/,
    );
});

test("a probe given a budget AbortSignal cannot take still resolves", async () => {
    const probe = await probeRelayerHealth("http://127.0.0.1:1", 2500.5);
    assert.ok(probe.kind === "unreachable" || probe.kind === "timeout", probe.kind);
});

test("a relayer that refuses the connection is reported as unreachable", async () => {
    const probe = await probeRelayerHealth(await closedPortUrl(), 2000);
    assert.equal(probe.kind, "unreachable");
    assert.equal(probe.kind === "unreachable" && probe.code, "ECONNREFUSED");
});

// ── describeFailure ──────────────────────────────────────────────────────

test("every message carries the three labelled lines", () => {
    const text = describeFailure("memwal_recall", { kind: "timeout" }, { kind: "ok", ms: 38 });
    assert.match(text, /^Cause: /m);
    assert.match(text, /^Relayer health: /m);
    assert.match(text, /^Next step: /m);
});

test("each stage gets its own advice", () => {
    const expectations: Record<string, RegExp> = {
        embed: /embedding/i,
        vector_search: /database|index/i,
        walrus_download: /lower `limit`/,
        seal_decrypt: /SEAL/,
        auth: /delegate key/,
    };
    for (const [stage, advice] of Object.entries(expectations)) {
        const text = describeFailure(
            "memwal_recall",
            { kind: "recall_timeout", stage, elapsedMs: 14001 },
            null,
        );
        assert.match(text, advice, stage);
        assert.match(text, /14\.0s/, stage);
    }
});

// ── wrapTool end to end ──────────────────────────────────────────────────

test("a recall the relayer cut short names the step and what to change", async () => {
    const { text, isError } = await textOf(
        sessionAt("http://127.0.0.1:1"),
        "memwal_recall",
        recallTimeout("walrus_download"),
    );
    assert.equal(isError, true);
    assert.match(text, /downloading memories from Walrus/);
    assert.match(text, /lower `limit`/);
    // The relayer answered this call, so there is nothing to probe.
    assert.match(text, /Relayer health: up/);
});

test("a recall the SDK gave up on says the relayer is up, and that a retry is safe", async (t) => {
    const relayer = await fakeRelayer(healthy);
    t.after(relayer.close);
    const { text, isError } = await textOf(
        sessionAt(relayer.url),
        "memwal_recall",
        named("AbortError", "This operation was aborted"),
    );
    assert.equal(isError, true);
    assert.match(text, /Relayer health: ok/);
    assert.match(text, /safe to retry/i);
    assert.doesNotMatch(text, /This operation was aborted$/);
});

test("a recall that cannot reach a dead relayer says so", async () => {
    const err = new TypeError("fetch failed", {
        cause: Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" }),
    });
    const { text } = await textOf(sessionAt(await closedPortUrl()), "memwal_recall", err);
    assert.match(text, /ECONNREFUSED/);
    assert.match(text, /Relayer health: unreachable/);
});

test("a failed request is not blamed on a relayer that answers its health check", async (t) => {
    // SDK 0.1.7 builds the SEAL session on the Sui fullnode before the
    // recall request goes out, and a failure there is a bare "fetch failed".
    const relayer = await fakeRelayer(healthy);
    t.after(relayer.close);
    const err = new TypeError("fetch failed", {
        cause: Object.assign(new Error("getaddrinfo ENOTFOUND fullnode.example"), {
            code: "ENOTFOUND",
            hostname: "fullnode.example",
        }),
    });
    const { text } = await textOf(sessionAt(relayer.url), "memwal_recall", err);
    assert.match(text, /could not complete a network request/);
    assert.match(text, /fullnode\.example/);
    assert.match(text, /answered its health check/);
    assert.doesNotMatch(text, /could not reach the relayer|stalled inside/);
});

test("a timeout on a healthy relayer does not claim the relayer is where it stalled", async (t) => {
    const relayer = await fakeRelayer(healthy);
    t.after(relayer.close);
    const { text } = await textOf(sessionAt(relayer.url), "memwal_recall", named("AbortError"));
    assert.match(text, /inside the relayer, or on a service it waits on first/);
    assert.doesNotMatch(text, /stalled inside it\./);
});

test("a write that timed out is never offered a blind retry", async (t) => {
    const relayer = await fakeRelayer(healthy);
    t.after(relayer.close);
    for (const tool of ["memwal_remember", "memwal_remember_bulk", "memwal_analyze"]) {
        const { text } = await textOf(sessionAt(relayer.url), tool, named("AbortError"));
        assert.match(text, /may already be stored/, tool);
        assert.match(text, /memwal_recall/, tool);
        assert.doesNotMatch(text, /safe to retry|please retry/i, tool);
    }
});

test("an error that is not about time or reachability keeps its old wording", async () => {
    const { text } = await textOf(
        sessionAt("http://127.0.0.1:1"),
        "memwal_recall",
        new Error("namespace is invalid"),
    );
    assert.equal(text, "Tool error: namespace is invalid");
});
