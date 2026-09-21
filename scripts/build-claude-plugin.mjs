#!/usr/bin/env node

import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

const ROOT = process.cwd();
const PLUGIN_DIR = "packages/mcp/plugin";
const OVERLAY_DIR = "packages/mcp/plugin-repo";
const MCP_TEST_DIR = "packages/mcp/test";
const POLICY_MODULE = "packages/mcp/plugin/scripts/lib/memory-policy.mjs";
const PLUGIN_REPO = "https://github.com/MystenLabs/walrus-memory-claude-plugin";
const DEFAULT_OUT = "build/claude-plugin";

const COPIED_TESTS = ["signals.test.mjs", "user-prompt-hook.test.mjs"];

const RESERVED = [".github/CODEOWNERS"];

const FORBIDDEN = [
    /(^|\/)node_modules(\/|$)/,
    /(^|\/)dist(\/|$)/,
    /(^|\/)\.DS_Store$/,
    /(^|\/)\.env(\..*)?$/,
    /\.tgz$/,
];

const REQUIRED = [
    ".claude-plugin/plugin.json",
    ".codex-mcp.json",
    ".codex-plugin/plugin.json",
    ".cursor-mcp.json",
    ".cursor-plugin/plugin.json",
    ".github/scripts/check-plugin-tree.mjs",
    ".github/workflows/ci.yml",
    ".gitignore",
    ".mcp.json",
    "LICENSE",
    "README.md",
    "commands/analyze.md",
    "commands/health.md",
    "commands/logout.md",
    "commands/recall.md",
    "commands/remember.md",
    "commands/restore.md",
    "commands/setup.md",
    "docs/usage/claude-code.md",
    "docs/usage/codex.md",
    "docs/usage/hosted-connector.md",
    "docs/usage/other-clients.md",
    "hooks.json",
    "hooks/codex-hooks.json",
    "hooks/cursor-hooks.json",
    "hooks/hooks.json",
    "plugin.json",
    "scripts/lib/decision-rubric.mjs",
    "scripts/lib/hook-io.mjs",
    "scripts/lib/memory-policy.mjs",
    "scripts/lib/signals.mjs",
    "scripts/on_post_tool.mjs",
    "scripts/on_session_start.mjs",
    "scripts/on_user_prompt.mjs",
    "skills/setup/SETUP.md",
    "skills/setup/SKILL.md",
    "test/signals.test.mjs",
    "test/user-prompt-hook.test.mjs",
];

const PLACEHOLDER = /__MEMWAL_[A-Z_]+__/g;

function walk(dir, base = dir) {
    const found = [];
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) found.push(...walk(full, base));
        else if (entry.isFile()) found.push(path.relative(base, full).split(path.sep).join("/"));
    }
    return found.sort();
}

function pinnedVersion(manifest, manifestPath) {
    const version = manifest.mcpPackageVersion ?? manifest.version;
    if (typeof version !== "string" || version.trim() === "") {
        throw new Error(`${manifestPath} has no usable "mcpPackageVersion" or "version"`);
    }
    return version;
}

async function substitutions() {
    const manifestPath = path.join(ROOT, PLUGIN_DIR, "plugin.json");
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));

    const policyPath = path.join(ROOT, POLICY_MODULE);
    if (!fs.existsSync(policyPath)) {
        throw new Error(
            `${POLICY_MODULE} is missing. The plugin's commands, skill and README state the ` +
                `secret-exclusion policy verbatim from that module; without it the generated tree ` +
                `would ship automatic-memory instructions with no policy at all (WALM-642).`,
        );
    }
    const policy = await import(pathToFileURL(policyPath).href);

    return new Map([
        ["__MEMWAL_MCP_VERSION__", pinnedVersion(manifest, manifestPath)],
        ["__MEMWAL_PLUGIN_REPO__", PLUGIN_REPO],
        ["__MEMWAL_SECRET_POLICY__", policy.SECRET_EXCLUSION_RULES],
        ["__MEMWAL_AUTO_SAVE_RULE__", policy.AUTO_SAVE_OPT_IN_RULE],
    ]);
}

