import assert from "node:assert/strict";
import test from "node:test";

import { MemWal } from "../dist/memwal.js";
import { MemWalManual } from "../dist/manual.js";

const originalFetch = globalThis.fetch;

test.afterEach(() => {
    globalThis.fetch = originalFetch;
});

function client() {
    return MemWal.create({
        key: "11".repeat(32),
        accountId: "0x1",
        serverUrl: "https://relayer.example",
    });
}

function versionBody() {
    return Response.json({
        apiVersion: "1.0.0",
        relayerVersion: "1.0.0",
        minSupportedSdk: { typescript: "0.0.4" },
    });
}

test("health() rejects an empty 200 instead of throwing SyntaxError", async () => {
    globalThis.fetch = async () => new Response("", { status: 200 });
    await assert.rejects(
        () => client().health(),
        (err) => err instanceof Error
            && !(err instanceof SyntaxError)
            && /empty body/.test(err.message),
    );
});

test("health() rejects a non-JSON 200", async () => {
    globalThis.fetch = async () => new Response("nope", { status: 200, headers: { "content-type": "text/plain" } });
    await assert.rejects(
        () => client().health(),
        /response was not JSON/,
    );
});

test("remember() rejects an empty 202 instead of throwing SyntaxError", async () => {
    const memwal = client();
    memwal.buildSealSession = async () => "test-session";
    globalThis.fetch = async (url) => {
        const path = new URL(url).pathname;
        if (path === "/version") return versionBody();
        if (path === "/api/remember") return new Response("", { status: 202 });
        throw new Error(`unexpected ${path}`);
    };
    await assert.rejects(
        () => memwal.remember("hello"),
        (err) => err instanceof Error
            && !(err instanceof SyntaxError)
            && /empty body/.test(err.message)
            && err.status === 202,
    );
});

test("rememberAndWait does not poll until timeout on an empty 202", async () => {
    const memwal = client();
    memwal.buildSealSession = async () => "test-session";
    let polls = 0;
    globalThis.fetch = async (url) => {
        const path = new URL(url).pathname;
        if (path === "/version") return versionBody();
        if (path === "/api/remember") return new Response("", { status: 202 });
        polls += 1;
        return new Response("", { status: 202 });
    };
    await assert.rejects(
        () => memwal.rememberAndWait("hello", { timeoutMs: 5_000 }),
        (err) => err instanceof Error && /empty body/.test(err.message) && err.status === 202,
    );
    assert.equal(polls, 0);
});

function manual() {
    return MemWalManual.create({
        key: "11".repeat(32),
        accountId: "0x1",
        serverUrl: "https://relayer.example",
        walletSigner: {},
    });
}

test("MemWalManual.restore rejects an empty 200 instead of throwing SyntaxError", async () => {
    const c = manual();
    c.buildSealSession = async () => "test-session";
    globalThis.fetch = async (url) => {
        const path = new URL(url).pathname;
        if (path === "/version") return versionBody();
        if (path === "/api/restore") return new Response("", { status: 200 });
        throw new Error(`unexpected ${path}`);
    };
    await assert.rejects(
        () => c.restore("default"),
        (err) => err instanceof Error && !(err instanceof SyntaxError) && /empty body/.test(err.message),
    );
});

test("MemWalManual.compatibility rejects a non-JSON 200", async () => {
    globalThis.fetch = async () => new Response("nope", { status: 200 });
    await assert.rejects(() => manual().compatibility(), /response was not JSON/);
});
