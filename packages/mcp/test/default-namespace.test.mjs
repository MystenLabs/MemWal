import assert from "node:assert/strict";
import test from "node:test";

import { applyDefaultNamespace } from "../dist/bridge.js";

test("applyDefaultNamespace injects configured namespace into memwal_remember_bulk", () => {
    const msg = {
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: {
            name: "memwal_remember_bulk",
            arguments: {
                facts: ["fact 1", "fact 2"],
            },
        },
    };

    const updated = applyDefaultNamespace(msg, "project-alpha");
    assert.equal(updated.params.arguments.namespace, "project-alpha");
    assert.deepEqual(updated.params.arguments.facts, ["fact 1", "fact 2"]);
});

test("applyDefaultNamespace respects explicit namespace on memwal_remember_bulk", () => {
    const msg = {
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: {
            name: "memwal_remember_bulk",
            arguments: {
                facts: ["fact 1"],
                namespace: "explicit-scope",
            },
        },
    };

    const updated = applyDefaultNamespace(msg, "project-alpha");
    assert.equal(updated.params.arguments.namespace, "explicit-scope");
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
        const msg = {
            jsonrpc: "2.0",
            id: 3,
            method: "tools/call",
            params: {
                name: toolName,
                arguments: {},
            },
        };

        const updated = applyDefaultNamespace(msg, "shared-namespace");
        assert.equal(
            updated.params.arguments.namespace,
            "shared-namespace",
            `expected default namespace to be injected for ${toolName}`
        );
    }
});

test("applyDefaultNamespace does not touch unrelated tools or non-call RPC messages", () => {
    const loginMsg = {
        jsonrpc: "2.0",
        id: 4,
        method: "tools/call",
        params: {
            name: "memwal_login",
            arguments: {},
        },
    };
    const updatedLogin = applyDefaultNamespace(loginMsg, "test-ns");
    assert.equal(updatedLogin.params.arguments.namespace, undefined);

    const listMsg = {
        jsonrpc: "2.0",
        id: 5,
        method: "tools/list",
        params: {},
    };
    const updatedList = applyDefaultNamespace(listMsg, "test-ns");
    assert.equal(updatedList.params.arguments, undefined);
});
