import test from "node:test";
import assert from "node:assert/strict";
import {
    getEnokiRetryDelayMs,
    isSponsoredTransactionInvalidatedMessage,
    isTransientEnokiStatus,
    parseRetryAfterMs,
    parseTryAgainBodyDelayMs,
} from "../enoki-retry.js";

const policy = {
    maxAttempts: 2,
    baseDelayMs: 5_000,
    maxDelayMs: 30_000,
};

test("classifies only Enoki rate-limit and server statuses as transient", () => {
    assert.equal(isTransientEnokiStatus(429), true);
    assert.equal(isTransientEnokiStatus(500), true);
    assert.equal(isTransientEnokiStatus(502), true);
    assert.equal(isTransientEnokiStatus(599), true);
    assert.equal(isTransientEnokiStatus(400), false);
    assert.equal(isTransientEnokiStatus(403), false);
});

test("uses Retry-After seconds before fallback backoff", () => {
    assert.equal(parseRetryAfterMs("7", 0), 7_000);
    assert.equal(getEnokiRetryDelayMs({
        ...policy,
        attempt: 1,
        status: 429,
        retryAfter: "7",
    }), 7_000);
});

test("uses Enoki HTML body retry hint for 502 responses", () => {
    const body = "<h2>The server encountered a temporary error. Please try again in 30 seconds.</h2>";
    assert.equal(parseTryAgainBodyDelayMs(body), 30_000);
    assert.equal(getEnokiRetryDelayMs({
        ...policy,
        attempt: 1,
        status: 502,
        body,
    }), 30_000);
});

test("caps long retry hints", () => {
    assert.equal(getEnokiRetryDelayMs({
        ...policy,
        attempt: 1,
        status: 503,
        body: "please try again in 2 minutes",
    }), 30_000);
});

test("does not retry final attempt or deterministic 400 errors", () => {
    assert.equal(getEnokiRetryDelayMs({
        ...policy,
        attempt: 2,
        status: 502,
        body: "please try again in 30 seconds",
    }), null);
    assert.equal(getEnokiRetryDelayMs({
        ...policy,
        attempt: 1,
        status: 400,
        body: "{\"errors\":[{\"code\":\"dry_run_failed\"}]}",
    }), null);
});

test("retries transport errors with exponential fallback", () => {
    assert.equal(getEnokiRetryDelayMs({
        ...policy,
        attempt: 1,
        transportError: true,
    }), 5_000);
});

test("detects invalidated sponsored transaction responses", () => {
    assert.equal(
        isSponsoredTransactionInvalidatedMessage(
            'Enoki API error (400): {"errors":[{"code":"expired","message":"Sponsored transaction has expired"}]}',
        ),
        true,
    );
    assert.equal(
        isSponsoredTransactionInvalidatedMessage(
            'Enoki API error (404): {"errors":[{"code":"not_found","message":"Sponsored transaction not found"}]}',
        ),
        true,
    );
    assert.equal(
        isSponsoredTransactionInvalidatedMessage(
            'Enoki API error (400): {"errors":[{"code":"dry_run_failed"}]}',
        ),
        false,
    );
});
