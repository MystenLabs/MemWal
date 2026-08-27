import assert from "node:assert/strict";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { MemWalSession } from "../auth.js";
import { createMcpServer } from "../server.js";

test("MCP initialize stamps the coding-agent id on the session", async (t) => {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const session = {
        accountId: "0xabc",
        oauthScope: "memwal:read memwal:write",
    } as MemWalSession;
    const server = createMcpServer(session);
    const client = new Client({ name: "claude-code", version: "9.9.9" });

    t.after(async () => {
        await client.close();
        await server.close();
    });

    await server.connect(serverTransport);
    await client.connect(clientTransport);

    assert.equal(session.agentClient, "claude-code");
    assert.equal(session.clientName, "claude-code");
    assert.equal(session.clientVersion, "9.9.9");
});
