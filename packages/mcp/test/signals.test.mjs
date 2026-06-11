/**
 * Unit tests for the heuristic signal detectors used by the MemWal lifecycle
 * hooks (../plugin/scripts/lib/signals.mjs). These are pure regex functions —
 * cheap to test, and the place a wording tweak is most likely to silently
 * regress the auto-recall / auto-remember behavior the hooks rely on.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import {
    detectRecall,
    detectRemember,
    detectError,
} from "../plugin/scripts/lib/signals.mjs";

test("detectRecall — fires on references to past work / preferences", () => {
    for (const s of [
        "Let's pick up where we left off yesterday",
        "As I mentioned earlier, the API is rate limited",
        "Last time we decided to use pnpm",
        "What's my usual setup for this?",
        "Can you catch me up on the project?",
    ]) {
        assert.equal(detectRecall(s), true, `should fire: ${s}`);
    }
});

test("detectRecall — stays quiet on fresh, context-free prompts", () => {
    for (const s of [
        "Write a function that adds two numbers",
        "Please refactor this component",
        "",
        null,
    ]) {
        assert.equal(detectRecall(s), false, `should stay quiet: ${s}`);
    }
});

test("detectRemember — fires on durable facts / preferences / identity", () => {
    for (const s of [
        "I prefer pnpm and TypeScript strict mode",
        "Remember that I use tabs, not spaces",
        "My name is Uy",
        "From now on, use conventional commits",
        "We standardize on Rust for services",
    ]) {
        assert.equal(detectRemember(s), true, `should fire: ${s}`);
    }
});

test("detectRemember — stays quiet on transient requests", () => {
    for (const s of [
        "What does this function do?",
        "Please fix the failing build",
        "",
        null,
    ]) {
        assert.equal(detectRemember(s), false, `should stay quiet: ${s}`);
    }
});

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
