#!/usr/bin/env node
/**
 * Fallback installer for Codex CLI builds without `codex plugin` support
 * (pre-April 2026). Current builds should use the plugin marketplace instead:
 * `codex plugin marketplace add MystenLabs/MemWal` + `codex plugin add
 * memwal@memwal-plugins` (see docs/mcp/codex.md).
 *
 * Installs MemWal lifecycle hooks into ~/.codex/hooks.json and registers the
 * MemWal MCP server in ~/.codex/config.toml.
 *
 * This installer reads the template at hooks/codex-hooks.json, rewrites the
 * ${PLUGIN_ROOT} placeholder to this plugin's absolute path, and merges the
 * entries into ~/.codex/hooks.json.
 *
 * Re-running is idempotent: entries this installer owns (identified by our
 * hook script filenames) are removed before fresh entries are added, and an
 * existing [mcp_servers.memwal] block is migrated to the launcher when it still
 * points at something else (WALM-640) instead of being reported as "already
 * present".
 *
 * Usage:
 *   node install_codex_hooks.mjs              # install or update
 *   node install_codex_hooks.mjs --uninstall  # remove MemWal hook entries
 *
 * After installing, enable the Codex hooks feature flag in ~/.codex/config.toml:
 *
 *   [features]
 *   codex_hooks = true
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { planMcpRegistration } from "./lib/codex-config.mjs";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = dirname(SCRIPT_DIR);

const CODEX_DIR = join(homedir(), ".codex");
const HOOKS_FILE = join(CODEX_DIR, "hooks.json");
const CONFIG_FILE = join(CODEX_DIR, "config.toml");
const TEMPLATE_FILE = join(PLUGIN_ROOT, "hooks", "codex-hooks.json");

// Entries are "ours" when a hook command references one of our scripts.
const OWNER_MARKERS = [
    "on_session_start.mjs",
    "on_user_prompt.mjs",
    "on_post_tool.mjs",
];

function loadTemplate() {
    const raw = readFileSync(TEMPLATE_FILE, "utf8").replaceAll(
        "${PLUGIN_ROOT}",
        PLUGIN_ROOT
    );
    return JSON.parse(raw);
}

function loadExisting() {
    if (!existsSync(HOOKS_FILE)) return { hooks: {} };
    try {
        return JSON.parse(readFileSync(HOOKS_FILE, "utf8"));
    } catch (e) {
        console.error(`error: failed to read ${HOOKS_FILE}: ${e.message}`);
        process.exit(1);
    }
}

function isOwned(entry) {
    for (const hook of entry.hooks || []) {
        const cmd = hook.command || "";
        if (OWNER_MARKERS.some((m) => cmd.includes(m))) return true;
    }
    return false;
}

function stripOwned(config) {
    const hooks = config.hooks || {};
    for (const event of Object.keys(hooks)) {
        hooks[event] = (hooks[event] || []).filter((e) => !isOwned(e));
        if (hooks[event].length === 0) delete hooks[event];
    }
    config.hooks = hooks;
    return config;
}

function mergeTemplate(config, template) {
    config.hooks = config.hooks || {};
    for (const [event, entries] of Object.entries(template.hooks || {})) {
        config.hooks[event] = (config.hooks[event] || []).concat(entries);
    }
    return config;
}

function writeHooks(config) {
    mkdirSync(CODEX_DIR, { recursive: true });
    writeFileSync(HOOKS_FILE, JSON.stringify(config, null, 2) + "\n");
}

/**
 * Register — or migrate — [mcp_servers.memwal] in config.toml.
 *
 * Registers the plugin's launcher by absolute path rather than
 * `npx @mysten-incubation/memwal-mcp@<pin>`. npx resolves that name against the
 * directory Codex is started in, so a package installed in the user's project under
 * the same name — claiming the pinned version — was run instead of ours (WALM-640).
 * The launcher installs the pinned version under ~/.memwal/runtime and runs that
 * absolute entry point, so no project directory takes part in the resolution.
 *
 * An existing block is REWRITTEN, not skipped. Everyone who ran this installer before
 * WALM-640 has the `npx` form on disk, and a "already present" message on re-run would
 * leave exactly the resolution this fix exists to remove in place for exactly the
 * people who already installed. Unrelated keys in the block (`env`, timeouts, …) are
 * preserved — see lib/codex-config.mjs.
 */
