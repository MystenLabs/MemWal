import assert from "node:assert/strict";
import test from "node:test";

import { resolveTransport, streamableUrl } from "../dist/streamable.js";

/**
 * Transport selection and endpoint derivation only — the parts that hold
 * without a socket. The session itself needs a live relayer, so it is covered
 * by the live suite rather than here.
 */

test("the default transport stays SSE", () => {
    // Every released bridge dials SSE. Streamable HTTP is opt-in until it has
    // production mileage, so an unset variable must not move users onto it.
    assert.equal(resolveTransport(undefined), "sse");
    assert.equal(resolveTransport(""), "sse");
    assert.equal(resolveTransport("   "), "sse");
});

test("http is selected by any of its spellings", () => {
    for (const value of ["http", "streamable", "streamable-http"]) {
        assert.equal(resolveTransport(value), "http", value);
    }
});

test("selection ignores case and surrounding whitespace", () => {
    assert.equal(resolveTransport("  HTTP "), "http");
    assert.equal(resolveTransport("SSE"), "sse");
});

test("an unrecognised value falls back instead of throwing", () => {
    // A typo in a user's MCP config must not stop their memory from working.
    assert.equal(resolveTransport("htpp"), "sse");
    assert.equal(resolveTransport("websocket"), "sse");
});

test("the streamable endpoint sits on the same base as the SSE pair", () => {
    assert.equal(
        streamableUrl("https://relayer.memory.walrus.xyz"),
        "https://relayer.memory.walrus.xyz/api/mcp"
    );
});

test("a trailing slash on the relayer URL does not double up", () => {
    // Users paste URLs with and without it; a `//api/mcp` path 404s.
    assert.equal(streamableUrl("https://relayer.example/"), "https://relayer.example/api/mcp");
    assert.equal(streamableUrl("https://relayer.example///"), "https://relayer.example/api/mcp");
});

test("a relayer on a port or subpath keeps it", () => {
    assert.equal(streamableUrl("http://127.0.0.1:8000"), "http://127.0.0.1:8000/api/mcp");
    assert.equal(streamableUrl("https://host/base"), "https://host/base/api/mcp");
});
