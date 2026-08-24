/**
 * `memwal-mcp login` with no TTY must fail loudly instead of booting the
 * auth-required stub and exiting 0.
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

test("`login` without a TTY exits 1 and does not start the auth-required stub", async () => {
    const home = mkdtempSync(join(tmpdir(), "memwal-test-"));
    const child = spawn(process.execPath, [BIN, "login"], {
        env: { ...process.env, HOME: home, USERPROFILE: home },
        stdio: ["pipe", "pipe", "pipe"],
    });

    const stderr = [];
    child.stderr.on("data", (d) => stderr.push(d.toString()));

    const code = await new Promise((resolveExit, reject) => {
        const timer = setTimeout(() => {
            child.kill("SIGKILL");
            reject(new Error("login without a TTY hung"));
        }, 8000);
        child.on("exit", (c) => {
            clearTimeout(timer);
            resolveExit(c);
        });
    });

    rmSync(home, { recursive: true, force: true });
    assert.equal(code, 1);
    const err = stderr.join("");
    assert.match(err, /not a TTY/);
    assert.doesNotMatch(err, /serving_auth_required/);
});
