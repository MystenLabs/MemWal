/**
 * Unit tests for the PostToolUse error detector
 * (../plugin/scripts/lib/signals.mjs). Remember vs recall is no longer
 * keyword-gated — see user-prompt-hook.test.mjs.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { detectError } from "../plugin/scripts/lib/signals.mjs";

test("detectError — fires on strong error markers", () => {
    for (const s of [
        "Traceback (most recent call last):",
        "zsh: command not found: foo",
        "Error: cannot find module 'walrus'",
        "fatal: not a git repository",
        "EACCES: permission denied, open '/etc/hosts'",
    ]) {
        assert.equal(detectError(s), true, `should fire: ${s}`);
    }
});

test("detectError — needs >=2 weak markers; ignores single / clean output", () => {
    assert.equal(detectError("error: one thing went wrong"), false); // single weak pair
    assert.equal(detectError("error: first\nerror: second"), true); // two weak pairs
    assert.equal(detectError("All 42 tests passed"), false);
    assert.equal(detectError(""), false);
    assert.equal(detectError(null), false);
});
