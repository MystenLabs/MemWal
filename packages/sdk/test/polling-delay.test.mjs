import assert from "node:assert/strict";
import test from "node:test";

import { pollingDelayMs } from "../dist/polling-delay.js";

const originalRandom = Math.random;

test.afterEach(() => {
    Math.random = originalRandom;
});

function withoutJitter() {
    Math.random = () => 0.5;
}

test("attempt 0 is immediate", () => {
    assert.equal(pollingDelayMs(0, 0), 0);
    assert.equal(pollingDelayMs(5000, 0), 0);
});

test("grows 1.5x from a 100ms floor toward 5s", () => {
    withoutJitter();
    assert.equal(pollingDelayMs(0, 1), 100);
    assert.equal(pollingDelayMs(50, 1), 100);
    assert.equal(pollingDelayMs(400, 1), 400);
    assert.equal(pollingDelayMs(400, 2), 600);
    assert.equal(pollingDelayMs(1500, 4), 5000);
    assert.equal(pollingDelayMs(1500, 20), 5000);
    assert.equal(pollingDelayMs(8000, 1), 8000);
    assert.equal(pollingDelayMs(8000, 15), 8000);
});
