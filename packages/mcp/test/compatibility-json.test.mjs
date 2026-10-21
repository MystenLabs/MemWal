import assert from "node:assert/strict";
import test from "node:test";

import { ensureCompatibleRelayer } from "../dist/compatibility.js";

const originalFetch = globalThis.fetch;

test.afterEach(() => {
    globalThis.fetch = originalFetch;
});

test("ensureCompatibleRelayer rejects an empty or non-JSON /version", async () => {
    globalThis.fetch = async () => new Response("", { status: 200 });
    await assert.rejects(
        () => ensureCompatibleRelayer("https://empty.example"),
        (err) => err instanceof Error && !(err instanceof SyntaxError) && /empty body/.test(err.message),
    );

    globalThis.fetch = async () => new Response("nope", { status: 200 });
    await assert.rejects(
        () => ensureCompatibleRelayer("https://text.example"),
        /response was not JSON/,
    );
});
