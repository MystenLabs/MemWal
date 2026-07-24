#!/usr/bin/env node
// Docs freshness check (BEDU-287). Extends the compatibility-contract
// pattern to the volatile values docs quote from source: relayer routes,
// package/registry IDs, public relayer URLs, SDK version references, and
// source-derived limits. Fails CI when docs drift from code.
//
// Truth sources:
//   routes        services/server/src/main.rs
//   versions      services/server/src/compatibility.rs, Cargo.toml
//   limits        services/server/src/types.rs, routes/admin.rs
//   testnet IDs   apps/app/src/config.ts (defaults)
//   mainnet IDs   apps/app/.env.example (mainnet block)
//   relayer URLs  packages/mcp/src/index.ts (env presets)

import fs from "node:fs";
import path from "node:path";

const root = process.cwd();
const failures = [];

function read(relPath) {
    return fs.readFileSync(path.join(root, relPath), "utf8");
}

function capture(label, text, regex) {
    const match = text.match(regex);
    if (!match) throw new Error(`Missing ${label}`);
    return match[1];
}

function fail(message) {
    failures.push(message);
}

function assertContains(where, text, expected, label) {
    if (!text.includes(expected)) {
        fail(`${where}: missing ${label} (${expected})`);
    }
}

// Slice a markdown section: from its heading to the next heading of the
// same or higher level.
function section(docText, heading) {
    const start = docText.indexOf(heading);
    if (start === -1) return null;
    const level = heading.match(/^#+/)[0].length;
    const rest = docText.slice(start + heading.length);
    const next = rest.search(new RegExp(`^#{1,${level}} `, "m"));
    return heading + (next === -1 ? rest : rest.slice(0, next));
}

// ── Sources ─────────────────────────────────────────────────────────
const mainRs = read("services/server/src/main.rs");
const typesRs = read("services/server/src/types.rs");
const adminRs = read("services/server/src/routes/admin.rs");
const compatibilityRs = read("services/server/src/compatibility.rs");
const serverCargo = read("services/server/Cargo.toml");
const appConfig = read("apps/app/src/config.ts");
const appEnvExample = read("apps/app/.env.example");
const mcpIndex = read("packages/mcp/src/index.ts");

// ── Docs under check ────────────────────────────────────────────────
const apiRefPath = "docs/relayer/api-reference.md";
const apiRef = read(apiRefPath);
const selfHostingPath = "docs/relayer/self-hosting.md";
const selfHosting = read(selfHostingPath);

// ── 1. Route coverage: main.rs <-> api-reference.md ─────────────────
// Registered routes, `{param}` normalized to the docs' `:param` form.
const sourceRoutes = [...mainRs.matchAll(/\.route\(\s*"([^"]+)"/g)]
    .map((m) => m[1].replace(/\{([^}]+)\}/g, ":$1"));

for (const route of new Set(sourceRoutes)) {
    if (!apiRef.includes(`\`${route}\``) && !apiRef.includes(` ${route}\``)) {
        fail(`${apiRefPath}: registered route ${route} is not documented`);
    }
}

// Every documented endpoint heading must exist in main.rs.
const documentedRoutes = [...apiRef.matchAll(/^#{2,4} `(?:GET|POST|DELETE) ([^`]+)`/gm)]
    .map((m) => m[1]);
const sourceRouteSet = new Set(sourceRoutes);
for (const route of documentedRoutes) {
    if (!sourceRouteSet.has(route)) {
        fail(`${apiRefPath}: documents ${route}, which main.rs does not register`);
    }
}

// ── 2. Version references in the health example ─────────────────────
const cargoVersion = capture("server package version", serverCargo, /^version\s*=\s*"([^"]+)"/m);
const apiVersion = capture("RELAYER_API_VERSION", compatibilityRs, /RELAYER_API_VERSION:\s*&str\s*=\s*"([^"]+)"/);
const minTs = capture("MIN_TYPESCRIPT_SDK_VERSION", compatibilityRs, /MIN_TYPESCRIPT_SDK_VERSION:\s*&str\s*=\s*"([^"]+)"/);
const minPy = capture("MIN_PYTHON_SDK_VERSION", compatibilityRs, /MIN_PYTHON_SDK_VERSION:\s*&str\s*=\s*"([^"]+)"/);
const minMcp = capture("MIN_MCP_PACKAGE_VERSION", compatibilityRs, /MIN_MCP_PACKAGE_VERSION:\s*&str\s*=\s*"([^"]+)"/);

const healthSection = section(apiRef, "### `GET /health`");
if (!healthSection) {
    fail(`${apiRefPath}: missing GET /health section`);
} else {
    assertContains(`${apiRefPath} health example`, healthSection, `"version": "${cargoVersion}"`, "server version");
    assertContains(`${apiRefPath} health example`, healthSection, `"apiVersion": "${apiVersion}"`, "API version");
    assertContains(`${apiRefPath} health example`, healthSection, `"typescript": "${minTs}"`, "min TypeScript SDK");
    assertContains(`${apiRefPath} health example`, healthSection, `"python": "${minPy}"`, "min Python SDK");
    assertContains(`${apiRefPath} health example`, healthSection, `"mcp": "${minMcp}"`, "min MCP package");
}

