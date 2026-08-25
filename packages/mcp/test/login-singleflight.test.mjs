/**
 * Concurrent startOrReuseLoginFlow calls must share one listener/URL.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { resetInflightLogin, startOrReuseLoginFlow } from "../dist/login.js";

test("concurrent login flows reuse one URL", async (t) => {
    const home = mkdtempSync(join(tmpdir(), "memwal-test-"));
    const prevHome = process.env.HOME;
    const prevProfile = process.env.USERPROFILE;
    process.env.HOME = home;
    process.env.USERPROFILE = home;
    resetInflightLogin();

    t.after(() => {
        if (prevHome === undefined) delete process.env.HOME;
        else process.env.HOME = prevHome;
        if (prevProfile === undefined) delete process.env.USERPROFILE;
        else process.env.USERPROFILE = prevProfile;
        resetInflightLogin();
        rmSync(home, { recursive: true, force: true });
    });

    const opts = {
        openBrowser: false,
        timeoutMs: 1500,
        webUrl: "http://127.0.0.1:9",
        relayerUrl: "http://127.0.0.1:9",
        label: "singleflight-test",
    };
    const first = startOrReuseLoginFlow(opts);
    const second = startOrReuseLoginFlow(opts);
    const [urlA, urlB] = await Promise.all([first.url, second.url]);
    assert.equal(urlA, urlB);
    assert.match(urlA, /\/connect\/mcp\?/);
    await Promise.allSettled([first.result, second.result]);
});
