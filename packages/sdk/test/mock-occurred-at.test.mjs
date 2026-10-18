import assert from "node:assert/strict";
import test from "node:test";

import { MemWalMock } from "../dist/index.js";

test("MemWalMock.analyze rejects an Invalid Date and still stores a valid anchor call", async () => {
    const mock = MemWalMock.create();
    await assert.rejects(
        () => mock.analyze("User likes tea", { occurredAt: new Date("garbage") }),
        {
            name: "TypeError",
            message: /occurredAt is an Invalid Date/,
        },
    );
    await assert.rejects(
        () => mock.analyzeAndWait("User likes tea", { occurredAt: new Date("garbage") }),
        { name: "TypeError" },
    );

    const stored = await mock.analyze("User likes tea", {
        occurredAt: new Date("2023-05-25T17:50:00.000Z"),
    });
    assert.equal(stored.facts[0].text, "User likes tea");
    assert.equal(stored.status, "done");
});
