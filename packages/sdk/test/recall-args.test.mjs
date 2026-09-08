import assert from "node:assert/strict";
import test from "node:test";

import { resolveLimitOrOptions, resolveRecallCall } from "../dist/recall-args.js";

test("resolveRecallCall maps object and positional forms", () => {
    assert.deepEqual(resolveRecallCall({ query: "food", namespace: "profile", limit: 3 }), {
        query: "food",
        options: { namespace: "profile", limit: 3 },
    });
    assert.deepEqual(resolveRecallCall("food", 5, "profile"), {
        query: "food",
        options: { limit: 5, namespace: "profile" },
    });
    assert.deepEqual(resolveRecallCall("food", { namespace: "profile" }), {
        query: "food",
        options: { namespace: "profile" },
    });
});

test("resolveRecallCall rejects a namespace string as the second argument", () => {
    assert.throws(() => resolveRecallCall("food allergies", "profile"), {
        name: "TypeError",
        message: /recall\(\{ query, namespace \}\)/,
    });
    assert.throws(() => resolveLimitOrOptions("recallManual", "profile"), {
        name: "TypeError",
        message: /recallManual/,
    });
    assert.throws(() => resolveRecallCall("food", ["profile"]), TypeError);
});
