#!/usr/bin/env node

import { existsSync, readFileSync } from "node:fs";

import { SECRET_EXCLUSION_RULES } from "../../scripts/lib/memory-policy.mjs";

const PACKAGE = "@mysten-incubation/memwal-mcp";
const REGISTRY = "https://registry.npmjs.org/@mysten-incubation%2Fmemwal-mcp";

const problems = [];
const fail = (message) => problems.push(message);

for (const file of [
    ".claude-plugin/plugin.json",
    ".mcp.json",
    "plugin.json",
    "skills/setup/SKILL.md",
    "commands/remember.md",
    "commands/recall.md",
    "hooks/hooks.json",
    "LICENSE",
]) {
    if (!existsSync(file)) fail(`Missing ${file}`);
}

const manifest = JSON.parse(readFileSync(".claude-plugin/plugin.json", "utf8"));
for (const key of ["mcpServers", "skills", "commands", "hooks"]) {
    const target = manifest[key];
    if (!target) fail(`.claude-plugin/plugin.json has no "${key}" pointer`);
    else if (!existsSync(target)) fail(`.claude-plugin/plugin.json "${key}" points at missing ${target}`);
}

for (const [file, variable] of Object.entries({
    ".mcp.json": "CLAUDE_PLUGIN_ROOT",
    ".codex-mcp.json": "PLUGIN_ROOT",
    ".cursor-mcp.json": "CURSOR_PLUGIN_ROOT",
})) {
    if (!existsSync(file)) continue;
    const server = JSON.parse(readFileSync(file, "utf8")).mcpServers?.memwal;
    const entry = server?.args?.length === 1 ? server.args[0] : null;
    const pattern = new RegExp(`^\\$\\{${variable}\\}/(scripts/[A-Za-z0-9_./-]+\\.mjs)$`);
    const match = entry ? pattern.exec(entry) : null;
    if (server?.command !== "node" || !match) {
        fail(
            `${file} must start the server as node \${${variable}}/scripts/<launcher>.mjs. ` +
                `A bare package name is resolved against the project directory, so a project ` +
                `shipping a package of the same name wins (WALM-640).`,
        );
        continue;
    }
    if (!existsSync(match[1])) fail(`${file} points at ${match[1]}, which is not in this tree`);
}

const pluginManifest = JSON.parse(readFileSync("plugin.json", "utf8"));
const pin = pluginManifest.mcpPackageVersion ?? pluginManifest.version;
if (typeof pin !== "string" || pin.trim() === "") {
    fail('plugin.json has no usable "mcpPackageVersion" or "version"');
} else {
    const response = await fetch(REGISTRY, { headers: { accept: "application/json" } });
    if (!response.ok) {
        fail(`npm registry answered HTTP ${response.status} for ${PACKAGE}; retry the job`);
    } else {
        const packument = await response.json();
        if (!packument.versions?.[pin]) {
            fail(
                `plugin.json pins ${PACKAGE}@${pin}, which npm does not carry. The launcher ` +
                    `installs that exact version, so every fresh install would fail.`,
            );
        }
    }
}

for (const file of ["README.md", "commands/remember.md", "commands/analyze.md", "skills/setup/SKILL.md"]) {
    if (!existsSync(file)) continue;
    const text = readFileSync(file, "utf8");
    const unresolved = text.match(/__MEMWAL_[A-Z_]+__/);
    if (unresolved) fail(`${file} still carries the generator placeholder ${unresolved[0]}`);
    if (!text.includes(SECRET_EXCLUSION_RULES)) {
        fail(
            `${file} does not carry SECRET_EXCLUSION_RULES verbatim from scripts/lib/memory-policy.mjs. ` +
                `Every surface that drives a save states the same rules (WALM-642).`,
        );
    }
}

if (problems.length > 0) {
    for (const problem of problems) console.error(problem);
    process.exit(1);
}

console.log(`plugin tree OK; ${PACKAGE}@${pin} is published`);
