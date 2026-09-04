#!/usr/bin/env node

import { readFileSync } from "node:fs";

const releases = [
    {
        name: "TypeScript SDK",
        version: "0.1.6",
        manifests: [["packages/sdk/package.json", "version"]],
        changelogs: ["packages/sdk/CHANGELOG.md", "docs/sdk/changelog.mdx"],
    },
    {
        name: "Python SDK",
        version: "0.1.9",
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
        version: "0.0.12",
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
