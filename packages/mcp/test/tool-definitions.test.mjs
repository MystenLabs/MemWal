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
        // A negative cutoff drops every hit and reads as an empty namespace,
        // so the schema rejects it rather than returning a plausible nothing.
        assert.equal(maxDistance.minimum, 0);
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

/**
 * The bridge carries its own copy of the tool list for the cold-start window,
 * and nothing compares it to the sidecar's — the tests above only pin it
 * against literals. That is how the two drifted: the sidecar grew batch
 * settling and a pending-result contract, the bridge's copy did not, and the
 * mismatch is invisible until a real session hits it.
 *
 * These pin the parts an agent acts on, so the next divergence fails here
 * instead of in someone's first save of the session.
 */

test("cold-start memwal_remember_status accepts a whole batch", () => {
    for (const list of [TOOL_DEFINITIONS, SIGNED_OUT_TOOL_DEFINITIONS]) {
        const tool = list.find((t) => t.name === "memwal_remember_status");
        assert.ok(tool, "missing memwal_remember_status");

        // `memwal_remember_bulk` hands back a pending body telling the agent to
        // call this with job_ids. Under additionalProperties:false an absent
        // property makes that instruction unfollowable.
        const ids = tool.inputSchema.properties.job_ids;
        assert.ok(ids, "job_ids must be advertised, or a batch cannot be settled");
        assert.equal(ids.type, "array");
        assert.equal(ids.items.type, "string");
        // Matches MAX_BULK_ITEMS, so a full batch settles in one call.
        assert.equal(ids.maxItems, 20);

        // Requiring job_id would reject the batch form outright.
        assert.ok(
            !(tool.inputSchema.required ?? []).includes("job_id"),
            "job_id must not be required — the batch form passes job_ids instead",
        );
    }
});

test("cold-start write tools warn that a result may not be saved yet", () => {
    // Both write tools return at accept now. An agent that was never told a
    // pending result is normal reports it to the user as stored.
    for (const name of ["memwal_remember", "memwal_remember_bulk"]) {
        const d = desc(TOOL_DEFINITIONS, name);
        assert.match(d, /NOT yet saved|NOT saved/i, `${name} omits the pending warning`);
        assert.match(d, /memwal_remember_status/, `${name} does not say how to settle it`);
    }
});
