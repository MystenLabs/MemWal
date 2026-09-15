/**
 * Credentialed cold start must answer initialize locally without waiting on
 * any relayer — there is no SSE handshake to block the MCP client timeout.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const BIN = resolve(__dirname, "../dist/bin/memwal-mcp.js");

const SIGNED_IN_TOOLS = [
    "memwal_remember",
    "memwal_remember_bulk",
    "memwal_recall",
    "memwal_analyze",
    "memwal_restore",
    "memwal_health",
    "memwal_login",
    "memwal_logout",
];

function makeCreds() {
    return {
        delegatePrivateKey: "a".repeat(64),
        delegatePublicKeyHex: "b".repeat(64),
        delegateAddress: "0x" + "1".repeat(64),
        walletAddress: "0x" + "2".repeat(64),
        accountId: "0x" + "3".repeat(64),
        packageId: "0x" + "4".repeat(64),
        relayerUrl: "http://127.0.0.1:9",
        label: "coldstart",
        createdAt: new Date(0).toISOString(),
        version: 1,
    };
}

test("initialize and tools/list are answered locally with no relayer", async (t) => {
    const credsDir = mkdtempSync(join(tmpdir(), "memwal-coldstart-"));
    writeFileSync(join(credsDir, "credentials.json"), JSON.stringify(makeCreds()), { mode: 0o600 });

    const child = spawn(process.execPath, [BIN, "--relayer", "http://127.0.0.1:9"], {
        env: { ...process.env, MEMWAL_CREDS_DIR: credsDir, HOME: credsDir, USERPROFILE: credsDir },
        stdio: ["pipe", "pipe", "pipe"],
    });

    const received = [];
    let buf = "";
    child.stdout.on("data", (d) => {
        buf += d.toString();
        let nl;
        while ((nl = buf.indexOf("\n")) >= 0) {
            const line = buf.slice(0, nl);
            buf = buf.slice(nl + 1);
            if (!line.trim()) continue;
            try {
                received.push(JSON.parse(line));
            } catch {
                /* ignore */
            }
        }
    });

    const send = (obj) => child.stdin.write(JSON.stringify(obj) + "\n");
    const waitFor = (pred, ms = 5_000) => {
        const hit = received.find(pred);
        if (hit) return Promise.resolve(hit);
        return new Promise((res, rej) => {
            const started = Date.now();
            const tick = () => {
                const found = received.find(pred);
                if (found) return res(found);
                if (Date.now() - started > ms) return rej(new Error("timed out"));
                setTimeout(tick, 20);
            };
            tick();
        });
    };

    t.after(() => {
        child.kill("SIGKILL");
        rmSync(credsDir, { recursive: true, force: true });
    });

    const t0 = Date.now();
    send({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "coldstart" } },
    });
    const init = await waitFor((m) => m.id === 1 && m.result);
    assert.ok(Date.now() - t0 < 1_000, "initialize must not wait on a relayer");
    assert.equal(init.result.serverInfo.name, "memwal");
    assert.match(init.result.instructions, /RECALL: before answering/);

    send({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
    const listed = await waitFor((m) => m.id === 2 && m.result);
    assert.deepEqual(
        listed.result.tools.map((t) => t.name),
        SIGNED_IN_TOOLS,
    );
});
