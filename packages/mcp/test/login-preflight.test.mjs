import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("login requires a matching localhost preflight before browser approval", async () => {
    const home = mkdtempSync(join(tmpdir(), "memwal-preflight-"));
    const previousHome = process.env.HOME;
    process.env.HOME = home;

    const webUrl = "https://memory.example";
    const relayerUrl = "https://relayer.example";
    const { loginFlow } = await import(`../dist/login.js?test=${Date.now()}`);
    let publishUrl;
    const urlReady = new Promise((resolve) => {
        publishUrl = resolve;
    });
    const login = loginFlow({
        webUrl,
        relayerUrl,
        label: "Test MCP",
        timeoutMs: 15_000,
        openBrowser: false,
        onUrl: publishUrl,
    });

    let callbackUrl;
    let state;
    let callbackCompleted = false;
    try {
        const connectUrl = new URL(await urlReady);
        const port = connectUrl.searchParams.get("port");
        const publicKey = connectUrl.searchParams.get("publicKey");
        state = connectUrl.searchParams.get("connectState");
        assert.match(port ?? "", /^\d+$/);
        assert.match(publicKey ?? "", /^[0-9a-f]{64}$/);
        assert.match(state ?? "", /^[0-9a-f]{64}$/);
        callbackUrl = `http://127.0.0.1:${port}/callback`;
        const preflightUrl = `http://127.0.0.1:${port}/preflight`;

        const post = (url, body, origin = webUrl) =>
            fetch(url, {
                method: "POST",
                headers: { "content-type": "application/json", origin },
                body: JSON.stringify(body),
            });

        const validCallback = {
            state,
            accountId: `0x${"1".repeat(64)}`,
            walletAddress: `0x${"2".repeat(64)}`,
            packageId: `0x${"3".repeat(64)}`,
            label: "Tampered callback label",
        };

        const callbackBeforePreflight = await post(callbackUrl, validCallback);
        assert.equal(callbackBeforePreflight.status, 428);
        assert.equal(existsSync(join(home, ".memwal", "credentials.json")), false);

        const badOrigin = await post(preflightUrl, { state, publicKey, relayer: relayerUrl }, "https://evil.example");
        assert.equal(badOrigin.status, 403);

        const badState = await post(preflightUrl, {
            state: "0".repeat(64),
            publicKey,
            relayer: relayerUrl,
        });
        assert.equal(badState.status, 403);

        const badKey = await post(preflightUrl, {
            state,
            publicKey: "f".repeat(64),
            relayer: relayerUrl,
        });
        assert.equal(badKey.status, 403);

        const verified = await post(preflightUrl, { state, publicKey, relayer: relayerUrl });
        assert.equal(verified.status, 200);
        assert.deepEqual(await verified.json(), {
            ok: true,
            publicKey,
            label: "Test MCP",
            relayer: relayerUrl,
        });

        const callback = await post(callbackUrl, validCallback);
        assert.equal(callback.status, 200);
        callbackCompleted = true;
        await login;
        const credentialsPath = join(home, ".memwal", "credentials.json");
        assert.equal(existsSync(credentialsPath), true);
        assert.equal(JSON.parse(readFileSync(credentialsPath, "utf8")).label, "Test MCP");
    } finally {
        if (!callbackCompleted && callbackUrl && state) {
            await fetch(callbackUrl, {
                method: "POST",
                headers: { "content-type": "application/json", origin: webUrl },
                body: JSON.stringify({
                    state,
                    accountId: `0x${"1".repeat(64)}`,
                    walletAddress: `0x${"2".repeat(64)}`,
                    packageId: `0x${"3".repeat(64)}`,
                }),
            }).catch(() => undefined);
        }
        await login.catch(() => undefined);
        if (previousHome === undefined) delete process.env.HOME;
        else process.env.HOME = previousHome;
        rmSync(home, { recursive: true, force: true });
    }
});
