/**
 * stdio MCP server talks to a MemWal stub — no SSE mock.
 *
 * Covers remember/recall on the JSON-RPC loop, mid-session login pickup,
 * and logout dropping the in-process client (GH #616).
 */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";

import { SIGNED_OUT_TEXT } from "../dist/format.js";
import { resetServerState, runStdioServer } from "../dist/server.js";
import { dropClient, setClientFactory } from "../dist/session.js";

function makeCreds(relayerUrl) {
    return {
        delegatePrivateKey: "a".repeat(64),
        delegatePublicKeyHex: "b".repeat(64),
        delegateAddress: "0x" + "1".repeat(64),
        walletAddress: "0x" + "2".repeat(64),
        accountId: "0x" + "3".repeat(64),
        packageId: "0x" + "4".repeat(64),
        relayerUrl,
        label: "Test",
        createdAt: new Date(0).toISOString(),
        version: 1,
    };
}

function startSession({ credsDir, createClient, namespace, relayerOverride } = {}) {
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    stdout.setEncoding("utf8");
    let buf = "";
    const received = [];
    const pending = [];
    stdout.on("data", (chunk) => {
        buf += chunk;
        let nl;
        while ((nl = buf.indexOf("\n")) >= 0) {
            const line = buf.slice(0, nl);
            buf = buf.slice(nl + 1);
            if (!line.trim()) continue;
            let msg;
            try {
                msg = JSON.parse(line);
            } catch {
                continue;
            }
            received.push(msg);
            const waiter = pending.find((w) => w.match(msg));
            if (waiter) {
                pending.splice(pending.indexOf(waiter), 1);
                waiter.resolve(msg);
            }
        }
    });

    const waitFor = (match, timeoutMs = 5_000) => {
        const hit = received.find(match);
        if (hit) return Promise.resolve(hit);
        return new Promise((resolve, reject) => {
            const timer = setTimeout(
                () => reject(new Error("timed out waiting for MCP message")),
                timeoutMs,
            );
            pending.push({
                match,
                resolve: (msg) => {
                    clearTimeout(timer);
                    resolve(msg);
                },
            });
        });
    };

    const send = (msg) => stdin.write(JSON.stringify(msg) + "\n");

    resetServerState();
    dropClient();
    if (createClient) setClientFactory(createClient);
    else setClientFactory(undefined);

    const envCreds = process.env.MEMWAL_CREDS_DIR;
    if (credsDir) process.env.MEMWAL_CREDS_DIR = credsDir;

    const done = runStdioServer(
        {
            relayerUrl: "http://127.0.0.1:9",
            webUrl: "http://127.0.0.1:9",
            label: "Test",
            namespace,
            relayerOverride,
        },
        { stdin, stdout },
    );

    return {
        send,
        waitFor,
        waitId: (id) => waitFor((m) => m.id === id),
        close: async () => {
            stdin.end();
            await done;
            setClientFactory(undefined);
            dropClient();
            resetServerState();
            if (credsDir) {
                if (envCreds === undefined) delete process.env.MEMWAL_CREDS_DIR;
                else process.env.MEMWAL_CREDS_DIR = envCreds;
            }
        },
    };
}

function stubClient() {
    const calls = [];
    return {
        calls,
        rememberAndWait: async (text, namespace) => {
            calls.push(["rememberAndWait", text, namespace]);
            return { blob_id: "blob-1", namespace: namespace ?? "default" };
        },
        rememberBulkAndWait: async () => {
            throw new Error("not used");
        },
        recall: async (params) => {
            calls.push(["recall", params]);
            return { results: [{ text: "montreal trip", distance: 0.2 }] };
        },
        analyzeAndWait: async () => {
            throw new Error("not used");
        },
        restore: async () => {
            throw new Error("not used");
        },
        health: async () => ({ status: "ok", version: "1.2.3" }),
        destroy() {
            calls.push(["destroy"]);
        },
    };
}

