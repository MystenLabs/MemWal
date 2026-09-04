import assert from "node:assert/strict";
import test from "node:test";

import type { MemWalSession } from "../auth.js";
import {
    AGENT_CLIENT_IDS,
    applyAgentClient,
    clientInfoFromInitializeParams,
    identifyAgentClient,
    sanitizeClientToken,
    type AgentClientId,
} from "../agent-client.js";

const IDENTIFY_CASES: Array<[string, AgentClientId]> = [
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

test("identifyAgentClient maps known coding agents", () => {
    for (const [raw, id] of IDENTIFY_CASES) {
        assert.equal(identifyAgentClient(raw), id, raw);
    }
});

test("every AgentClientId is produced by at least one fixture", () => {
    const seen = new Set(IDENTIFY_CASES.map(([, id]) => id));
    for (const id of AGENT_CLIENT_IDS) {
        assert.ok(seen.has(id), id);
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

test("applyAgentClient fills in version after a header stamp without one", () => {
    const session = { accountId: "0xabc" } as MemWalSession;
    assert.equal(applyAgentClient(session, { name: "claude-code" }), true);
    assert.equal(session.clientVersion, undefined);
    assert.equal(
        applyAgentClient(session, { name: "claude-code", version: "2.0.1" }),
        true,
    );
    assert.equal(session.clientVersion, "2.0.1");
    assert.equal(
        applyAgentClient(session, { name: "claude-code", version: "2.0.1" }),
        false,
    );
});

test("applyAgentClient does not wipe a known version when a later call omits it", () => {
    const session = { accountId: "0xabc" } as MemWalSession;
    assert.equal(applyAgentClient(session, { name: "claude-code", version: "9" }), true);
    assert.equal(applyAgentClient(session, { name: "claude-code" }), false);
    assert.equal(session.clientVersion, "9");
});
