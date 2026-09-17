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
    ALL_TOOL_DEFINITIONS,
    BASELINE_RELAYER_TOOLS,
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

test("memwal_remember_status accepts a whole batch", () => {
    // Not advertised at cold start (see the baseline tests below) — the shape
    // is still pinned here, so it stays reviewed while it waits for the prod
    // release that lets it into the cold-start list.
    for (const list of [ALL_TOOL_DEFINITIONS]) {
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

test("memwal_remember_status waitMs bound matches the sidecar's ceiling", () => {
    // The sidecar validates waitMs with zod and rejects anything above its own
    // cap. Advertising a larger maximum invites the agent to send a value that
    // comes straight back as an MCP validation error — observed live at 60000
    // once the sidecar lowered its ceiling to 45000.
    for (const list of [ALL_TOOL_DEFINITIONS]) {
        const tool = list.find((t) => t.name === "memwal_remember_status");
        assert.equal(tool.inputSchema.properties.waitMs.maximum, 45000);
    }
});

test("cold-start write tools warn that a result may not be saved yet", () => {
    // Both write tools return at accept now. An agent that was never told a
    // pending result is normal reports it to the user as stored.
    for (const name of ["memwal_remember", "memwal_remember_bulk"]) {
        const d = desc(TOOL_DEFINITIONS, name);
        assert.match(d, /NOT (yet )?(saved|stored)/i, `${name} omits the pending warning`);
        assert.match(d, /settle it|settle them/, `${name} does not say to settle the job`);
    }
});

/**
 * GH #928. The bridge ships on npm and updates itself; a relayer ships per
 * environment and does not, so 0.0.14-dev.0 dialled prod and staging still on
 * 0.0.13. Its cold-start list named `memwal_remember_status`, which neither
 * serves, and the description told the agent to go call it — one live run
 * spent 90.67s on a tool that does not exist there before erroring.
 *
 * The cold-start list is served before any relayer capability is known, so it
 * has to be a floor: only tools the oldest supported relayer serves, and no
 * description pointing at anything outside it.
 */

test("cold-start lists advertise nothing beyond the baseline relayer", () => {
    for (const list of [TOOL_DEFINITIONS, SIGNED_OUT_TOOL_DEFINITIONS]) {
        const names = list.map((t) => t.name);
        const beyond = names.filter(
            (n) => !BASELINE_RELAYER_TOOLS.has(n) && n !== "memwal_login",
        );
        assert.deepEqual(
            beyond,
            [],
            `cold start advertises tools the oldest supported relayer cannot serve: ${beyond}`,
        );
        for (const baseline of BASELINE_RELAYER_TOOLS) {
            assert.ok(names.includes(baseline), `cold start omits ${baseline}`);
        }
    }
});

test("no cold-start description names a tool cold start does not advertise", () => {
    // The tool list and the prose have to agree. A description is an
    // instruction the agent follows, so naming an unadvertised tool is the
    // same defect as listing it — it just fails one step later.
    for (const list of [TOOL_DEFINITIONS, SIGNED_OUT_TOOL_DEFINITIONS]) {
        const advertised = new Set(list.map((t) => t.name));
        for (const tool of list) {
            const named = tool.description.match(/memwal_[a-z_]+/g) ?? [];
            const dangling = [...new Set(named)].filter((n) => !advertised.has(n));
            assert.deepEqual(
                dangling,
                [],
                `${tool.name}'s description sends the agent to unadvertised tools: ${dangling}`,
            );
        }
    }
});
