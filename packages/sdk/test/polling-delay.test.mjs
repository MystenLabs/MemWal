import assert from "node:assert/strict";
import test from "node:test";

import { pollingDelayMs } from "../dist/polling-delay.js";

const originalRandom = Math.random;

test.afterEach(() => {
    Math.random = originalRandom;
});

function withMaxJitter() {
    Math.random = () => 1;
}

test("attempt 0 is immediate", () => {
    withMaxJitter();
    assert.equal(pollingDelayMs(1500, 0), 0);
    assert.equal(pollingDelayMs(0, 0), 0);
    assert.equal(pollingDelayMs(5000, 0), 0);
});

test("pollIntervalMs 0 still floors at 100ms", () => {
    withMaxJitter();
    assert.equal(pollingDelayMs(0, 1), 125);
    assert.notEqual(pollingDelayMs(0, 1), 0);
    assert.notEqual(pollingDelayMs(0, 15), 0);
    assert.equal(pollingDelayMs(0, 1), pollingDelayMs(50, 1));
});

test("later polls grow 1.5x toward a 3s cap", () => {
    withMaxJitter();
    assert.equal(pollingDelayMs(400, 1), 500);
    assert.equal(pollingDelayMs(400, 2), 750);
    assert.equal(pollingDelayMs(400, 3), 1125);
    assert.ok(pollingDelayMs(400, 20) > pollingDelayMs(400, 1));
    assert.equal(pollingDelayMs(400, 20), 3750);
});

test("default 1500 grows toward 3000, not a flat 1500", () => {
    withMaxJitter();
    assert.equal(pollingDelayMs(1500, 1), 1875);
    assert.equal(pollingDelayMs(1500, 2), 2812);
    assert.equal(pollingDelayMs(1500, 3), 3750);
    assert.equal(pollingDelayMs(1500, 15), 3750);
    assert.ok(pollingDelayMs(1500, 2) > pollingDelayMs(1500, 1));
});

test("explicit interval above 3s is not clamped below the caller value", () => {
    withMaxJitter();
    assert.equal(pollingDelayMs(5000, 1), 6250);
    assert.equal(pollingDelayMs(5000, 15), 6250);
});
