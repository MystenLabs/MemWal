process.env.MEMWAL_MCP_REMEMBER_WAIT_MS = "0";

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test, { type TestContext } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { MemWalSession } from "../auth.js";

const { createMcpServer } = await import("../server.js");
const { derivedIdempotencyKey } = await import("../tools/remember-wait.js");

interface RememberCall {
    text: string;
    namespace?: string;
    idempotencyKey: string;
}

function sessionWithCalls(
    calls: RememberCall[],
    sessionNamespace?: string,
): MemWalSession {
    return {
        oauthScope: "memwal:read memwal:write",
        namespace: sessionNamespace,
        memwal: {
            async rememberAsync(
                text: string,
                namespace?: string,
                opts?: { idempotencyKey?: string },
            ) {
                calls.push({
                    text,
                    namespace,
                    idempotencyKey: opts?.idempotencyKey ?? "",
                });
                return { job_id: "job-1", status: "running" };
            },
        },
    } as unknown as MemWalSession;
}

async function clientFor(session: MemWalSession, t: TestContext): Promise<Client> {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const server = createMcpServer(session);
    const client = new Client({ name: "remember-idempotency-test", version: "1.0.0" });
    t.after(async () => {
        await client.close();
        await server.close();
    });
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    return client;
}

test("derivedIdempotencyKey defaults undefined or empty namespace to 'default'", () => {
    const fact = "the user prefers pour-over coffee";
    const keyUndefined = derivedIdempotencyKey(undefined, fact);
    const keyEmpty = derivedIdempotencyKey("", fact);
    const keyDefault = derivedIdempotencyKey("default", fact);

    assert.equal(keyUndefined, keyDefault, "omitted namespace must match explicit default");
    assert.equal(keyEmpty, keyDefault, "empty namespace must match explicit default");

    // Must match the SDK format: r1-<sha256(bucket\0resolvedNamespace\0text)>
    const bucket = Math.floor(Date.now() / (30 * 60 * 1000));
    const expectedDigest = createHash("sha256")
        .update(`${bucket}\0default\0${fact}`)
        .digest("hex");
    assert.equal(keyDefault, `r1-${expectedDigest}`);
});

test("memwal_remember with omitted namespace sends idempotency key scoped to 'default' (GH #1093, WALM-831)", async (t) => {
    const calls: RememberCall[] = [];
    const client = await clientFor(sessionWithCalls(calls), t);
    const fact = "user prefers tabs over spaces";

    await client.callTool({
        name: "memwal_remember",
        arguments: { text: fact },
    });

    await client.callTool({
        name: "memwal_remember",
        arguments: { text: fact, namespace: "default" },
    });

    assert.equal(calls.length, 2);
    // When omitted, tool passes undefined as namespace argument to SDK rememberAsync
    assert.equal(calls[0].namespace, undefined);
    assert.equal(calls[1].namespace, "default");

    // But both must have derived the exact same idempotencyKey under 'default'
    assert.equal(calls[0].idempotencyKey, calls[1].idempotencyKey);
    assert.equal(calls[0].idempotencyKey, derivedIdempotencyKey("default", fact));
});

test("memwal_remember with omitted namespace respects session.namespace if configured", async (t) => {
    const calls: RememberCall[] = [];
    const client = await clientFor(sessionWithCalls(calls, "project-team-a"), t);
    const fact = "repo build uses rust edition 2024";

    await client.callTool({
        name: "memwal_remember",
        arguments: { text: fact },
    });

    assert.equal(calls.length, 1);
    assert.equal(calls[0].idempotencyKey, derivedIdempotencyKey("project-team-a", fact));
});

test("memwal_remember with explicit namespace uses that namespace for idempotency key", async (t) => {
    const calls: RememberCall[] = [];
    const client = await clientFor(sessionWithCalls(calls, "default"), t);
    const fact = "server runs on port 8080";

    await client.callTool({
        name: "memwal_remember",
        arguments: { text: fact, namespace: "custom-zone" },
    });

    assert.equal(calls.length, 1);
    assert.equal(calls[0].namespace, "custom-zone");
    assert.equal(calls[0].idempotencyKey, derivedIdempotencyKey("custom-zone", fact));
});
