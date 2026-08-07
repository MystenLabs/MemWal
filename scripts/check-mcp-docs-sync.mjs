#!/usr/bin/env node
/**
 * Guards the MCP setup snippets in docs/mcp/ against drift from the package.
 *
 * The canonical server entry lives in packages/mcp/README.md (the package's
 * own quick start). Every MCP config block in the docs is a copy of it, since
 * Mintlify cannot import code from repository files at build time. This check
 * fails CI when any copy diverges, so the docs never advertise a command or
 * argument list the package does not ship.
 *
 * Checked shapes, in every docs/mcp/*.md file:
 *   - JSON blocks with `mcpServers.memwal` (Claude Desktop, Cursor,
 *     Antigravity): `command` must match the canonical command and `args`
 *     must start with the canonical args (extras such as `--namespace` are
 *     allowed).
 *   - JSON blocks with `mcp.memwal` (OpenCode): the `command` array must
 *     start with the canonical [command, ...args].
 *   - TOML blocks with `[mcp_servers.memwal]` (Codex): same rule as
 *     mcpServers, parsed from the `command` and `args` lines.
 *
 * Run: node scripts/check-mcp-docs-sync.mjs
 */
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import process from "node:process";

const README = "packages/mcp/README.md";
const DOCS_DIR = "docs/mcp";

function fencedBlocks(markdown) {
    const blocks = [];
    const re = /^[ \t]*```(\w+)?[^\n]*\n([\s\S]*?)^[ \t]*```/gm;
    let match;
    while ((match = re.exec(markdown)) !== null) {
        const line = markdown.slice(0, match.index).split("\n").length;
        blocks.push({ lang: (match[1] || "").toLowerCase(), body: match[2], line });
    }
    return blocks;
}

function stripIndent(body) {
    const lines = body.split("\n");
    const indents = lines
        .filter((l) => l.trim())
        .map((l) => l.match(/^[ \t]*/)[0].length);
    const cut = indents.length ? Math.min(...indents) : 0;
    return lines.map((l) => l.slice(cut)).join("\n");
}

function tryParseJson(body) {
    try {
        return JSON.parse(stripIndent(body));
    } catch {
        return null;
    }
}

function startsWith(actual, expected) {
    return (
        Array.isArray(actual) &&
        expected.every((item, i) => actual[i] === item)
    );
}

// ── Canonical entry from the package README ────────────────────────
const readmeBlocks = fencedBlocks(readFileSync(README, "utf8"));
const canonicalBlock = readmeBlocks.find((b) => {
    if (b.lang !== "json") return false;
    const parsed = tryParseJson(b.body);
    return Boolean(parsed?.mcpServers?.memwal);
});
if (!canonicalBlock) {
    console.error(`Could not find the canonical mcpServers block in ${README}.`);
    process.exit(2);
}
const canonical = tryParseJson(canonicalBlock.body).mcpServers.memwal;
console.log(
    `Canonical server entry (${README}): ${canonical.command} ${canonical.args.join(" ")}`,
);

const failures = [];

function checkEntry(file, line, label, command, args) {
    if (command !== canonical.command) {
        failures.push(
            `${file}:${line} (${label}): command is '${command}', expected '${canonical.command}'.`,
        );
    }
    if (!startsWith(args, canonical.args)) {
        failures.push(
            `${file}:${line} (${label}): args [${args?.join(", ")}] do not start with the canonical [${canonical.args.join(", ")}].`,
        );
    }
}

// ── Scan the docs ──────────────────────────────────────────────────
const docFiles = readdirSync(DOCS_DIR)
    .filter((f) => f.endsWith(".md"))
    .map((f) => path.join(DOCS_DIR, f));

let checked = 0;
for (const file of docFiles) {
    for (const block of fencedBlocks(readFileSync(file, "utf8"))) {
        if (block.lang === "json") {
            const parsed = tryParseJson(block.body);
            const server = parsed?.mcpServers?.memwal;
            if (server) {
                // URL-based entries are the Streamable HTTP transport, not a
                // copy of the stdio command; only command entries must match.
                if (server.url && server.command === undefined) continue;
                checked += 1;
                checkEntry(file, block.line, "mcpServers.memwal", server.command, server.args);
                continue;
            }
            const opencode = parsed?.mcp?.memwal;
            if (opencode) {
                checked += 1;
                checkEntry(
                    file,
                    block.line,
                    "mcp.memwal",
                    opencode.command?.[0],
                    opencode.command?.slice(1),
                );
            }
        } else if (block.lang === "toml" && block.body.includes("[mcp_servers.memwal]")) {
            checked += 1;
            const body = stripIndent(block.body);
            const command = body.match(/^command\s*=\s*"([^"]*)"/m)?.[1];
            const argsRaw = body.match(/^args\s*=\s*\[([^\]]*)\]/m)?.[1] ?? "";
            const args = [...argsRaw.matchAll(/"([^"]*)"/g)].map((m) => m[1]);
            checkEntry(file, block.line, "mcp_servers.memwal", command, args);
        }
    }
}

if (failures.length > 0) {
    console.error(`\n${failures.length} MCP snippet(s) drifted from ${README}:\n`);
    for (const failure of failures) console.error(`  - ${failure}`);
    console.error(
        `\nUpdate the docs block(s) to match the package README, or update the README first if the package interface changed.`,
    );
    process.exit(1);
}
console.log(`Checked ${checked} MCP config block(s) across ${docFiles.length} docs pages; all match.`);
