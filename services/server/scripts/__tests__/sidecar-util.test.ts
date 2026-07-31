import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
    delayInjectedResponseOnce,
    dedupeAddresses,
    errorMessage,
    errorName,
    formattedError,
    mapConcurrent,
    parseWalrusKeySlot,
    shortAddress,
    truncateForLog,
} from "../sidecar/util.js";

test("durable response fault marker names one job and records the release", async () => {
    const dir = mkdtempSync(join(tmpdir(), "memwal-fault-"));
    const marker = join(dir, "job");
    process.env.SIDECAR_FAULT_RESPONSE_DELAY_MS = "50";
    process.env.SIDECAR_FAULT_MARKER_FILE = marker;
    try {
        const delayed = delayInjectedResponseOnce(true, "legacy-entry-a");
        // The marker is written synchronously before the delay starts: inside
        // the ambiguous window it holds only the job line, no "released".
        assert.equal(readFileSync(marker, "utf8"), "legacy-entry-a\n");
        await delayed;
        // "released" is appended just before the delayed response is sent.
        assert.equal(readFileSync(marker, "utf8"), "legacy-entry-a\nreleased\n");
        // One-shot: later jobs neither delay nor rewrite the marker.
        await delayInjectedResponseOnce(true, "legacy-entry-b");
        assert.equal(readFileSync(marker, "utf8"), "legacy-entry-a\nreleased\n");
    } finally {
        delete process.env.SIDECAR_FAULT_RESPONSE_DELAY_MS;
        delete process.env.SIDECAR_FAULT_MARKER_FILE;
        rmSync(dir, { recursive: true, force: true });
    }
});

test("response fault injection requires a durable marker", async () => {
    process.env.SIDECAR_FAULT_RESPONSE_DELAY_MS = "1";
    delete process.env.SIDECAR_FAULT_MARKER_FILE;
    try {
        await assert.rejects(
            delayInjectedResponseOnce(true, "legacy-entry-a"),
            /SIDECAR_FAULT_MARKER_FILE is required/,
        );
    } finally {
        delete process.env.SIDECAR_FAULT_RESPONSE_DELAY_MS;
    }
});

test("shortAddress truncates long addresses and passes short values through", () => {
    assert.equal(
        shortAddress("0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef"),
        "0x12345678...abcdef",
    );
    assert.equal(shortAddress("0xabc"), "0xabc");
    assert.equal(shortAddress(42), undefined);
    assert.equal(shortAddress(undefined), undefined);
});

test("truncateForLog caps strings and stringifies objects", () => {
    assert.equal(truncateForLog("abc"), "abc");
    assert.equal(truncateForLog("x".repeat(600)).length, 503);
    assert.equal(truncateForLog({ a: 1 }), '{"a":1}');
});

test("error helpers extract name and message from arbitrary throwables", () => {
    const typed = new RangeError("boom");
    assert.equal(errorMessage(typed), "boom");
    assert.equal(errorName(typed), "RangeError");
    assert.equal(formattedError(typed), "RangeError: boom");
    assert.equal(formattedError(new Error("plain")), "plain");
    assert.equal(formattedError("string error"), "string error");
    assert.equal(errorName({ name: "Custom" }), "Custom");
});

test("dedupeAddresses drops empties, nulls and duplicates", () => {
    assert.deepEqual(
        dedupeAddresses(["0xa", null, undefined, "", "0xa", "0xb"]),
        ["0xa", "0xb"],
    );
});

test("parseWalrusKeySlot accepts non-negative integers and digit strings only", () => {
    assert.equal(parseWalrusKeySlot(0), 0);
    assert.equal(parseWalrusKeySlot(3), 3);
    assert.equal(parseWalrusKeySlot("7"), 7);
    assert.equal(parseWalrusKeySlot(-1), null);
    assert.equal(parseWalrusKeySlot(1.5), null);
    assert.equal(parseWalrusKeySlot("abc"), null);
    assert.equal(parseWalrusKeySlot("1e3"), null);
    assert.equal(parseWalrusKeySlot(null), null);
});

test("mapConcurrent preserves order and honors the concurrency bound", async () => {
    let active = 0;
    let maxActive = 0;
    const items = [1, 2, 3, 4, 5, 6];
    const results = await mapConcurrent(items, 2, async (n) => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        await new Promise((r) => setTimeout(r, 5));
        active -= 1;
        return n * 10;
    });
    assert.deepEqual(results, [10, 20, 30, 40, 50, 60]);
    assert.ok(maxActive <= 2, `expected ≤2 concurrent workers, saw ${maxActive}`);
});
