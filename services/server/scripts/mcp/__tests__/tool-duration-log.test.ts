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

const SLOW_THRESHOLD_MS = 40;
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
        await new Promise((r) => setTimeout(r, SLOW_THRESHOLD_MS + 20));
        return ok();
    };

    const { lines } = await capturingLogs(() =>
        wrapTool(SESSION, "memwal_health", slow)({})
    );

    const warned = lines.find((l) => l.event === "tool.slow");
    assert.ok(warned, `no tool.slow line:\n${JSON.stringify(lines, null, 2)}`);
    assert.equal(warned.level, "warn");
    assert.equal(warned.thresholdMs, SLOW_THRESHOLD_MS);
    assert.ok(
        (warned.durationMs as number) >= SLOW_THRESHOLD_MS,
        `durationMs ${warned.durationMs} is under the threshold that triggered it`
    );
    // A slow call is reported once, as slow — not also as a healthy one.
    assert.equal(lines.filter((l) => l.event === "tool.done").length, 0);
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
    // The existing error envelope is untouched.
    assert.equal(result.isError, true);
    assert.ok(result.content[0].text.includes("relayer unreachable"));
});
