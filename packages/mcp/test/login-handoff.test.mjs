/**
 * Signed-out discovery + mid-session credential pickup without a client restart.
 * Memory-tool success after pickup is covered by sdk-stdio.test.mjs (SDK stub).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const BIN = resolve(__dirname, "../dist/bin/memwal-mcp.js");

test("auth-required tools/list exposes safety metadata and recall is denied", async (t) => {
    const home = mkdtempSync(join(tmpdir(), "memwal-test-"));

    const child = spawn(process.execPath, [BIN, "--relayer", "http://127.0.0.1:9", "--web-url", "http://127.0.0.1:9"], {
        env: { ...process.env, HOME: home, USERPROFILE: home, MEMWAL_CREDS_DIR: home },
        stdio: ["pipe", "pipe", "pipe"],
    });

    const received = [];
    const listeners = new Set();
    let buf = "";
    child.stdout.on("data", (d) => {
        buf += d.toString();
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
            for (const l of [...listeners]) l(msg);
        }
    });

    const send = (obj) => child.stdin.write(JSON.stringify(obj) + "\n");
    const waitFor = (pred, ms = 15000) => {
        const hit = received.find(pred);
        if (hit) return Promise.resolve(hit);
        return new Promise((res, rej) => {
            const timer = setTimeout(() => {
                listeners.delete(l);
                rej(new Error("timed out waiting for message"));
            }, ms);
            const l = (m) => {
                if (pred(m)) {
                    clearTimeout(timer);
                    listeners.delete(l);
                    res(m);
                }
            };
            listeners.add(l);
        });
    };

    t.after(() => {
        child.kill("SIGKILL");
        rmSync(home, { recursive: true, force: true });
    });

    send({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
    const init = await waitFor((m) => m.id === 1 && m.result);
    assert.equal(init.result.serverInfo.name, "memwal");

    send({ jsonrpc: "2.0", id: 10, method: "tools/list", params: {} });
    const listed = await waitFor((m) => m.id === 10 && m.result);
    const metadata = Object.fromEntries(
        listed.result.tools.map(({ name, title, annotations }) => [name, { title, annotations }]),
    );
    assert.deepEqual(metadata, {
        memwal_remember: {
            title: "Remember a Fact",
            annotations: { readOnlyHint: false, destructiveHint: false },
        },
        memwal_remember_bulk: {
            title: "Remember Multiple Facts",
            annotations: { readOnlyHint: false, destructiveHint: false },
        },
        memwal_recall: {
            title: "Recall Memories",
            annotations: { readOnlyHint: true, destructiveHint: false },
        },
        memwal_analyze: {
            title: "Analyze and Remember",
            annotations: { readOnlyHint: false, destructiveHint: true },
        },
        memwal_restore: {
            title: "Restore Memory Index",
            annotations: { readOnlyHint: false, destructiveHint: false },
        },
        memwal_health: {
            title: "Check Walrus Memory Health",
            annotations: { readOnlyHint: true, destructiveHint: false },
        },
        memwal_login: {
            title: "Sign In to Walrus Memory",
            annotations: { readOnlyHint: false, destructiveHint: false },
        },
    });

    send({
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: { name: "memwal_recall", arguments: { query: "montreal" } },
    });
    const before = await waitFor((m) => m.id === 2);
    assert.equal(before.result.isError, true, "should be an error before login");
    assert.match(
        JSON.stringify(before.result),
        /isn't signed in|not signed in/i,
        "should nudge the user to log in",
    );
});
