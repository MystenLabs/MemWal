import assert from "node:assert/strict";
import test from "node:test";

import { applyDefaultNamespace } from "../dist/namespace.js";

test("applyDefaultNamespace injects configured namespace into memwal_remember_bulk", () => {
    const args = { facts: ["fact 1", "fact 2"] };
    const updated = applyDefaultNamespace("memwal_remember_bulk", args, "project-alpha");
    assert.equal(updated.namespace, "project-alpha");
    assert.deepEqual(updated.facts, ["fact 1", "fact 2"]);
    // Original args are not mutated.
    assert.equal(args.namespace, undefined);
});

test("applyDefaultNamespace respects explicit namespace on memwal_remember_bulk", () => {
    const args = { facts: ["fact 1"], namespace: "explicit-scope" };
    const updated = applyDefaultNamespace("memwal_remember_bulk", args, "project-alpha");
    assert.equal(updated.namespace, "explicit-scope");
});

test("applyDefaultNamespace injects into all namespace-aware tools", () => {
    const tools = [
        "memwal_remember",
        "memwal_remember_bulk",
        "memwal_recall",
        "memwal_analyze",
        "memwal_restore",
    ];

    for (const toolName of tools) {
        const updated = applyDefaultNamespace(toolName, {}, "shared-namespace");
        assert.equal(
            updated.namespace,
            "shared-namespace",
            `expected default namespace to be injected for ${toolName}`,
        );
    }
});

test("applyDefaultNamespace does not touch unrelated tools or empty defaults", () => {
    const login = applyDefaultNamespace("memwal_login", {}, "shared-namespace");
    assert.equal(login.namespace, undefined);

    const health = applyDefaultNamespace("memwal_health", {}, "shared-namespace");
    assert.equal(health.namespace, undefined);

    const none = applyDefaultNamespace("memwal_remember", { text: "hi" }, undefined);
    assert.equal(none.namespace, undefined);

    const blank = applyDefaultNamespace("memwal_remember", { namespace: "   " }, "work");
    assert.equal(blank.namespace, "work");
});