test.describe("stdio SDK server", { concurrency: 1 }, () => {
test("remember and recall run through the SDK stub with no SSE", async () => {
    const dir = mkdtempSync(join(tmpdir(), "memwal-sdk-stdio-"));
    writeFileSync(join(dir, "credentials.json"), JSON.stringify(makeCreds("http://relayer.test")));
    const stub = stubClient();
    const session = startSession({
        credsDir: dir,
        createClient: () => stub,
        namespace: "work",
    });
    try {
        session.send({
            jsonrpc: "2.0",
            id: 1,
            method: "initialize",
            params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test" } },
        });
        const init = await session.waitId(1);
        assert.match(init.result.instructions, /RECALL: before answering/);

        session.send({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
        const listed = await session.waitId(2);
        const names = listed.result.tools.map((t) => t.name);
        assert.ok(names.includes("memwal_remember"));
        assert.ok(names.includes("memwal_logout"));

        session.send({
            jsonrpc: "2.0",
            id: 3,
            method: "tools/call",
            params: { name: "memwal_remember", arguments: { text: "I use pnpm" } },
        });
        const remembered = await session.waitId(3);
        assert.equal(remembered.result.isError, false);
        assert.match(remembered.result.content[0].text, /blob_id=blob-1/);
        assert.deepEqual(stub.calls[0], ["rememberAndWait", "I use pnpm", "work"]);

        session.send({
            jsonrpc: "2.0",
            id: 4,
            method: "tools/call",
            params: { name: "memwal_recall", arguments: { query: "package manager" } },
        });
        const recalled = await session.waitId(4);
        assert.equal(recalled.result.isError, false);
        assert.match(recalled.result.content[0].text, /montreal trip/);
        assert.equal(stub.calls[1][0], "recall");
    } finally {
        await session.close();
        rmSync(dir, { recursive: true, force: true });
    }
});

test("writing credentials mid-session lets the next recall hit the SDK without restart", async () => {
    const dir = mkdtempSync(join(tmpdir(), "memwal-sdk-handoff-"));
    const stub = stubClient();
    const session = startSession({
        credsDir: dir,
        createClient: () => stub,
    });
    try {
        session.send({
            jsonrpc: "2.0",
            id: 1,
            method: "initialize",
            params: { protocolVersion: "2024-11-05", capabilities: {} },
        });
        await session.waitId(1);

        session.send({
            jsonrpc: "2.0",
            id: 2,
            method: "tools/call",
            params: { name: "memwal_recall", arguments: { query: "trip" } },
        });
        const denied = await session.waitId(2);
        assert.equal(denied.result.isError, true);
        assert.match(denied.result.content[0].text, /isn't signed in/);
        assert.equal(stub.calls.length, 0);

        writeFileSync(join(dir, "credentials.json"), JSON.stringify(makeCreds("http://relayer.test")));

        session.send({
            jsonrpc: "2.0",
            id: 3,
            method: "tools/call",
            params: { name: "memwal_recall", arguments: { query: "trip" } },
        });
        const ok = await session.waitId(3);
        assert.equal(ok.result.isError, false);
        assert.match(ok.result.content[0].text, /montreal trip/);
        assert.equal(stub.calls[0][0], "recall");
    } finally {
        await session.close();
        rmSync(dir, { recursive: true, force: true });
    }
});

test("logout drops the in-process client so a later recall never reaches the SDK", async () => {
    const dir = mkdtempSync(join(tmpdir(), "memwal-sdk-logout-"));
    writeFileSync(join(dir, "credentials.json"), JSON.stringify(makeCreds("http://relayer.test")));
    const stub = stubClient();
    const session = startSession({
        credsDir: dir,
        createClient: () => stub,
    });
    try {
        session.send({
            jsonrpc: "2.0",
            id: 1,
            method: "initialize",
            params: { protocolVersion: "2024-11-05", capabilities: {} },
        });
        await session.waitId(1);

        session.send({
            jsonrpc: "2.0",
            id: 2,
            method: "tools/call",
            params: { name: "memwal_recall", arguments: { query: "trip" } },
        });
        const before = await session.waitId(2);
        assert.equal(before.result.isError, false);
        assert.equal(stub.calls.filter((c) => c[0] === "recall").length, 1);

        session.send({
            jsonrpc: "2.0",
            id: 3,
            method: "tools/call",
            params: { name: "memwal_logout", arguments: {} },
        });
        const loggedOut = await session.waitId(3);
        assert.equal(loggedOut.result.isError, false);
        assert.match(loggedOut.result.content[0].text, /Signed out/);
        assert.ok(stub.calls.some((c) => c[0] === "destroy"));

        session.send({
            jsonrpc: "2.0",
            id: 4,
            method: "tools/call",
            params: { name: "memwal_recall", arguments: { query: "trip" } },
        });
        const after = await session.waitId(4);
        assert.equal(after.result.isError, true);
        assert.equal(after.result.content[0].text, SIGNED_OUT_TEXT);
        assert.equal(stub.calls.filter((c) => c[0] === "recall").length, 1);
    } finally {
        await session.close();
        rmSync(dir, { recursive: true, force: true });
    }
});

test("--relayer override is used for this process and not written to the file", async () => {
    const dir = mkdtempSync(join(tmpdir(), "memwal-sdk-override-"));
    const saved = "https://relayer.memory.walrus.xyz";
    const override = "http://127.0.0.1:8000";
    writeFileSync(join(dir, "credentials.json"), JSON.stringify(makeCreds(saved)));
    const seen = [];
    const stub = stubClient();
    const session = startSession({
        credsDir: dir,
        relayerOverride: override,
        createClient: (creds) => {
            seen.push(creds.relayerUrl);
            return stub;
        },
    });
    try {
        session.send({
            jsonrpc: "2.0",
            id: 1,
            method: "initialize",
            params: { protocolVersion: "2024-11-05", capabilities: {} },
        });
        await session.waitId(1);
        session.send({
            jsonrpc: "2.0",
            id: 2,
            method: "tools/call",
            params: { name: "memwal_health", arguments: {} },
        });
        const health = await session.waitId(2);
        assert.equal(health.result.isError, false);
        assert.deepEqual(seen, [override]);
        assert.match(health.result.content[0].text, new RegExp(`relayer=${override}`));
        const onDisk = JSON.parse(readFileSync(join(dir, "credentials.json"), "utf8"));
        assert.equal(onDisk.relayerUrl, saved);
    } finally {
        await session.close();
        rmSync(dir, { recursive: true, force: true });
    }
});
});
