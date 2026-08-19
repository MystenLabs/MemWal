/**
 * UserPromptSubmit hook: recall questions must inject memwal_recall, not
 * memwal_remember. The previous heuristic treated "how I like to work" as a
 * new preference and told the agent to save.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const HOOK = resolve(__dirname, "../plugin/scripts/on_user_prompt.mjs");

function runHook(prompt, sessionId = `test-${Math.random().toString(16).slice(2)}`) {
    const result = spawnSync(process.execPath, [HOOK], {
        input: JSON.stringify({ prompt, session_id: sessionId }),
        encoding: "utf8",
    });
    assert.equal(result.status, 0, result.stderr);
    if (!result.stdout.trim()) return "";
    const parsed = JSON.parse(result.stdout);
    return parsed.hookSpecificOutput?.additionalContext ?? "";
}

test("recall question injects memwal_recall, not remember", () => {
    const ctx = runHook(
        "What do you remember about how I like to work, my coffee order, and my staging canary nickname?",
    );
    assert.match(ctx, /memwal_recall/);
    assert.doesNotMatch(ctx, /memwal_remember/);
});

test("stated preferences inject memwal_remember", () => {
    const ctx = runHook(
        "A few things about how I work: I always use pnpm, TypeScript strict mode, and my coffee order is a matcha oat latte. My staging canary nickname is coral-fox-77.",
    );
    assert.match(ctx, /memwal_remember/);
    assert.doesNotMatch(ctx, /memwal_recall/);
});
