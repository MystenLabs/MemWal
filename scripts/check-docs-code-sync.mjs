#!/usr/bin/env node
/**
 * Checks code in the docs against the packages it documents.
 *
 * Mintlify cannot import code from repository files at build time, so every
 * snippet in docs/ is a copy. This script is the safety net: it derives the
 * canonical facts from the workspace itself, then validates every docs page
 * against them. One check covers the whole docs tree, so sections do not need
 * their own scripts.
 *
 * Canonical sources:
 *   - packages/<name>/package.json  -> published package names and the
 *     subpath entry points declared in `exports`.
 *   - packages/mcp/README.md        -> the MCP server entry (command + args)
 *     that client configs copy.
 *
 * What it validates in every docs/**\/*.md file:
 *   1. Import and require specifiers in the @mysten-incubation scope name a
 *      package that exists in this workspace, and any subpath is a declared
 *      export of that package.
 *   2. Install and npx commands in the same scope name a package that exists.
 *   3. MCP client config blocks (JSON `mcpServers` / `mcp`, Codex TOML
 *      `[mcp_servers.memwal]`) run the canonical command with the canonical
 *      arguments.
 *
 * Failures exit non-zero, so CI blocks the merge: a drifted snippet is fixed
 * in the same pull request rather than tracked as separate follow-up work.
 *
 * Run: node scripts/check-docs-code-sync.mjs
 */
import { readFileSync, readdirSync, existsSync } from "node:fs";
import path from "node:path";
import process from "node:process";

const PACKAGES_DIR = "packages";
const DOCS_DIR = "docs";
const MCP_README = "packages/mcp/README.md";
const SCOPE = "@mysten-incubation/";

// ── Canonical facts from the workspace ─────────────────────────────
const packages = new Map(); // name -> Set of subpath exports ("." plus "./x")
for (const dir of readdirSync(PACKAGES_DIR)) {
    const manifest = path.join(PACKAGES_DIR, dir, "package.json");
    if (!existsSync(manifest)) continue;
    const pkg = JSON.parse(readFileSync(manifest, "utf8"));
    if (!pkg.name) continue;
    const exports = new Set(Object.keys(pkg.exports ?? { ".": {} }));
    packages.set(pkg.name, exports);
}
if (packages.size === 0) {
    console.error(`No packages found under ${PACKAGES_DIR}/.`);
    process.exit(2);
}

// CommonMark allows three or more backticks, and a block closes only on a
// fence at least as long as the one that opened it. Matching a fixed three
// made a four-backtick block parse as an empty one, which then failed the
// JSON parse and dropped out of the checks silently.
function fencedBlocks(markdown) {
    const blocks = [];
    const re = /^[ \t]*(`{3,})([^\n]*)\n([\s\S]*?)^[ \t]*\1`*[ \t]*$/gm;
    let match;
    while ((match = re.exec(markdown)) !== null) {
        blocks.push({
            lang: (match[2].trim().split(/\s+/)[0] || "").toLowerCase(),
            body: match[3],
            line: markdown.slice(0, match.index).split("\n").length,
        });
    }
    return blocks;
}

// `jsonc` and `json5` render the same client config and are common in MCP
// docs. Treat them as JSON so a config block cannot dodge the check by
// changing its info string.
const JSON_LANGS = new Set(["json", "jsonc", "json5"]);

// Strip // and /* */ comments outside strings, so a commented config block
// still parses and still gets checked.
function stripJsonComments(text) {
    let out = "";
    let inString = false;
    let escaped = false;
    for (let i = 0; i < text.length; i += 1) {
        const char = text[i];
        if (inString) {
            out += char;
            if (escaped) escaped = false;
            else if (char === "\\") escaped = true;
            else if (char === '"') inString = false;
            continue;
        }
        if (char === '"') {
            inString = true;
            out += char;
            continue;
        }
        if (char === "/" && text[i + 1] === "/") {
            while (i < text.length && text[i] !== "\n") i += 1;
            out += "\n";
            continue;
        }
        if (char === "/" && text[i + 1] === "*") {
            const end = text.indexOf("*/", i + 2);
            i = end === -1 ? text.length : end + 1;
            continue;
        }
        out += char;
    }
    // Trailing commas that jsonc allows and JSON.parse does not.
    return out.replace(/,(\s*[}\]])/g, "$1");
}

