/**
 * Guards the `instructions` channel on the relayer's initialize handshake.
 *
 * Desktop MCP clients and Codex lazily load tool schemas, so anything we say
 * inside a tool description is invisible until that tool is already loaded.
 * The proactive save/recall contract therefore has to ride on the MCP
 * `instructions` field, which is delivered with `initialize` and lands in the
 * model's system prompt before any tools/list (WALM-324).
 *
 * That field is easy to drop silently: it is an optional argument to the
 * McpServer constructor, and omitting it fails no type check and breaks no
 * other test. These assertions exist so a regression is loud.
 *
 * Same harness shape as integration.test.ts: real routes on an ephemeral
 * loopback port, no external services, tools never invoked because only the
 * initialize handshake is driven.
 *
 * IMPORTANT: env vars MUST be set BEFORE importing `mountMcpRoutes` because
 * the rate limiter is constructed at module-load time.
 */
process.env.SIDECAR_AUTH_TOKEN ??= "instructions-test-sidecar-token";
process.env.MCP_MAX_TOTAL_SESSIONS = "100";
process.env.MCP_MAX_SESSIONS_PER_IP = "100";
process.env.MCP_MAX_NEW_SESSIONS_PER_IP_PER_MIN = "100";

import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import express from "express";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { createRequire } from "node:module";

import { mountMcpRoutes } from "../index.js";

const requirePkg = createRequire(import.meta.url);
const PACKAGE_VERSION = (requirePkg("../../package.json") as { version: string }).version;

let server: Server;
let baseUrl: string;

before(async () => {
    const app = express();
    app.get("/version", (_req, res) => {
        res.json({
            apiVersion: "1.0.0",
            relayerVersion: "1.0.0",
            minSupportedSdk: { mcp: "0.0.1" },
        });
    });
    mountMcpRoutes(app, { relayerUrl: "http://localhost:1" });
    await new Promise<void>((resolve) => {
        server = app.listen(0, "127.0.0.1", () => resolve());
    });
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
});

/** The streamable HTTP endpoint answers either bare JSON or an SSE frame
 * depending on negotiation; accept both so this test guards the payload, not
 * the transport encoding. */
function parseRpc(bodyText: string): Record<string, any> {
    const trimmed = bodyText.trim();
    if (trimmed.startsWith("{")) return JSON.parse(trimmed);
    const dataLine = trimmed
        .split("\n")
        .map((l) => l.trim())
        .find((l) => l.startsWith("data:"));
    assert(dataLine, `no JSON or SSE data frame in response: ${bodyText.slice(0, 200)}`);
    return JSON.parse(dataLine.slice("data:".length).trim());
}

async function initialize(): Promise<Record<string, any>> {
    const res = await fetch(`${baseUrl}/mcp`, {
        method: "POST",
        headers: {
            "content-type": "application/json",
            accept: "application/json, text/event-stream",
            authorization: `Bearer ${randomBytes(32).toString("hex")}`,
            "x-memwal-account-id": "0x" + randomBytes(32).toString("hex"),
            "x-forwarded-for": "203.0.113.7",
            // Stands in for the relayer, which proves its origin with the
            // sidecar shared secret before any internal header is honoured.
            "x-memwal-internal-sidecar-token": process.env.SIDECAR_AUTH_TOKEN!,
        },
        body: JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            method: "initialize",
            params: {
                protocolVersion: "2025-06-18",
                capabilities: {},
                clientInfo: { name: "memwal-test", version: "0.0.1" },
            },
        }),
    });
    assert.equal(res.status, 200);
    return parseRpc(await res.text());
}

test("initialize carries non-empty instructions", async () => {
    const { result } = await initialize();
    assert.equal(typeof result?.instructions, "string");
    assert(
        result.instructions.trim().length > 0,
        "instructions must not be empty — it is the only proactive-usage channel that survives lazy tool loading",
    );
});

test("instructions cover recall, remember, and the not-loaded fallback", async () => {
    const { result } = await initialize();
    const text: string = result.instructions;

    // Named tools, so the model can act without first loading a schema.
    assert.match(text, /memwal_recall/);
    assert.match(text, /memwal_remember/);

    // The reported symptom was the model claiming memory was unavailable
    // rather than loading the deferred tool. Keep that rebuttal in the text.
    assert.match(text, /not currently loaded/i);
    assert.match(text, /never tell the user that\s+memory is unavailable/i);

    assert.match(text, /never ask the user\s+for permission/i);
    assert.match(text, /Anthropic Memory/);
    assert.match(text, /built-in memory/i);
    assert.match(text, /passwords/);
    assert.match(text, /API keys/);
    assert.match(text, /Seal-encrypted on Walrus/);
    assert.match(text, /memory\.walrus\.xyz/);
    assert.doesNotMatch(text, /everything is encrypted/i);
});

test("serverInfo reports the real package version, not a hardcoded stub", async () => {
    const { result } = await initialize();
    assert.equal(result?.serverInfo?.name, "memwal");
    assert.equal(
        result.serverInfo.version,
        PACKAGE_VERSION,
        "serverInfo.version must track package.json so handshake logs identify the running build",
    );
});
