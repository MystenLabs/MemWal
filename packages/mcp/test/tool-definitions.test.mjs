/**
 * Signed-in cold-start tools/list (bridge) must keep the sidecar's proactive
 * wording. Signed-out tools/list (auth-required) must stay conservative so
 * a model without credentials does not spam remember and collect 401s.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
    TOOL_DEFINITIONS,
    SIGNED_OUT_TOOL_DEFINITIONS,
} from "../dist/auth-required.js";

function desc(list, name) {
    const tool = list.find((t) => t.name === name);
    assert.ok(tool, `missing ${name}`);
    return tool.description;
}

function annotations(list, name) {
    const tool = list.find((t) => t.name === name);
    assert.ok(tool, `missing ${name}`);
    return tool.annotations;
}

function assertConsentBits(text) {
    assert.match(text, /never ask permission/i);
    assert.match(text, /built-in memory/i);
    assert.match(text, /Anthropic Memory/);
    assert.match(text, /Seal-encrypted on Walrus/);
    assert.match(text, /memory\.walrus\.xyz/);
}

test("signed-in cold-start remember/recall descriptions are proactive", () => {
    const remember = desc(TOOL_DEFINITIONS, "memwal_remember");
    const recall = desc(TOOL_DEFINITIONS, "memwal_recall");
    const bulk = desc(TOOL_DEFINITIONS, "memwal_remember_bulk");
    assert.match(remember, /PROACTIVELY/);
    assert.doesNotMatch(remember, /Call ONLY when the user explicitly asks/);
    assert.match(recall, /PROACTIVELY/);
    assertConsentBits(remember);
    assertConsentBits(bulk);
    assert.match(recall, /memory\.walrus\.xyz/);
    assert.match(recall, /Seal-encrypted on Walrus/);
});

test("signed-out tools/list keeps conservative remember wording", () => {
    const remember = desc(SIGNED_OUT_TOOL_DEFINITIONS, "memwal_remember");
    const bulk = desc(SIGNED_OUT_TOOL_DEFINITIONS, "memwal_remember_bulk");
    const recall = desc(SIGNED_OUT_TOOL_DEFINITIONS, "memwal_recall");
    assert.match(remember, /Call ONLY when the user explicitly asks/);
    assert.doesNotMatch(remember, /PROACTIVELY/);
    assert.match(bulk, /Call ONLY when the user explicitly asks/);
    assert.doesNotMatch(bulk, /PROACTIVELY/);
    assert.doesNotMatch(bulk, /never ask permission/i);
    assert.doesNotMatch(recall, /PROACTIVELY/);
});

test("memwal_recall is advertised as a read-only search", () => {
    assert.deepEqual(annotations(TOOL_DEFINITIONS, "memwal_recall"), {
        readOnlyHint: true,
        destructiveHint: false,
    });
    assert.deepEqual(annotations(SIGNED_OUT_TOOL_DEFINITIONS, "memwal_recall"), {
        readOnlyHint: true,
        destructiveHint: false,
    });
});

test("memwal_remember stays a write tool", () => {
    assert.equal(annotations(TOOL_DEFINITIONS, "memwal_remember").readOnlyHint, false);
    assert.equal(annotations(TOOL_DEFINITIONS, "memwal_remember_bulk").readOnlyHint, false);
});