function stripIndent(body) {
    const lines = body.split("\n");
    const indents = lines.filter((l) => l.trim()).map((l) => l.match(/^[ \t]*/)[0].length);
    const cut = indents.length ? Math.min(...indents) : 0;
    return lines.map((l) => l.slice(cut)).join("\n");
}

function tryParseJson(body) {
    try {
        return JSON.parse(stripJsonComments(stripIndent(body)));
    } catch {
        return null;
    }
}

const mcpReadme = readFileSync(MCP_README, "utf8");
const canonicalBlock = fencedBlocks(mcpReadme).find(
    (b) => JSON_LANGS.has(b.lang) && tryParseJson(b.body)?.mcpServers?.memwal,
);
if (!canonicalBlock) {
    console.error(`Could not find the canonical mcpServers block in ${MCP_README}.`);
    process.exit(2);
}
const canonicalServer = tryParseJson(canonicalBlock.body).mcpServers.memwal;

// The README is a copy too, so anchor it to the package manifest. Without
// this, a rename could leave the README and every docs page mutually
// consistent and all of them wrong, with the check still passing.
const mcpManifest = JSON.parse(readFileSync("packages/mcp/package.json", "utf8"));
const mcpPackageName = mcpManifest.name;
if (!canonicalServer.args?.includes(mcpPackageName)) {
    console.error(
        `${MCP_README}: the canonical mcpServers args [${(canonicalServer.args ?? []).join(", ")}] ` +
            `do not name '${mcpPackageName}' from packages/mcp/package.json. ` +
            `Update the README so the docs baseline matches the published package.`,
    );
    process.exit(2);
}

// ── Walk every docs page ───────────────────────────────────────────
function markdownFiles(dir) {
    const found = [];
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) found.push(...markdownFiles(full));
        else if (/\.mdx?$/.test(entry.name)) found.push(full);
    }
    return found;
}

const failures = [];
const counts = { specifiers: 0, commands: 0, mcpBlocks: 0 };
// Per-shape tallies. An aggregate floor is not enough: the docs carry three
// different config shapes, and a break in the search for one of them hides
// behind the other two still being found.
const shapeCounts = new Map();

function lineOf(text, index) {
    return text.slice(0, index).split("\n").length;
}

function checkSpecifier(file, line, specifier) {
    // Split "@scope/name" from any "/subpath".
    const parts = specifier.split("/");
    const name = parts.slice(0, 2).join("/");
    const subpath = parts.length > 2 ? `./${parts.slice(2).join("/")}` : ".";
    const exports = packages.get(name);
    if (!exports) {
        failures.push(
            `${file}:${line}: '${specifier}' is not a package in this workspace. Known: ${[...packages.keys()].join(", ")}.`,
        );
        return;
    }
    if (!exports.has(subpath)) {
        failures.push(
            `${file}:${line}: '${specifier}' is not an entry point of ${name}. Declared exports: ${[...exports].join(", ")}.`,
        );
    }
}

function checkMcpEntry(file, line, label, command, args) {
    counts.mcpBlocks += 1;
    shapeCounts.set(label, (shapeCounts.get(label) ?? 0) + 1);
    if (command !== canonicalServer.command) {
        failures.push(
            `${file}:${line} (${label}): command is '${command}', expected '${canonicalServer.command}' per ${MCP_README}.`,
        );
    }
    const ok =
        Array.isArray(args) && canonicalServer.args.every((item, i) => args[i] === item);
    if (!ok) {
        failures.push(
            `${file}:${line} (${label}): args [${args?.join(", ")}] do not start with the canonical [${canonicalServer.args.join(", ")}] per ${MCP_README}.`,
        );
    }
}

