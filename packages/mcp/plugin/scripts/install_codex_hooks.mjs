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
 * Re-running is idempotent: the hooks this installer owns are removed before
 * fresh ones are added. Ownership is decided per hook, by a marker this
 * installer writes (or, for installs predating that marker, by an exact match
 * against the commands it generates for this plugin directory) — never by the
 * hook script's filename, which another tool may legitimately share. Hooks
 * belonging to anyone else, including siblings inside the same group, and the
 * group's own settings are left untouched. An existing [mcp_servers.memwal]
 * block is migrated to the launcher when it still points at something else
 * (WALM-640) instead of being reported as "already present".
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

import { planMcpRegistration } from "./lib/codex-config.mjs";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = dirname(SCRIPT_DIR);

const CODEX_DIR = join(homedir(), ".codex");
const HOOKS_FILE = join(CODEX_DIR, "hooks.json");
const CONFIG_FILE = join(CODEX_DIR, "config.toml");
const TEMPLATE_FILE = join(PLUGIN_ROOT, "hooks", "codex-hooks.json");

const PLACEHOLDER = "${PLUGIN_ROOT}";

// Every hook this installer writes carries this marker, so a later run can
// recognise its own entries outright instead of guessing from a filename.
// `on_user_prompt.mjs` is a generic name: another tool's hook may well use it,
// and that hook is not ours to touch.
const MARKER_KEY = "_memwal";
const MARKER_VALUE = "memwal-plugin-hooks";

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

/**
 * The exact commands this installer writes for the current PLUGIN_ROOT, plus
 * the ones it wrote before WALM-641 quoted the path. Installs made by an older
 * build carry no marker, so they are still recognised — but only when the
 * command matches ours character for character, which a hook belonging to
 * another tool never will.
 */
function ownedCommands() {
    const commands = new Set();
    if (!existsSync(TEMPLATE_FILE)) return commands;
    let template;
    try {
        template = JSON.parse(readFileSync(TEMPLATE_FILE, "utf8"));
    } catch {
        return commands;
    }
    for (const entries of Object.values(template.hooks || {})) {
        for (const entry of entries || []) {
            for (const hook of entry.hooks || []) {
                if (typeof hook.command !== "string") continue;
                // What this build writes, and what pre-WALM-641 builds wrote.
                commands.add(
                    substituteHookPlaceholder(hook, PLACEHOLDER, PLUGIN_ROOT).command
                );
                commands.add(hook.command.replaceAll(PLACEHOLDER, PLUGIN_ROOT));
            }
        }
    }
    return commands;
}

const OWNED_COMMANDS = ownedCommands();

/** A single hook — not the group around it — that this installer put there. */
function isOwnedHook(hook) {
    if (!hook || typeof hook !== "object") return false;
    if (hook[MARKER_KEY] === MARKER_VALUE) return true;
    return typeof hook.command === "string" && OWNED_COMMANDS.has(hook.command);
}

/**
 * Drop our own hooks and nothing else.
 *
 * A group may hold hooks from several tools. Removing the group because one of
 * its hooks is ours takes the siblings with it (WALM-643), so the group is
 * rebuilt with its settings intact and only our hooks filtered out. A group is
 * dropped only once it has no hooks left, and an event only once it has no
 * groups left.
 */
function stripOwned(config) {
    const hooks = config.hooks || {};
    for (const event of Object.keys(hooks)) {
        const kept = [];
        for (const entry of hooks[event] || []) {
            if (!entry || !Array.isArray(entry.hooks)) {
                kept.push(entry);
                continue;
            }
            const keptHooks = entry.hooks.filter((hook) => !isOwnedHook(hook));
            if (keptHooks.length === entry.hooks.length) kept.push(entry);
            else if (keptHooks.length > 0) kept.push({ ...entry, hooks: keptHooks });
        }
        if (kept.length === 0) delete hooks[event];
        else hooks[event] = kept;
    }
    config.hooks = hooks;
    return config;
}

/** Tag each hook so the next run recognises it without matching commands. */
function markOwned(entries) {
    return entries.map((entry) => ({
        ...entry,
        hooks: (entry.hooks || []).map((hook) => ({ ...hook, [MARKER_KEY]: MARKER_VALUE })),
    }));
}

function mergeTemplate(config, template) {
    config.hooks = config.hooks || {};
    for (const [event, entries] of Object.entries(template.hooks || {})) {
        config.hooks[event] = (config.hooks[event] || []).concat(markOwned(entries));
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
