import assert from "node:assert/strict";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { MemWalSession } from "../auth.js";
import {
    createMcpServer,
    shouldRegisterProactiveMemoryPrompt,
} from "../server.js";

test("registers proactive prompt only when both memory scopes are available", () => {
    assert.equal(shouldRegisterProactiveMemoryPrompt(undefined), true);
    assert.equal(shouldRegisterProactiveMemoryPrompt("memwal:read memwal:write"), true);
    assert.equal(shouldRegisterProactiveMemoryPrompt("memwal:write memwal:read"), true);
    assert.equal(shouldRegisterProactiveMemoryPrompt("memwal:read"), false);
    assert.equal(shouldRegisterProactiveMemoryPrompt("memwal:write"), false);
    assert.equal(shouldRegisterProactiveMemoryPrompt(""), false);
});

test("publishes proactive Walrus Memory instructions as an MCP prompt", async (t) => {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const server = createMcpServer({} as MemWalSession);
    const client = new Client({ name: "prompt-test", version: "1.0.0" });

    t.after(async () => {
        await client.close();
        await server.close();
    });

    await server.connect(serverTransport);
    await client.connect(clientTransport);

    const { prompts } = await client.listPrompts();
    assert.deepEqual(prompts, [
        {
            name: "proactive_walrus_memory",
            title: "Use Walrus Memory Proactively",
            description:
                "Make Walrus Memory the primary memory for this conversation, with proactive recall and durable-fact saving.",
            arguments: undefined,
        },
    ]);

    const result = await client.getPrompt({ name: "proactive_walrus_memory" });
    assert.equal(result.messages.length, 1);
    const content = result.messages[0]?.content;
    assert.equal(content?.type, "text");
    if (content?.type !== "text") assert.fail("expected text prompt content");
    assert.match(content.text, /auto_save_user_facts_to_memory/);
    assert.match(content.text, /memwal_recall/);
    assert.match(content.text, /Do not save passwords, private keys, access tokens/);
});