const docFiles = markdownFiles(DOCS_DIR);
for (const file of docFiles) {
    const text = readFileSync(file, "utf8");

    // 1. Import and require specifiers, anywhere on the page.
    const specifierRe = new RegExp(
        `(?:from\\s+|require\\(\\s*|import\\(\\s*)["'](${SCOPE}[^"']+)["']`,
        "g",
    );
    for (const match of text.matchAll(specifierRe)) {
        counts.specifiers += 1;
        checkSpecifier(file, lineOf(text, match.index), match[1]);
    }

    // 2. Install and npx commands.
    const commandRe = new RegExp(
        `(?:npm\\s+install|pnpm\\s+add|yarn\\s+add|npx\\s+(?:-y\\s+)?|bun\\s+add)((?:\\s+${SCOPE}[^\\s"'\`]+)+)`,
        "g",
    );
    for (const match of text.matchAll(commandRe)) {
        for (const raw of match[1].trim().split(/\s+/)) {
            const specifier = raw.replace(/@[\d^~><=.\w-]*$/, (v) =>
                // Keep the scope's leading @, drop a trailing version range.
                raw.indexOf(v) === 0 ? v : "",
            );
            counts.commands += 1;
            checkSpecifier(file, lineOf(text, match.index), specifier);
        }
    }

    // 3. MCP client config blocks.
    for (const block of fencedBlocks(text)) {
        if (JSON_LANGS.has(block.lang)) {
            const parsed = tryParseJson(block.body);
            const server = parsed?.mcpServers?.memwal;
            if (server) {
                // URL entries are the Streamable HTTP transport, not a copy of
                // the stdio command.
                if (server.url && server.command === undefined) continue;
                checkMcpEntry(file, block.line, "mcpServers.memwal", server.command, server.args);
                continue;
            }
            const opencode = parsed?.mcp?.memwal;
            if (opencode) {
                checkMcpEntry(
                    file,
                    block.line,
                    "mcp.memwal",
                    opencode.command?.[0],
                    opencode.command?.slice(1),
                );
            }
        } else if (block.lang === "toml" && block.body.includes("[mcp_servers.memwal]")) {
            const body = stripIndent(block.body);
            const command = body.match(/^command\s*=\s*"([^"]*)"/m)?.[1];
            const argsRaw = body.match(/^args\s*=\s*\[([^\]]*)\]/m)?.[1] ?? "";
            const args = [...argsRaw.matchAll(/"([^"]*)"/g)].map((m) => m[1]);
            checkMcpEntry(file, block.line, "mcp_servers.memwal", command, args);
        }
    }
}

console.log(
    `Packages: ${[...packages.keys()].join(", ")}\n` +
        `Scanned ${docFiles.length} docs pages: ${counts.specifiers} import specifier(s), ` +
        `${counts.commands} install command(s), ${counts.mcpBlocks} MCP config block(s).`,
);

// A check that finds nothing reports success forever. If a docs change moves
// a config block out of reach of the search, that is a broken check, not a
// clean tree, so require every shape the docs are known to contain.
const FLOOR = { specifiers: 1, commands: 1 };
const SHAPE_FLOOR = ["mcpServers.memwal", "mcp.memwal", "mcp_servers.memwal"];
const shortfalls = [
    ...Object.entries(FLOOR)
        .filter(([kind, min]) => counts[kind] < min)
        .map(([kind, min]) => `${kind}: found ${counts[kind]}, expected at least ${min}`),
    ...SHAPE_FLOOR.filter((shape) => (shapeCounts.get(shape) ?? 0) < 1).map(
        (shape) => `${shape}: found 0, expected at least 1`,
    ),
];
if (shortfalls.length > 0) {
    console.error(
        `Across ${docFiles.length} docs pages this check found less than it should:\n` +
            shortfalls.map((s) => `  - ${s}`).join("\n") +
            "\n\nEither the docs no longer contain what this check exists to validate, or the " +
            "check stopped finding it. Confirm which, then fix the search or change the floor " +
            "deliberately.",
    );
    process.exit(2);
}

if (failures.length > 0) {
    console.error(`\n${failures.length} docs reference(s) drifted from the packages:\n`);
    for (const failure of failures) console.error(`  - ${failure}`);
    console.error(
        "\nFix the page to match the package, or update the package first if its interface changed. " +
            "This check fails the build, so the fix belongs in this pull request.",
    );
    process.exit(1);
}
console.log("All docs code references match the packages.");
