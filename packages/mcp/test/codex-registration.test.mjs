/**
 * The Codex fallback installer must MIGRATE an existing `[mcp_servers.memwal]`
 * block, not skip it (WALM-640).
 *
 * The first cut of the fix only changed what a fresh install writes: it returned
 * early on `content.includes("[mcp_servers.memwal]")`. Everyone who had already run
 * the installer therefore kept `command = "npx"` / `args = ["-y", "…@<pin>"]` in
 * ~/.codex/config.toml for ever, while re-running the installer printed "already
 * present" — which reads as success. That is the exact population the ticket was
 * filed for, so it is the case these tests cover: the block is rewritten, whatever
 * else the user put in it survives, and the run says what it changed.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { planMcpRegistration } from "../plugin/scripts/lib/codex-config.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PLUGIN_DIR = resolve(__dirname, "../plugin");
const INSTALLER = join(PLUGIN_DIR, "scripts", "install_codex_hooks.mjs");
const LAUNCHER = join(PLUGIN_DIR, "scripts", "launch_mcp.mjs");
const PIN = JSON.parse(readFileSync(join(PLUGIN_DIR, "plugin.json"), "utf8")).version;

/** Exactly what the pre-WALM-640 installer left on disk. */
const LEGACY_BLOCK = [
    "[features]",
    "codex_hooks = true",
    "",
    "# MemWal memory server",
    "[mcp_servers.memwal]",
    'command = "npx"',
    `args = ["-y", "@mysten-incubation/memwal-mcp@${PIN}"]`,
    'env = { MEMWAL_NAMESPACE = "work" }',
    "startup_timeout_ms = 30000",
    "",
    "[mcp_servers.something_else]",
    'command = "other-server"',
    "",
].join("\n");

function makeHome(t, configToml) {
    const home = mkdtempSync(join(tmpdir(), "memwal-codex-home-"));
    t.after(() => rmSync(home, { recursive: true, force: true }));
    mkdirSync(join(home, ".codex"), { recursive: true });
    if (configToml !== undefined) writeFileSync(join(home, ".codex", "config.toml"), configToml);
    return home;
}

function runInstaller(home) {
    const result = spawnSync(process.execPath, [INSTALLER], {
        encoding: "utf8",
        env: { ...process.env, HOME: home, USERPROFILE: home },
    });
    return {
        ...result,
        config: readFileSync(join(home, ".codex", "config.toml"), "utf8"),
    };
}

test("a legacy npx registration is migrated when the installer is re-run", (t) => {
    const home = makeHome(t, LEGACY_BLOCK);
    const result = runInstaller(home);

    assert.equal(result.status, 0, result.stderr);
    assert.doesNotMatch(result.config, /command\s*=\s*"npx"/, "npx must be gone from config.toml");
    assert.doesNotMatch(result.config, /memwal-mcp@/, "the npx spec must be gone too");
    assert.match(result.config, /command = "node"/);
    assert.ok(
        result.config.includes(JSON.stringify(LAUNCHER)),
        `config.toml does not point at ${LAUNCHER}:\n${result.config}`,
    );

    // The user's own keys survive, inside and outside our block.
    assert.match(result.config, /env = \{ MEMWAL_NAMESPACE = "work" \}/);
    assert.match(result.config, /startup_timeout_ms = 30000/);
    assert.match(result.config, /# MemWal memory server/);
    assert.match(result.config, /\[mcp_servers\.something_else\]/);
    assert.match(result.config, /command = "other-server"/);
    assert.match(result.config, /codex_hooks = true/);

    // And it says so, rather than "already present".
    assert.match(result.stdout, /Migrated \[mcp_servers\.memwal\]/);
    assert.doesNotMatch(result.stdout, /already present/);
    assert.match(result.stdout, /kept your other keys: env, startup_timeout_ms/);
});

test("a second run after the migration reports no change and rewrites nothing", (t) => {
    const home = makeHome(t, LEGACY_BLOCK);
    const first = runInstaller(home);
    const second = runInstaller(home);

    assert.equal(second.status, 0, second.stderr);
    assert.equal(second.config, first.config, "a settled config.toml must not keep churning");
    assert.match(second.stdout, /already runs the launcher/);
});

test("a fresh config.toml gets the launcher registration", (t) => {
    const home = makeHome(t, "");
    const result = runInstaller(home);

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Registered \[mcp_servers\.memwal\]/);
    assert.match(result.config, /\[mcp_servers\.memwal\]/);
    assert.match(result.config, /command = "node"/);
    assert.ok(result.config.includes(JSON.stringify(LAUNCHER)));
});