// ── 3. Package and registry IDs in self-hosting ─────────────────────
const testnetPackageId = capture("testnet package ID", appConfig, /memwalPackageId[\s\S]*?'(0x[0-9a-f]{64})'/);
const testnetRegistryId = capture("testnet registry ID", appConfig, /memwalRegistryId[\s\S]*?'(0x[0-9a-f]{64})'/);
const mainnetPackageId = capture("mainnet package ID", appEnvExample, /#\s*VITE_MEMWAL_PACKAGE_ID=(0x[0-9a-f]{64})/);
const mainnetRegistryId = capture("mainnet registry ID", appEnvExample, /#\s*VITE_MEMWAL_REGISTRY_ID=(0x[0-9a-f]{64})/);

const staging = section(selfHosting, "### Staging (Testnet)");
const production = section(selfHosting, "### Production (Mainnet)");
if (!staging || !production) {
    fail(`${selfHostingPath}: missing Staging (Testnet) or Production (Mainnet) section`);
} else {
    assertContains(`${selfHostingPath} staging`, staging, testnetPackageId, "testnet MEMWAL_PACKAGE_ID");
    assertContains(`${selfHostingPath} staging`, staging, testnetRegistryId, "testnet MEMWAL_REGISTRY_ID");
    assertContains(`${selfHostingPath} production`, production, mainnetPackageId, "mainnet MEMWAL_PACKAGE_ID");
    assertContains(`${selfHostingPath} production`, production, mainnetRegistryId, "mainnet MEMWAL_REGISTRY_ID");
}

// ── 4. Public relayer URLs across all docs ──────────────────────────
// Any *.memory.walrus.xyz relayer hostname a doc mentions must be one of
// the presets the MCP package ships.
const allowedRelayerHosts = new Set(
    [...mcpIndex.matchAll(/relayer:\s*"https:\/\/([^"]+)"/g)].map((m) => m[1]),
);
if (allowedRelayerHosts.size === 0) {
    fail("packages/mcp/src/index.ts: no relayer presets found (truth source moved?)");
}

function* docFiles(dir) {
    for (const entry of fs.readdirSync(path.join(root, dir), { withFileTypes: true })) {
        const rel = `${dir}/${entry.name}`;
        if (entry.isDirectory()) yield* docFiles(rel);
        else if (/\.mdx?$/.test(entry.name)) yield rel;
    }
}

for (const relPath of docFiles("docs")) {
    const text = read(relPath);
    for (const match of text.matchAll(/(relayer[a-z0-9-]*\.memory\.walrus\.xyz)/g)) {
        if (!allowedRelayerHosts.has(match[1])) {
            fail(`${relPath}: unknown relayer host ${match[1]} (not an MCP package preset)`);
        }
    }
}

// ── 5. Source-derived limits quoted in the API reference ────────────
const maxBulk = capture("MAX_BULK_ITEMS", typesRs, /MAX_BULK_ITEMS:\s*usize\s*=\s*(\d+)/);
const defaultLimit = capture("default_limit", typesRs, /fn default_limit\(\)\s*->\s*usize\s*\{\s*(\d+)/);
const restoreDefault = capture("default_restore_limit", typesRs, /fn default_restore_limit\(\)\s*->\s*usize\s*\{\s*(\d+)/);
const askClamp = adminRs.match(/\.unwrap_or\((\d+)\)\.min\((\d+)\)/);

const bulkSection = section(apiRef, "### `POST /api/remember/bulk`");
if (bulkSection) {
    assertContains(`${apiRefPath} bulk`, bulkSection, `up to ${maxBulk} memories`, "MAX_BULK_ITEMS");
}
const recallSection = section(apiRef, "### `POST /api/recall`");
if (recallSection) {
    assertContains(`${apiRefPath} recall`, recallSection, `defaults to \`${defaultLimit}\``, "recall default limit");
}
const restoreSection = section(apiRef, "### `POST /api/restore`");
if (restoreSection) {
    assertContains(`${apiRefPath} restore`, restoreSection, `defaults to \`${restoreDefault}\``, "restore default limit");
}
const askSection = section(apiRef, "### `POST /api/ask`");
if (askSection && askClamp) {
    assertContains(`${apiRefPath} ask`, askSection, `defaults to \`${askClamp[1]}\``, "ask default limit");
}

// ── Report ──────────────────────────────────────────────────────────
if (failures.length > 0) {
    console.error(`docs freshness check failed (${failures.length} finding${failures.length === 1 ? "" : "s"}):`);
    for (const message of failures) console.error(`  - ${message}`);
    process.exit(1);
}
console.log(`docs freshness OK (${new Set(sourceRoutes).size} routes, IDs, URLs, versions, limits)`);
