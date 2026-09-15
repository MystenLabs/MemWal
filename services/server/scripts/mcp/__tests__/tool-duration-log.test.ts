/**
 * A slow hop between the sidecar and the relayer used to leave no trace.
 *
 * The relayer's own latency histogram cannot show one: it starts counting when
 * the request lands, so a minute spent reaching it reads there as a healthy few
 * milliseconds. The sidecar logged `tool.call` on the way in and nothing on the
 * way out, so the wait was invisible from both ends — it took polling the
 * relayer's Prometheus counter against a wall clock to even locate it.
 *
 * `wrapTool` now times every call and says how long it took, loudly past a
 * threshold. These tests pin that.
 *
 * IMPORTANT: `MCP_TOOL_SLOW_WARN_MS` is read when the module loads, so it is
 * set before the dynamic import below rather than at the top of the file.
 */
import assert from "node:assert/strict";
import test from "node:test";
import type { MemWalSession } from "../auth.js";

const SLOW_THRESHOLD_MS = 150;
process.env.MCP_TOOL_SLOW_WARN_MS = String(SLOW_THRESHOLD_MS);
const { wrapTool } = await import("../tools/util.js");

const SESSION = {
    accountId: `0x${"b".repeat(64)}`,
    relayerUrl: "http://127.0.0.1:8000",
    agentClient: "claude-code",
} as unknown as MemWalSession;

interface LogLine {
    level: string;
    event: string;
    [key: string]: unknown;
}

/** Run `fn` with stderr captured, returning the structured lines it wrote. */
async function capturingLogs<T>(fn: () => Promise<T>): Promise<{
    result: T;
    lines: LogLine[];
}> {
    const written: string[] = [];
    const original = process.stderr.write.bind(process.stderr);
    (process.stderr as unknown as { write: unknown }).write = (chunk: unknown) => {
        written.push(String(chunk));
        return true;
    };
    try {
        const result = await fn();
        return { result, lines: parse(written) };
    } finally {
        (process.stderr as unknown as { write: unknown }).write = original;
    }
}

function parse(written: string[]): LogLine[] {
    return written
        .join("")
        .split("\n")
        .filter((l) => l.trim().startsWith("{"))
        .map((l) => JSON.parse(l) as LogLine);
}

const ok = async () => ({ content: [{ type: "text" as const, text: "fine" }] });

test("a completed tool call reports how long it took", async () => {
    const { lines } = await capturingLogs(() =>
        wrapTool(SESSION, "memwal_health", ok)({})
    );

    const done = lines.find((l) => l.event === "tool.done");
    assert.ok(done, `no tool.done line:\n${JSON.stringify(lines, null, 2)}`);
    assert.equal(done.level, "info");
    assert.equal(done.tool, "memwal_health");
    assert.equal(typeof done.durationMs, "number");
    // The address dialled is the thing an operator has to change, so the line
    // that reports the latency has to name it.
    assert.equal(done.relayerUrl, "http://127.0.0.1:8000");
});

test("a call slower than the threshold is warned about, not filed as normal", async () => {
    const slow = async () => {
        await new Promise((r) => setTimeout(r, SLOW_THRESHOLD_MS * 2));
        return ok();
    };

    const { lines } = await capturingLogs(() =>
        wrapTool(SESSION, "memwal_health", slow)({})
    );

    // Assert on the SETTLED line specifically. The in-flight line is emitted by
    // the timer at the threshold itself, so its own durationMs sits within a
    // millisecond or two of the threshold and can land just under it — that is
    // timer resolution, not a defect, and asserting on it made this flaky in CI
    // (`durationMs 149 is under the threshold` at a 150ms threshold).
    const warned = lines.find((l) => l.event === "tool.slow" && l.settled === true);
    assert.ok(warned, `no settled tool.slow line:\n${JSON.stringify(lines, null, 2)}`);
    assert.equal(warned.level, "warn");
    assert.equal(warned.thresholdMs, SLOW_THRESHOLD_MS);
    assert.ok(
        (warned.durationMs as number) >= SLOW_THRESHOLD_MS,
        `durationMs ${warned.durationMs} is under the threshold that triggered it`
    );
    // A slow call is reported as slow — never also as a healthy one.
    assert.equal(lines.filter((l) => l.event === "tool.done").length, 0);
});

