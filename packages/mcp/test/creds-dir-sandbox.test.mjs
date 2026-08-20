/**
 * Guards the credential-directory sandbox.
 *
 * A test that writes credentials must be able to keep off the developer's real
 * ~/.memwal. Doing that through HOME alone is silently ineffective on Windows,
 * where os.homedir() reads USERPROFILE and ignores HOME.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

test("MEMWAL_CREDS_DIR decides the path, whatever HOME and USERPROFILE say", async (t) => {
    const first = mkdtempSync(join(tmpdir(), "memwal-creds-a-"));
    const second = mkdtempSync(join(tmpdir(), "memwal-creds-b-"));
    const previous = {
        creds: process.env.MEMWAL_CREDS_DIR,
        home: process.env.HOME,
        userProfile: process.env.USERPROFILE,
    };
    t.after(() => {
        for (const [key, value] of [
            ["MEMWAL_CREDS_DIR", previous.creds],
            ["HOME", previous.home],
            ["USERPROFILE", previous.userProfile],
        ]) {
            if (value === undefined) delete process.env[key];
            else process.env[key] = value;
        }
        rmSync(first, { recursive: true, force: true });
        rmSync(second, { recursive: true, force: true });
    });

    const { credsPath } = await import("../dist/auth.js");

    // Point the home variables at the real home to prove the override wins even
    // then — this is the situation the reported bug actually hit.
    process.env.HOME = homedir();
    process.env.USERPROFILE = homedir();

    process.env.MEMWAL_CREDS_DIR = first;
    assert.equal(credsPath(), join(first, "credentials.json"));

    // Resolved per call, so a module already imported still follows the change.
    // Freezing it at import time is what made the sandbox order-dependent.
    process.env.MEMWAL_CREDS_DIR = second;
    assert.equal(credsPath(), join(second, "credentials.json"));

    delete process.env.MEMWAL_CREDS_DIR;
    assert.equal(credsPath(), join(homedir(), ".memwal", "credentials.json"));
});

test("no test sandboxes HOME without USERPROFILE", () => {
    const setsHome = /\bHOME\s*:|process\.env\.HOME\s*=/;
    const offenders = readdirSync(__dirname)
        .filter((name) => name.endsWith(".test.mjs"))
        .filter((name) => {
            const source = readFileSync(join(__dirname, name), "utf8");
            return setsHome.test(source) && !source.includes("USERPROFILE");
        });

    assert.deepEqual(
        offenders,
        [],
        `these sandbox HOME but not USERPROFILE, so os.homedir() escapes them on ` +
            `Windows and writes land in the real home: ${offenders.join(", ")}`,
    );
});
