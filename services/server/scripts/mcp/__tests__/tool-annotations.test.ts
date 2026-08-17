import assert from "node:assert/strict";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { MemWalSession } from "../auth.js";
import { createMcpServer } from "../server.js";

test("tools/list publishes safe titles and behavior annotations for every remote tool", async (t) => {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const server = createMcpServer({} as MemWalSession);
    const client = new Client({ name: "annotations-test", version: "1.0.0" });

    t.after(async () => {
        await client.close();
        await server.close();
    });

    await server.connect(serverTransport);
    await client.connect(clientTransport);
    const { tools } = await client.listTools();

    assert.deepEqual(
        Object.fromEntries(
            tools.map(({ name, title, annotations }) => [name, { title, annotations }])
        ),
        {
            auto_save_user_facts_to_memory: {
                title: "Auto-save a User Fact",
                annotations: { readOnlyHint: false, destructiveHint: false },
            },
            memwal_remember: {
                title: "Remember a Fact (Deprecated)",
                annotations: { readOnlyHint: false, destructiveHint: false },
            },
            memwal_remember_bulk: {
                title: "Remember Multiple Facts",
                annotations: { readOnlyHint: false, destructiveHint: false },
            },
            memwal_analyze: {
                title: "Analyze and Remember",
                annotations: { readOnlyHint: false, destructiveHint: true },
            },
            memwal_restore: {
                title: "Restore Memory Index",
                annotations: { readOnlyHint: false, destructiveHint: false },
            },
            memwal_recall: {
                title: "Recall Memories",
                annotations: { readOnlyHint: false, destructiveHint: true },
            },
            memwal_health: {
                title: "Check Walrus Memory Health",
                annotations: { readOnlyHint: true, destructiveHint: false },
            },
        }
    );
});

test("deprecated memwal_remember alias preserves the single-fact call contract", async (t) => {
    const calls: Array<[string, string | undefined, { timeoutMs: number }]> = [];
    const rememberAndWait = async (
        text: string,
        namespace: string | undefined,
        options: { timeoutMs: number }
    ) => {
        calls.push([text, namespace, options]);
        return { blob_id: `blob-${calls.length}`, namespace: namespace ?? "default" };
    };
    const session = {
        memwal: { rememberAndWait },
    } as unknown as MemWalSession;
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const server = createMcpServer(session);
    const client = new Client({ name: "remember-alias-test", version: "1.0.0" });

    t.after(async () => {
        await client.close();
        await server.close();
    });

    await server.connect(serverTransport);
    await client.connect(clientTransport);
    await client.callTool({
        name: "auto_save_user_facts_to_memory",
        arguments: { text: "primary fact", namespace: "work" },
    });
    await client.callTool({
        name: "memwal_remember",
        arguments: { text: "legacy fact", namespace: "legacy" },
    });

    assert.deepEqual(calls, [
        ["primary fact", "work", { timeoutMs: 90_000 }],
        ["legacy fact", "legacy", { timeoutMs: 90_000 }],
    ]);
});
