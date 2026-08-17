import assert from "node:assert/strict";
import test from "node:test";
import { applyDefaultNamespace } from "../dist/bridge.js";

for (const name of [
    "auto_save_user_facts_to_memory",
    "memwal_remember",
    "memwal_remember_bulk",
]) {
    test(`default namespace is injected for ${name}`, () => {
        const message = {
            jsonrpc: "2.0",
            id: 1,
            method: "tools/call",
            params: { name, arguments: {} },
        };

        applyDefaultNamespace(message, "work");

        assert.equal(message.params.arguments.namespace, "work");
    });
}

test("explicit namespace still wins for the deprecated alias", () => {
    const message = {
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "memwal_remember", arguments: { namespace: "legacy" } },
    };

    applyDefaultNamespace(message, "work");

    assert.equal(message.params.arguments.namespace, "legacy");
});