test("planMcpRegistration keeps every unrelated key and only rewrites command/args", () => {
    const plan = planMcpRegistration(LEGACY_BLOCK, "/abs/launch_mcp.mjs");

    assert.equal(plan.action, "migrated");
    assert.deepEqual(plan.preserved, ["env", "startup_timeout_ms"]);
    assert.equal(plan.previous.command, '"npx"');
    assert.match(plan.previous.args, /memwal-mcp@/);
    assert.equal(
        plan.content,
        [
            "[features]",
            "codex_hooks = true",
            "",
            "# MemWal memory server",
            "[mcp_servers.memwal]",
            'command = "node"',
            'args = ["/abs/launch_mcp.mjs"]',
            'env = { MEMWAL_NAMESPACE = "work" }',
            "startup_timeout_ms = 30000",
            "",
            "[mcp_servers.something_else]",
            'command = "other-server"',
            "",
        ].join("\n"),
    );
});

test("a multi-line args array is replaced whole, not line by line", () => {
    const content = [
        "[mcp_servers.memwal]",
        'command = "npx"',
        "args = [",
        '  "-y",',
        '  "@mysten-incubation/memwal-mcp@0.0.14",',
        "]",
        'env = { A = "1" }',
        "",
        "[other]",
        "x = 1",
        "",
    ].join("\n");

    const plan = planMcpRegistration(content, "/abs/launch_mcp.mjs");
    assert.equal(plan.action, "migrated");
    assert.doesNotMatch(plan.content, /-y/);
    assert.doesNotMatch(plan.content, /memwal-mcp@0\.0\.14/);
    assert.match(plan.content, /args = \["\/abs\/launch_mcp\.mjs"\]/);
    assert.match(plan.content, /env = \{ A = "1" \}/);
    assert.match(plan.content, /\[other\]\nx = 1/);
});

test("a block with the keys missing still ends up launching the launcher", () => {
    const plan = planMcpRegistration(
        ['[mcp_servers.memwal]', 'env = { A = "1" }', ""].join("\n"),
        "/abs/launch_mcp.mjs",
    );
    assert.equal(plan.action, "migrated");
    assert.match(plan.content, /command = "node"/);
    assert.match(plan.content, /args = \["\/abs\/launch_mcp\.mjs"\]/);
    assert.match(plan.content, /env = \{ A = "1" \}/);
});

test("a block pointing at a different launcher path is re-pointed", () => {
    const stale = [
        "[mcp_servers.memwal]",
        'command = "node"',
        'args = ["/old/plugin/scripts/launch_mcp.mjs"]',
        "",
    ].join("\n");
    const plan = planMcpRegistration(stale, "/new/plugin/scripts/launch_mcp.mjs");
    assert.equal(plan.action, "migrated");
    assert.match(plan.content, /args = \["\/new\/plugin\/scripts\/launch_mcp\.mjs"\]/);
    assert.doesNotMatch(plan.content, /\/old\/plugin/);
});

test("the section name is matched exactly, not by substring", () => {
    const other = ['[mcp_servers.memwal_other]', 'command = "npx"', ""].join("\n");
    const plan = planMcpRegistration(other, "/abs/launch_mcp.mjs");
    assert.equal(plan.action, "added", "an unrelated server must not be rewritten");
    assert.match(plan.content, /\[mcp_servers\.memwal_other\]\ncommand = "npx"/);
    assert.match(plan.content, /\[mcp_servers\.memwal\]\ncommand = "node"/);
});
