import assert from "node:assert/strict";
import test from "node:test";

import { MemWalMock } from "../dist/mock.js";

function cursor(value) {
    return Buffer.from(JSON.stringify(value)).toString("base64url");
}

test("listNamespaces rejects a cursor whose updated_at is not a date", async () => {
    const mock = MemWalMock.create();
    await mock.remember("a", "ns-a");
    await mock.remember("b", "ns-b");
    await mock.remember("c", "ns-c");

    const bad = cursor({ updated_at: "not-a-date", namespace: "ns-a", snapshot_at: null });
    await assert.rejects(
        () => mock.listNamespaces({ cursor: bad }),
        /invalid namespace cursor/,
    );

    const page = await mock.listNamespaces();
    assert.equal(page.namespaces.length, 3);
});

test("listNamespaces rejects a null cursor payload instead of restarting the walk", async () => {
    const mock = MemWalMock.create();
    await mock.remember("a", "ns-a");
    await assert.rejects(
        () => mock.listNamespaces({ cursor: cursor(null) }),
        /invalid namespace cursor/,
    );
});
