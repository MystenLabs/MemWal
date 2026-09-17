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
 * The template is parsed as JSON *before* the placeholder is substituted, and
 * the path is POSIX-single-quoted on its way into a hook command, so a plugin
 * directory containing $(...), backticks, quotes or backslashes cannot break
 * out of either the JSON document or the generated shell command.
 *
 * Re-running is idempotent: entries this installer owns (identified by our
 * hook script filenames) are removed before fresh entries are added.
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
import { substituteHookPlaceholder } from "./lib/hook-template.mjs";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = dirname(SCRIPT_DIR);

function resolveMcpVersion() {
    return JSON.parse(readFileSync(join(PLUGIN_ROOT, "plugin.json"), "utf8")).version;
}

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

const PLACEHOLDER = "${PLUGIN_ROOT}";

function loadTemplate() {
    // Parse first, substitute second. Substituting into the raw text would let
    // a path containing a double quote or a backslash rewrite the JSON
    // document, and would leave `$(...)` or backticks live in the hook command.
    return substituteHookPlaceholder(
        JSON.parse(readFileSync(TEMPLATE_FILE, "utf8")),
        PLACEHOLDER,
        PLUGIN_ROOT
    );
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

/** Append [mcp_servers.memwal] to config.toml if it isn't registered yet. */
function ensureMcpRegistered() {
    mkdirSync(CODEX_DIR, { recursive: true });
    let content = existsSync(CONFIG_FILE) ? readFileSync(CONFIG_FILE, "utf8") : "";
    if (content.includes("[mcp_servers.memwal]")) return false;
    const spec = `@mysten-incubation/memwal-mcp@${resolveMcpVersion()}`;
    const block =
        "\n[mcp_servers.memwal]\n" +
        'command = "npx"\n' +
        `args = ["-y", "${spec}"]\n`;
    writeFileSync(CONFIG_FILE, (content.trimEnd() + "\n" + block).trimStart());
    return true;
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

    const mcpAdded = ensureMcpRegistered();

    console.log(`Installed MemWal hooks into ${HOOKS_FILE}`);
    console.log(`Plugin path: ${PLUGIN_ROOT}`);
    console.log("Events: SessionStart, UserPromptSubmit, PostToolUse");
    console.log(
        mcpAdded
            ? `Registered [mcp_servers.memwal] in ${CONFIG_FILE}`
            : `[mcp_servers.memwal] already present in ${CONFIG_FILE}`
    );

    if (!featureFlagEnabled()) printFeatureFlagHint();
    return 0;
}

process.exit(main());