test("a call still running past the threshold is reported BEFORE it settles", async () => {
    // The whole point. The incident that motivated this left a tool call
    // outstanding for 61s; a log that only fires on settle says nothing for the
    // entire minute an operator is staring at the service.
    let release;
    const hang = () =>
        new Promise((resolve) => {
            release = () => resolve(ok());
        });

    const written = [];
    const original = process.stderr.write.bind(process.stderr);
    (process.stderr as unknown as { write: unknown }).write = (chunk: unknown) => {
        written.push(String(chunk));
        return true;
    };

    let lines;
    try {
        const call = wrapTool(SESSION, "memwal_health", hang as never)({});
        // Wait past the threshold while the call is deliberately still pending.
        await new Promise((r) => setTimeout(r, SLOW_THRESHOLD_MS * 2));
        lines = parse(written);

        const inflight = lines.find((l) => l.event === "tool.slow");
        assert.ok(
            inflight,
            `nothing was reported while the call was still running:\n${JSON.stringify(lines, null, 2)}`
        );
        assert.equal(inflight.level, "warn");
        assert.equal(inflight.settled, false, "the in-flight line must say it has not settled");
        assert.equal(inflight.tool, "memwal_health");

        release();
        await call;
    } finally {
        (process.stderr as unknown as { write: unknown }).write = original;
    }

    // And when it finally lands, the settle line marks that it was already
    // reported, so an operator counting warns does not double-count one call.
    const settled = parse(written).filter((l) => l.event === "tool.slow" && l.settled === true);
    assert.equal(settled.length, 1);
    assert.equal(settled[0].alreadyWarned, true);
});

test("a failing tool call still reports its duration", async () => {
    const boom = async (): Promise<never> => {
        throw new Error("relayer unreachable");
    };

    const { result, lines } = await capturingLogs(() =>
        wrapTool(SESSION, "memwal_recall", boom)({})
    );

    const failed = lines.find((l) => l.event === "tool.failed");
    assert.ok(failed, `no tool.failed line:\n${JSON.stringify(lines, null, 2)}`);
    assert.equal(failed.level, "warn");
    assert.equal(failed.tool, "memwal_recall");
    assert.equal(typeof failed.durationMs, "number");
    // The structured line has to name the failure, or an operator reading logs
    // learns only that something failed and must go hunting for the reason.
    assert.equal(failed.errMessage, "relayer unreachable");
    assert.equal(failed.errName, "Error");
    // The existing error envelope is untouched.
    assert.equal(result.isError, true);
    assert.ok(result.content[0].text.includes("relayer unreachable"));
});

test("a credential in the dialled URL never reaches a log line", async () => {
    // `session.relayerUrl` is whatever MEMWAL_SIDECAR_RELAYER_URL was set to,
    // and it is echoed on every outcome line. The Rust side redacts its own
    // startup lines; this is the per-call path, which is far noisier.
    const withSecret = {
        ...SESSION,
        relayerUrl: "https://ops:hunter2@relayer.internal:8000",
    } as unknown as MemWalSession;

    const { lines } = await capturingLogs(() =>
        wrapTool(withSecret, "memwal_health", ok)({})
    );

    const done = lines.find((l) => l.event === "tool.done");
    assert.ok(done, "no tool.done line");
    assert.ok(
        !JSON.stringify(lines).includes("hunter2"),
        `a credential reached the log:\n${JSON.stringify(lines, null, 2)}`
    );
    // Still useful: the host an operator has to change is preserved.
    assert.match(String(done.relayerUrl), /relayer\.internal:8000/);
});

test("an unparseable dial URL is dropped rather than echoed", async () => {
    const bad = { ...SESSION, relayerUrl: "not a url" } as unknown as MemWalSession;
    const { lines } = await capturingLogs(() => wrapTool(bad, "memwal_health", ok)({}));
    const done = lines.find((l) => l.event === "tool.done");
    assert.equal(done?.relayerUrl, null);
});
