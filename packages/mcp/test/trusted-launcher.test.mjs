/**
 * The plugin must never run an MCP server that came out of the user's project
 * (WALM-640).
 *
 * The plugin used to start the server with `npx -y @mysten-incubation/memwal-mcp@<pin>`.
 * npx resolves that name against the working directory the MCP client was started
 * in — the project the user has open — so a project carrying an installed package
 * of the same name that *claims the pinned version* won, offline. The version pin
 * is no defence: the fake package just says it is that version.
 *
 * Every test here plants exactly that: a fake `@mysten-incubation/memwal-mcp` in a
 * temp project's node_modules, with the real pinned version in its manifest and a
 * bin that prints LOCAL_PACKAGE_EXECUTED, plus the `node_modules/.bin` shim npx
 * would have found. The launcher must resolve and run the trusted absolute path
 * instead — and when the trusted install cannot be produced, it must fail rather
 * than fall back to the name.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
    MCP_PACKAGE_NAME,
    expectedEntryPath,
    installDir,
    pinnedVersion,
    resolveInstalledEntry,
    runtimeRoot,
} from "../plugin/scripts/lib/mcp-launch.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PLUGIN_DIR = resolve(__dirname, "../plugin");
const LAUNCHER = join(PLUGIN_DIR, "scripts", "launch_mcp.mjs");
const PIN = pinnedVersion();

const LOCAL_MARKER = "LOCAL_PACKAGE_EXECUTED";
const TRUSTED_MARKER = "TRUSTED_ENTRY_EXECUTED";

/**
 * Write a package that looks exactly like the real one to any resolver: same name,
 * same `bin` layout, and whatever version the caller wants it to claim.
 */
function plantPackage(nodeModulesParent, { version, marker }) {
    const packageDir = join(nodeModulesParent, "node_modules", ...MCP_PACKAGE_NAME.split("/"));
    const binDir = join(packageDir, "dist", "bin");
    mkdirSync(binDir, { recursive: true });
    writeFileSync(
        join(packageDir, "package.json"),
        JSON.stringify({
            name: MCP_PACKAGE_NAME,
            version,
            bin: { "memwal-mcp": "dist/bin/memwal-mcp.js" },
        }),
    );
    const entry = join(binDir, "memwal-mcp.js");
    writeFileSync(
        entry,
        `console.log(${JSON.stringify(marker)});\n` +
            `console.log("ARGV:" + process.argv.slice(2).join(" "));\n`,
    );
    return entry;
}

/** The PATH-relative shim npx would have reached for inside the project. */
function plantBinShim(projectDir, marker) {
    const binDir = join(projectDir, "node_modules", ".bin");
    mkdirSync(binDir, { recursive: true });
    const shim = join(binDir, "memwal-mcp");
    writeFileSync(shim, `#!/bin/sh\necho ${marker}\n`);
    chmodSync(shim, 0o755);
    return shim;
}

/**
 * A project a user might have open, carrying a fake package that claims the exact
 * version the plugin pins.
 */
function makeHostileProject(t, { version = PIN } = {}) {
    const dir = mkdtempSync(join(tmpdir(), "memwal-hostile-project-"));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const entry = plantPackage(dir, { version, marker: LOCAL_MARKER });
    plantBinShim(dir, LOCAL_MARKER);
    return { dir, entry };
}

/** A trusted runtime root with the pinned version already installed in it. */
function makeTrustedRuntime(t, { version = PIN, populate = true } = {}) {
    const root = mkdtempSync(join(tmpdir(), "memwal-runtime-"));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    if (!populate) return { root, entry: null };
    const target = installDir(version, root);
    mkdirSync(target, { recursive: true });
    const entry = plantPackage(target, { version, marker: TRUSTED_MARKER });
    return { root, entry };
}

function runLauncher(args, { cwd, env }) {
    return spawnSync(process.execPath, [LAUNCHER, ...args], {
        cwd,
        encoding: "utf8",
        env: { ...process.env, ...env },
    });
}

test("the planted package claims the exact pinned version", (t) => {
    const project = makeHostileProject(t);
    const manifest = JSON.parse(
        readFileSync(
            join(project.dir, "node_modules", ...MCP_PACKAGE_NAME.split("/"), "package.json"),
            "utf8",
        ),
    );
    // If this drifts the rest of the file stops testing the reported attack.
    assert.equal(manifest.version, PIN);
    assert.equal(manifest.name, MCP_PACKAGE_NAME);
});

test("resolution ignores the project entirely and lands in the trusted directory", (t) => {
    const project = makeHostileProject(t);
    const trusted = makeTrustedRuntime(t);

    const previousCwd = process.cwd();
    t.after(() => process.chdir(previousCwd));
    process.chdir(project.dir);

    const resolved = resolveInstalledEntry(installDir(PIN, trusted.root), PIN);
    assert.equal(resolved, trusted.entry);
    assert.equal(resolved, expectedEntryPath({ version: PIN, root: trusted.root }));
    assert.ok(resolved.startsWith(trusted.root), `${resolved} is not under ${trusted.root}`);
    assert.ok(!resolved.includes(project.dir), `${resolved} points into the project`);
});

test("--print-entry from inside the hostile project prints the trusted path", (t) => {
    const project = makeHostileProject(t);
    const trusted = makeTrustedRuntime(t);

    const result = runLauncher(["--print-entry"], {
        cwd: project.dir,
        env: { MEMWAL_MCP_RUNTIME_DIR: trusted.root },
    });

    assert.equal(result.status, 0, result.stderr);
    const printed = result.stdout.trim();
    assert.equal(printed, trusted.entry);
    assert.notEqual(printed, project.entry);
    assert.ok(!printed.includes(project.dir), `${printed} points into the project`);
});

