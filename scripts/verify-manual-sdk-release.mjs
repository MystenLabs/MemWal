#!/usr/bin/env node

import { existsSync, readFileSync } from "node:fs";

const releases = [
    {
        name: "TypeScript SDK",
        version: "0.1.8",
        manifests: [["packages/sdk/package.json", "version"]],
        changelogs: ["packages/sdk/CHANGELOG.md", "docs/sdk/changelog.mdx"],
    },
    {
        name: "Python SDK",
        version: "0.1.10",
        manifests: [
            ["packages/python-sdk-memwal/pyproject.toml", "toml-version"],
            ["packages/python-sdk-memwal/memwal/__init__.py", "python-version"],
        ],
        changelogs: [
            "packages/python-sdk-memwal/CHANGELOG.md",
            "docs/python-sdk/changelog.mdx",
        ],
    },
    {
        name: "MCP package",
        version: "0.0.14",
        manifests: [
            ["packages/mcp/package.json", "version"],
            [".claude-plugin/marketplace.json", "plugin-version"],
            [".cursor-plugin/marketplace.json", "plugin-version"],
            ["packages/mcp/plugin/.claude-plugin/plugin.json", "version"],
            ["packages/mcp/plugin/.codex-plugin/plugin.json", "version"],
            ["packages/mcp/plugin/.cursor-plugin/plugin.json", "version"],
            ["packages/mcp/plugin/plugin.json", "version"],
        ],
        changelogs: ["packages/mcp/CHANGELOG.md", "docs/mcp/changelog.mdx"],
    },
    {
        name: "OpenClaw plugin",
        version: "0.0.6",
        manifests: [["packages/openclaw-memory-memwal/package.json", "version"]],
        changelogs: [
            "packages/openclaw-memory-memwal/CHANGELOG.md",
            "docs/openclaw/changelog.mdx",
        ],
    },
];

for (const release of releases) {
    for (const [path, kind] of release.manifests) {
        const content = readFileSync(path, "utf8");
        const actual = readVersion(content, kind);
        if (actual !== release.version) {
            throw new Error(`${path}: expected ${release.version}, received ${actual}`);
        }
    }
    for (const path of release.changelogs) {
        const content = readFileSync(path, "utf8");
        if (!content.includes(`## ${release.version}\n`)) {
            throw new Error(`${path}: missing release ${release.version}`);
        }
    }
    console.log(`${release.name} ${release.version}: manifests and changelogs synchronized`);
}

// The plugin no longer launches the server through `npx <name>@<pin>`: npx resolves
// the name against the project the MCP client is started in, so a package planted
// there could answer to the pinned spec (WALM-640). Every launch site must run the
// plugin's launcher, which installs the pin under ~/.memwal/runtime and runs that
// absolute entry point. The pin itself is plugin/plugin.json's version, already
// checked against packages/mcp/package.json above.
const mcpVersion = JSON.parse(readFileSync("packages/mcp/package.json", "utf8")).version;
const LAUNCHER = "scripts/launch_mcp.mjs";
for (const [pluginPath, rootPlaceholder] of [
    ["packages/mcp/plugin/.mcp.json", "${CLAUDE_PLUGIN_ROOT}"],
    ["packages/mcp/plugin/.cursor-mcp.json", "${CURSOR_PLUGIN_ROOT}"],
    ["packages/mcp/plugin/.codex-mcp.json", "${PLUGIN_ROOT}"],
]) {
    const server = JSON.parse(readFileSync(pluginPath, "utf8")).mcpServers.memwal;
    const expected = { command: "node", args: [`${rootPlaceholder}/${LAUNCHER}`] };
    if (
        server.command !== expected.command ||
        JSON.stringify(server.args) !== JSON.stringify(expected.args)
    ) {
        throw new Error(
            `${pluginPath}: expected ${JSON.stringify(expected)}, received ${JSON.stringify({ command: server.command, args: server.args })}`,
        );
    }
}
const installerPath = "packages/mcp/plugin/scripts/install_codex_hooks.mjs";
const installer = readFileSync(installerPath, "utf8");
if (/command\s*=\s*\\?"npx/.test(installer)) {
    throw new Error(
        `${installerPath}: registers the MCP server through npx; it must register the ` +
            `absolute path to ${LAUNCHER} (WALM-640)`,
    );
}
if (!installer.includes("launch_mcp.mjs")) {
    throw new Error(`${installerPath}: does not register ${LAUNCHER}`);
}
const launcherPath = `packages/mcp/plugin/${LAUNCHER}`;
if (!existsSync(launcherPath)) {
    throw new Error(`${launcherPath}: missing, but every launch site points at it`);
}

// Registering the launcher for *new* installations is only half of it: every user who
// ran the installer before WALM-640 has `command = "npx"` in ~/.codex/config.toml, and
// an installer that skips an existing block leaves them on the vulnerable resolution
// for ever. Exercise the migration rather than grepping for its absence.
const codexConfigPath = "packages/mcp/plugin/scripts/lib/codex-config.mjs";
if (!existsSync(codexConfigPath)) {
    throw new Error(`${codexConfigPath}: missing, but ${installerPath} migrates through it`);
}
const { planMcpRegistration } = await import(`../${codexConfigPath}`);
const legacyConfig = [
    "[features]",
    "codex_hooks = true",
    "",
    "[mcp_servers.memwal]",
    'command = "npx"',
    `args = ["-y", "@mysten-incubation/memwal-mcp@${mcpVersion}"]`,
    'env = { MEMWAL_NAMESPACE = "work" }',
    "",
    "[mcp_servers.other]",
    'command = "other"',
    "",
].join("\n");
const migrated = planMcpRegistration(legacyConfig, "/abs/plugin/scripts/launch_mcp.mjs");
if (migrated.action !== "migrated") {
    throw new Error(
        `${codexConfigPath}: an existing npx [mcp_servers.memwal] block must be migrated, ` +
            `received action "${migrated.action}" (WALM-640)`,
    );
}
if (/command\s*=\s*"npx"/.test(migrated.content) || !migrated.content.includes(LAUNCHER)) {
    throw new Error(`${codexConfigPath}: migration did not replace npx with ${LAUNCHER}`);
}
if (!migrated.content.includes("MEMWAL_NAMESPACE") || !migrated.content.includes("[mcp_servers.other]")) {
    throw new Error(`${codexConfigPath}: migration dropped keys it does not own`);
}
console.log(`MCP package ${mcpVersion}: every launch site runs ${LAUNCHER} by absolute path`);
console.log(`MCP package ${mcpVersion}: an existing npx Codex registration is migrated, not skipped`);

function readVersion(content, kind) {
    if (kind === "version") return JSON.parse(content).version;
    if (kind === "plugin-version") return JSON.parse(content).plugins[0].version;
    if (kind === "toml-version") return match(content, /^version = "([^"]+)"$/m);
    if (kind === "python-version") return match(content, /^__version__ = "([^"]+)"$/m);
    throw new Error(`Unknown version reader: ${kind}`);
}

function match(content, pattern) {
    const result = pattern.exec(content);
    if (!result) throw new Error(`Could not read version with ${pattern}`);
    return result[1];
}