function render(text, values, source) {
    const rendered = text.replace(PLACEHOLDER, (token) => {
        const value = values.get(token);
        if (value === undefined) throw new Error(`${source} uses unknown placeholder ${token}`);
        return value;
    });
    const leftover = rendered.match(PLACEHOLDER);
    if (leftover) throw new Error(`${source} still carries ${leftover[0]} after substitution`);
    return rendered;
}

function add(files, target, contents, source) {
    if (FORBIDDEN.some((pattern) => pattern.test(target))) {
        throw new Error(`${source} would emit ${target}, which the plugin tree must not carry`);
    }
    if (RESERVED.includes(target)) {
        throw new Error(`${source} would emit ${target}, which belongs to the published repository`);
    }
    if (files.has(target)) throw new Error(`${target} is emitted twice; ${source} collides`);
    files.set(target, contents);
}

async function build() {
    const values = await substitutions();
    const files = new Map();

    for (const dir of [PLUGIN_DIR, OVERLAY_DIR]) {
        const absolute = path.join(ROOT, dir);
        for (const relative of walk(absolute)) {
            const source = `${dir}/${relative}`;
            const raw = fs.readFileSync(path.join(absolute, relative));
            const contents = relative.endsWith(".md")
                ? Buffer.from(render(raw.toString("utf8"), values, source), "utf8")
                : raw;
            add(files, relative, contents, source);
        }
    }

    add(files, "LICENSE", fs.readFileSync(path.join(ROOT, "LICENSE")), "LICENSE");

    for (const name of COPIED_TESTS) {
        const source = `${MCP_TEST_DIR}/${name}`;
        const text = fs.readFileSync(path.join(ROOT, source), "utf8");
        if (!text.includes("../plugin/scripts/")) {
            throw new Error(`${source} no longer imports from ../plugin/scripts/; update the rewrite`);
        }
        add(files, `test/${name}`, Buffer.from(text.replaceAll("../plugin/scripts/", "../scripts/")), source);
    }

    const missing = REQUIRED.filter((target) => !files.has(target));
    if (missing.length > 0) {
        throw new Error(`the generated tree is missing required files: ${missing.join(", ")}`);
    }

    return new Map([...files].sort(([left], [right]) => (left < right ? -1 : 1)));
}

function digest(files) {
    return [...files].map(([target, contents]) => `${sha256(contents)}  ${target}`).join("\n");
}

function sha256(contents) {
    return createHash("sha256").update(contents).digest("hex");
}

function emit(outDir, files) {
    fs.rmSync(outDir, { recursive: true, force: true });
    for (const [target, contents] of files) {
        const destination = path.join(outDir, target);
        fs.mkdirSync(path.dirname(destination), { recursive: true });
        fs.writeFileSync(destination, contents);
    }
}

function compare(files, againstDir) {
    const problems = [];
    const present = new Set(
        walk(againstDir).filter(
            (target) => !target.startsWith(".git/") && !RESERVED.includes(target),
        ),
    );

    for (const [target, contents] of files) {
        if (!present.has(target)) {
            problems.push(`${target} is missing from ${againstDir}`);
            continue;
        }
        present.delete(target);
        const actual = fs.readFileSync(path.join(againstDir, target));
        if (sha256(actual) !== sha256(contents)) problems.push(`${target} differs from the generated tree`);
    }

    for (const target of present) problems.push(`${target} is in ${againstDir} but is not generated`);

    return problems;
}

function argument(name) {
    const index = process.argv.indexOf(name);
    return index === -1 ? null : process.argv[index + 1] ?? null;
}

async function main() {
    const checking = process.argv.includes("--check");
    const against = argument("--against");

    const files = await build();

    if (!checking) {
        const outDir = path.resolve(ROOT, argument("--out") ?? DEFAULT_OUT);
        emit(outDir, files);
        console.log(`wrote ${files.size} files to ${path.relative(ROOT, outDir) || outDir}`);
        return;
    }

    const problems = [];

    const second = await build();
    if (digest(files) !== digest(second)) problems.push("generating twice produced different output");

    if (against) problems.push(...compare(files, path.resolve(ROOT, against)));

    if (problems.length > 0) {
        for (const problem of problems) console.error(problem);
        process.exit(1);
    }

    console.log(`claude plugin tree OK; ${files.size} files, pinned to the plugin manifest`);
}

await main();
