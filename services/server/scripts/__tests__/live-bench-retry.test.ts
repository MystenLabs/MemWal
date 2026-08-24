import test from "node:test";
import assert from "node:assert/strict";
import {
    isCloudflareHtmlBody,
    isRetryableLiveBenchFailure,
    liveBenchRetryDelayMs,
} from "../live-bench-retry.js";

const CF_HTML = `<!DOCTYPE html>
<!--[if lt IE 7]> <html class="no-js ie6 oldie" lang="en-US"> <![endif]-->
<html lang="en-US">
<head><title>Attention Required! | Cloudflare</title></head>
<body>cloudflare</body>
</html>`;

test("cloudflare HTML error pages are retryable regardless of status", () => {
    assert.equal(isCloudflareHtmlBody(CF_HTML), true);
    assert.equal(
        isRetryableLiveBenchFailure({ statusCode: 403, error: CF_HTML }),
        true,
    );
    assert.equal(
        isRetryableLiveBenchFailure({
            statusCode: 200,
            contentType: "text/html; charset=UTF-8",
            error: CF_HTML,
        }),
        true,
    );
});

test("gateway and rate-limit statuses are retryable", () => {
    assert.equal(isRetryableLiveBenchFailure({ statusCode: 429, error: "Too Many Requests" }), true);
    assert.equal(isRetryableLiveBenchFailure({ statusCode: 502, error: "Bad Gateway" }), true);
    assert.equal(isRetryableLiveBenchFailure({ statusCode: 503, error: "Unavailable" }), true);
    assert.equal(isRetryableLiveBenchFailure({ statusCode: 524, error: "timeout" }), true);
});

test("auth and contract 4xx JSON stay fatal", () => {
    assert.equal(
        isRetryableLiveBenchFailure({
            statusCode: 401,
            contentType: "application/json",
            error: '{"error":"unauthorized"}',
        }),
        false,
    );
    assert.equal(
        isRetryableLiveBenchFailure({
            statusCode: 403,
            contentType: "application/json",
            error: '{"error":"forbidden"}',
        }),
        false,
    );
    assert.equal(
        isRetryableLiveBenchFailure({
            statusCode: 400,
            contentType: "application/json",
            error: '{"error":"Text cannot be empty"}',
        }),
        false,
    );
});

test("network throws and HTML-as-JSON parse errors are retryable", () => {
    assert.equal(isRetryableLiveBenchFailure({ error: "fetch failed" }), true);
    assert.equal(
        isRetryableLiveBenchFailure({ error: "Unexpected token '<', \"<!DOCTYPE \"... is not valid JSON" }),
        true,
    );
});

test("retry backoff doubles from 400ms", () => {
    assert.equal(liveBenchRetryDelayMs(1), 400);
    assert.equal(liveBenchRetryDelayMs(2), 800);
    assert.equal(liveBenchRetryDelayMs(3), 1600);
});
