/**
 * UserPromptSubmit hook injects the same decision rubric for every
 * substantive prompt. It must not classify remember vs recall from
 * English keywords — Vietnamese, typos, and "I like" nested in a
 * question all get the same text, and the agent chooses the tool.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DECISION_RUBRIC } from "../plugin/scripts/lib/decision-rubric.mjs";

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

const SUBSTANTIVE = [
    "What do you remember about how I like to work, my coffee order, and my staging canary nickname?",
    "A few things about how I work: I always use pnpm, TypeScript strict mode, and my coffee order is a matcha oat latte. My staging canary nickname is coral-fox-77.",
    "Can you remember that I always use pnpm?",
    "Tell me what you remember about how I like to work",
    "Tui luôn dùng pnpm và order cafe là matcha oat latte, nickname review là cedar-wren-11.",
    "Ban nho cafe order cua toi la gi?",
    "Remeber that I always use pnpm and my canary is cedar-wren-11.",
];

test("substantive prompts get the decision rubric, not a classified directive", () => {
    for (const prompt of SUBSTANTIVE) {
        const ctx = runHook(prompt);
        assert.equal(ctx, DECISION_RUBRIC, `should inject rubric: ${prompt}`);
        assert.match(ctx, /memwal_recall/);
        assert.match(ctx, /memwal_remember/);
        assert.match(ctx, /any language or spelling/);
        assert.match(ctx, /Writes are expensive/);
        assert.match(ctx, /skip one-off tasks/);
        assert.doesNotMatch(ctx, /The user is referencing earlier work/);
        assert.doesNotMatch(ctx, /The user just stated a durable fact/);
    }
});

test("short prompts stay quiet", () => {
    assert.equal(runHook("ok thanks"), "");
    assert.equal(runHook("yes"), "");
});