test("launching from the hostile project runs the trusted entry, not the local one", (t) => {
    const project = makeHostileProject(t);
    const trusted = makeTrustedRuntime(t);

    const result = runLauncher([], {
        cwd: project.dir,
        env: { MEMWAL_MCP_RUNTIME_DIR: trusted.root },
    });

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, new RegExp(TRUSTED_MARKER));
    assert.doesNotMatch(result.stdout, new RegExp(LOCAL_MARKER));
});

test("server flags and env are forwarded to the trusted entry unchanged", (t) => {
    const project = makeHostileProject(t);
    const trusted = makeTrustedRuntime(t);

    const result = runLauncher(["--dev", "--namespace", "work"], {
        cwd: project.dir,
        env: { MEMWAL_MCP_RUNTIME_DIR: trusted.root },
    });

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /ARGV:--dev --namespace work/);
});

test("an install under a different version is not accepted for the pin", (t) => {
    const project = makeHostileProject(t);
    // Trusted directory holds a stale build; the pinned directory is empty.
    const trusted = makeTrustedRuntime(t, { version: "0.0.0-stale" });

    assert.equal(resolveInstalledEntry(installDir(PIN, trusted.root), PIN), null);
    assert.equal(
        resolveInstalledEntry(installDir("0.0.0-stale", trusted.root), PIN),
        null,
        "a directory whose manifest disagrees with the pin must not be used",
    );
    assert.ok(!String(trusted.entry).includes(project.dir));
});

test("with no trusted install and no installer, the launcher fails instead of falling back", (t) => {
    const project = makeHostileProject(t);
    const trusted = makeTrustedRuntime(t, { populate: false });

    // An empty PATH makes the `npm` lookup fail the way an offline or broken
    // toolchain would. The launcher must surface that, never reach for the name.
    const result = runLauncher([], {
        cwd: project.dir,
        env: { MEMWAL_MCP_RUNTIME_DIR: trusted.root, PATH: "" },
    });

    assert.notEqual(result.status, 0, "launcher must not succeed without a trusted install");
    assert.doesNotMatch(result.stdout, new RegExp(LOCAL_MARKER));
    assert.doesNotMatch(result.stderr, new RegExp(LOCAL_MARKER));
    assert.match(result.stderr, /refusing to fall back/);
});

test("a relative MEMWAL_MCP_RUNTIME_DIR is rejected, not resolved against the project", (t) => {
    const project = makeHostileProject(t);

    const result = runLauncher(["--print-entry"], {
        cwd: project.dir,
        env: { MEMWAL_MCP_RUNTIME_DIR: "node_modules" },
    });

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /absolute path/);
    assert.doesNotMatch(result.stdout, new RegExp(LOCAL_MARKER));
});

test("the default trusted root is ~/.memwal/runtime", (t) => {
    const project = makeHostileProject(t);
    const home = mkdtempSync(join(tmpdir(), "memwal-home-"));
    t.after(() => rmSync(home, { recursive: true, force: true }));

    const target = join(home, ".memwal", "runtime", `memwal-mcp@${PIN}`);
    mkdirSync(target, { recursive: true });
    const entry = plantPackage(target, { version: PIN, marker: TRUSTED_MARKER });

    // USERPROFILE alongside HOME: os.homedir() reads USERPROFILE on Windows and
    // would otherwise escape the sandbox into the real home.
    const result = runLauncher(["--print-entry"], {
        cwd: project.dir,
        env: { HOME: home, USERPROFILE: home, MEMWAL_MCP_RUNTIME_DIR: "" },
    });

    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout.trim(), entry);
});

test("runtimeRoot honours an absolute override and otherwise sits under the home dir", () => {
    const previous = process.env.MEMWAL_MCP_RUNTIME_DIR;
    try {
        const absolute = join(tmpdir(), "memwal-runtime-override");
        process.env.MEMWAL_MCP_RUNTIME_DIR = absolute;
        assert.equal(runtimeRoot(), absolute);

        delete process.env.MEMWAL_MCP_RUNTIME_DIR;
        assert.match(runtimeRoot(), /[\\/]\.memwal[\\/]runtime$/);
    } finally {
        if (previous === undefined) delete process.env.MEMWAL_MCP_RUNTIME_DIR;
        else process.env.MEMWAL_MCP_RUNTIME_DIR = previous;
    }
});

test("no plugin launch manifest resolves the server through npx", () => {
    const manifests = [
        [".mcp.json", "${CLAUDE_PLUGIN_ROOT}"],
        [".cursor-mcp.json", "${CURSOR_PLUGIN_ROOT}"],
        [".codex-mcp.json", "${PLUGIN_ROOT}"],
    ];
    for (const [name, root] of manifests) {
        const server = JSON.parse(readFileSync(join(PLUGIN_DIR, name), "utf8")).mcpServers.memwal;
        assert.equal(server.command, "node", `${name} must not launch through npx`);
        assert.deepEqual(server.args, [`${root}/scripts/launch_mcp.mjs`], name);
    }

    const installer = readFileSync(
        join(PLUGIN_DIR, "scripts", "install_codex_hooks.mjs"),
        "utf8",
    );
    assert.doesNotMatch(
        installer,
        /command\s*=\s*\\?"npx/,
        "the Codex fallback installer must register the launcher, not npx",
    );
    assert.match(installer, /launch_mcp\.mjs/);
});
