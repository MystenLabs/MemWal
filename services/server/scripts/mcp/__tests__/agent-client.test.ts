import assert from "node:assert/strict";
import test from "node:test";

import type { MemWalSession } from "../auth.js";
import {
    applyAgentClient,
    clientInfoFromInitializeParams,
    identifyAgentClient,
    sanitizeClientToken,
} from "../agent-client.js";

test("identifyAgentClient maps known coding agents", () => {
    const cases: Array<[string, string]> = [
        ["claude-code", "claude-code"],
        ["Claude Code", "claude-code"],
        ["codex", "codex"],
        ["openai-codex", "codex"],
        ["Cursor", "cursor"],
        ["cursor-vscode", "cursor"],
        ["antigravity", "antigravity"],
        ["OpenCode", "opencode"],
        ["windsurf", "windsurf"],
        ["claude-desktop", "claude-desktop"],
        ["Claude", "claude-desktop"],
        ["claude.ai", "claude-desktop"],
        ["Visual Studio Code", "vscode-copilot"],
        ["ChatGPT", "chatgpt"],
        ["gemini-cli", "gemini"],
        ["Grok", "grok"],
        ["mystery-ide", "other"],
    ];
    for (const [raw, id] of cases) {
        assert.equal(identifyAgentClient(raw), id, raw);
    }
});

test("claude-code wins over a generic claude substring", () => {
    assert.equal(identifyAgentClient("claude-code-nightly"), "claude-code");
});

test("sanitizeClientToken strips control chars and caps length", () => {
    assert.equal(sanitizeClientToken("  claude-code\n "), "claude-code");
    assert.equal(sanitizeClientToken(""), null);
    assert.equal(sanitizeClientToken(1), null);
    assert.equal(sanitizeClientToken("x".repeat(80))?.length, 64);
});

test("clientInfoFromInitializeParams reads MCP initialize params", () => {
    assert.deepEqual(
        clientInfoFromInitializeParams({
            protocolVersion: "2025-06-18",
            clientInfo: { name: "claude-code", version: "1.2.3" },
        }),
        { name: "claude-code", version: "1.2.3" },
    );
    assert.equal(clientInfoFromInitializeParams({}), null);
    assert.equal(clientInfoFromInitializeParams(null), null);
    assert.equal(
        clientInfoFromInitializeParams({ clientInfo: { name: "\x00" } }),
        null,
    );
});

test("applyAgentClient stamps the session once and is idempotent", () => {
    const session = { accountId: "0xabc" } as MemWalSession;
    assert.equal(applyAgentClient(session, { name: "claude-code", version: "9" }), true);
    assert.equal(session.agentClient, "claude-code");
    assert.equal(session.clientName, "claude-code");
    assert.equal(session.clientVersion, "9");
    assert.equal(applyAgentClient(session, { name: "claude-code", version: "9" }), false);
});