function ensureMcpRegistered() {
    mkdirSync(CODEX_DIR, { recursive: true });
    const content = existsSync(CONFIG_FILE) ? readFileSync(CONFIG_FILE, "utf8") : "";
    const launcher = join(SCRIPT_DIR, "launch_mcp.mjs");
    const plan = planMcpRegistration(content, launcher);
    if (plan.action !== "unchanged") writeFileSync(CONFIG_FILE, plan.content);
    return plan;
}

function reportMcpRegistration(plan) {
    if (plan.action === "added") {
        console.log(`Registered [mcp_servers.memwal] in ${CONFIG_FILE}`);
        return;
    }
    if (plan.action === "unchanged") {
        console.log(`[mcp_servers.memwal] in ${CONFIG_FILE} already runs the launcher`);
        return;
    }
    console.log(`Migrated [mcp_servers.memwal] in ${CONFIG_FILE}:`);
    console.log(`  was: command = ${plan.previous.command ?? "(absent)"}`);
    console.log(`       args    = ${plan.previous.args ?? "(absent)"}`);
    console.log(`  now: command = "node"`);
    console.log(`       args    = [${JSON.stringify(launcherPath())}]`);
    if (plan.previous.command?.includes("npx")) {
        console.log(
            "  (the old command resolved the package name against the directory Codex " +
                "was started in — WALM-640)"
        );
    }
    if (plan.preserved.length > 0) {
        console.log(`  kept your other keys: ${plan.preserved.join(", ")}`);
    }
    console.log("  Restart Codex for the change to take effect.");
}

function launcherPath() {
    return join(SCRIPT_DIR, "launch_mcp.mjs");
}

function featureFlagEnabled() {
    if (!existsSync(CONFIG_FILE)) return false;
    return readFileSync(CONFIG_FILE, "utf8")
        .split("\n")
        .map((l) => l.split("#", 1)[0].replace(/\s/g, ""))
        .includes("codex_hooks=true");
}

function printFeatureFlagHint() {
    console.log("");
    console.log("Codex hooks feature flag is not enabled.");
    console.log(`Add this to ${CONFIG_FILE}:`);
    console.log("");
    console.log("  [features]");
    console.log("  codex_hooks = true");
    console.log("");
    console.log("Then restart Codex.");
}

function main() {
    const uninstall = process.argv.includes("--uninstall");
    let config = loadExisting();

    if (uninstall) {
        config = stripOwned(config);
        writeHooks(config);
        console.log(`Removed MemWal hooks from ${HOOKS_FILE}`);
        console.log(
            "(The [mcp_servers.memwal] entry in config.toml was left in place — remove it manually if you no longer want the tools.)"
        );
        return 0;
    }

    if (!existsSync(TEMPLATE_FILE)) {
        console.error(`error: template not found at ${TEMPLATE_FILE}`);
        return 1;
    }

    const template = loadTemplate();
    config = stripOwned(config);
    config = mergeTemplate(config, template);
    writeHooks(config);

    const mcpPlan = ensureMcpRegistered();

    console.log(`Installed MemWal hooks into ${HOOKS_FILE}`);
    console.log(`Plugin path: ${PLUGIN_ROOT}`);
    console.log("Events: SessionStart, UserPromptSubmit, PostToolUse");
    reportMcpRegistration(mcpPlan);

    if (!featureFlagEnabled()) printFeatureFlagHint();
    return 0;
}

process.exit(main());
