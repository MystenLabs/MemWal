import { test } from "node:test";
import assert from "node:assert/strict";
import {
    CLIENT_NAME_HEADER,
    CLIENT_VERSION_HEADER,
    clientInfoFromInitializeParams,
    clientInfoHeaders,
    lastClientInfoHeaders,
    rememberInitializeClientInfo,
    sanitizeClientToken,
} from "../dist/client-info.js";

test("clientInfoFromInitializeParams reads name and version", () => {
    assert.deepEqual(
        clientInfoFromInitializeParams({
            protocolVersion: "2025-06-18",
            clientInfo: { name: "claude-code", version: "2.0.0" },
        }),
        { name: "claude-code", version: "2.0.0" },
    );
});

test("sanitizeClientToken strips CR/LF and non-ascii", () => {
    assert.equal(sanitizeClientToken("claude-code\r\nHost: evil"), "claude-codeHost: evil"); // newlines stripped, not interpreted as a new header
    assert.equal(sanitizeClientToken(""), null);
    assert.equal(sanitizeClientToken("x".repeat(80)).length, 64);
});

test("rememberInitializeClientInfo seeds lastClientInfoHeaders for handoff", () => {
    rememberInitializeClientInfo({
        clientInfo: { name: "codex", version: "0.1" },
    });
    assert.deepEqual(lastClientInfoHeaders(), {
        [CLIENT_NAME_HEADER]: "codex",
        [CLIENT_VERSION_HEADER]: "0.1",
    });
    assert.deepEqual(clientInfoHeaders({ name: "Cursor", version: null }), {
        [CLIENT_NAME_HEADER]: "Cursor",
    });
});
