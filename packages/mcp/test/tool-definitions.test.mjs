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

test("signed-in cold-start remember/recall descriptions are proactive", () => {
    const remember = desc(TOOL_DEFINITIONS, "memwal_remember");
    const recall = desc(TOOL_DEFINITIONS, "memwal_recall");
    assert.match(remember, /PROACTIVELY/);
    assert.doesNotMatch(remember, /Call ONLY when the user explicitly asks/);
    assert.match(recall, /PROACTIVELY/);
});

test("signed-out tools/list keeps conservative remember wording", () => {
    const remember = desc(SIGNED_OUT_TOOL_DEFINITIONS, "memwal_remember");
    const recall = desc(SIGNED_OUT_TOOL_DEFINITIONS, "memwal_recall");
    assert.match(remember, /Call ONLY when the user explicitly asks/);
    assert.doesNotMatch(remember, /PROACTIVELY/);
    assert.doesNotMatch(recall, /PROACTIVELY/);
});

test("cold-start memwal_recall schema exposes maxDistance as cosine distance", () => {
    const signedIn = TOOL_DEFINITIONS.find((t) => t.name === "memwal_recall");
    const signedOut = SIGNED_OUT_TOOL_DEFINITIONS.find((t) => t.name === "memwal_recall");
    assert.ok(signedIn);
    assert.ok(signedOut);
    for (const tool of [signedIn, signedOut]) {
        const maxDistance = tool.inputSchema.properties.maxDistance;
        assert.equal(maxDistance.type, "number");
        assert.match(maxDistance.description, /cosine-distance/i);
        assert.match(maxDistance.description, /distance >= maxDistance/);
        assert.ok(!(tool.inputSchema.required ?? []).includes("maxDistance"));
    }
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
