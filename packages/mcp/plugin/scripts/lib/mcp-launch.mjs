/**
 * Trusted-path resolution for the MemWal MCP server (WALM-640).
 *
 * The plugin used to start the server with `npx -y @mysten-incubation/memwal-mcp@<pin>`.
 * npx resolves a package name against the *current working directory* first, and an
 * MCP client starts its servers in the project the user has open. A project that
 * carries an installed package of the same name whose `version` matches the pin
 * therefore wins: the pinned `npx` command ran the project's own binary, offline,
 * with the user's credentials in reach. The version pin does not help, because the
 * fake package simply claims the pinned version.
 *
 * The fix is to stop resolving a *name* in an untrusted directory and to run an
 * *absolute path* inside a directory we own:
 *
 *   ~/.memwal/runtime/memwal-mcp@<version>/node_modules/@mysten-incubation/memwal-mcp
 *
 * The pinned version is installed there once (npm, with the trusted directory as
 * both prefix and cwd, so no project `.npmrc` or project `node_modules` is in play),
 * and every later launch is a plain `node <absolute entry point>`. Nothing here ever
 * looks at `process.cwd()`, at a project `node_modules`, or at a PATH-relative bin
 * shim, so a package planted in a project cannot be reached at all.
 *
 * The installed tree is verified before it is used and before it is published to its
 * final path: the manifest must carry our package name, the pinned version, and a
 * `bin` entry that resolves back inside the package directory.
 *
 * The version pin lives in exactly one place — `plugin/plugin.json`'s `version`,
 * which the release verifier already keeps equal to `packages/mcp/package.json` —
 * so the manifests cannot drift from the version that actually gets installed.
 */
import {
    existsSync,
    mkdirSync,
    mkdtempSync,
    readFileSync,
    renameSync,
    rmSync,
    writeFileSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const MCP_PACKAGE_NAME = "@mysten-incubation/memwal-mcp";
export const MCP_BIN_NAME = "memwal-mcp";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
/** plugin/scripts/lib -> plugin/scripts -> plugin */
export const PLUGIN_ROOT = dirname(dirname(SCRIPT_DIR));

/**
 * The single source of truth for the version the plugin launches.
 * Kept equal to packages/mcp/package.json by scripts/verify-manual-sdk-release.mjs.
 */
export function pinnedVersion(pluginRoot = PLUGIN_ROOT) {
    const manifest = JSON.parse(readFileSync(join(pluginRoot, "plugin.json"), "utf8"));
    const version = manifest.version;
    if (typeof version !== "string" || version.trim() === "") {
        throw new Error(`${join(pluginRoot, "plugin.json")} has no usable "version"`);
    }
    return version;
}

/**
 * Root of the trusted install area. `MEMWAL_MCP_RUNTIME_DIR` may relocate it, but
 * only to an absolute path: a relative one would resolve against the project the
 * client happens to have open, which is the directory this whole module exists to
 * stay out of.
 */
export function runtimeRoot() {
    const override = process.env.MEMWAL_MCP_RUNTIME_DIR;
    if (override !== undefined && override !== "") {
        if (!isAbsolute(override)) {
            throw new Error(
                `MEMWAL_MCP_RUNTIME_DIR must be an absolute path, received "${override}"`,
            );
        }
        return override;
    }
    return join(homedir(), ".memwal", "runtime");
}

/** One directory per pinned version, so an upgrade never mutates a running install. */
export function installDir(version = pinnedVersion(), root = runtimeRoot()) {
    return join(root, `${MCP_BIN_NAME}@${version}`);
}

function isInside(parent, child) {
    const rel = relative(parent, child);
    return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
}

/**
 * The absolute entry point of the pinned package inside `dir`, or null when `dir`
 * does not hold a usable install. Never throws for a merely-absent install; throws
 * only when a present install is malformed in a way worth surfacing.
 */
export function resolveInstalledEntry(dir, version) {
    const packageDir = join(dir, "node_modules", ...MCP_PACKAGE_NAME.split("/"));
    const manifestPath = join(packageDir, "package.json");
    if (!existsSync(manifestPath)) return null;

    let manifest;
    try {
        manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    } catch {
        return null;
    }
    if (manifest.name !== MCP_PACKAGE_NAME) return null;
    if (version !== undefined && manifest.version !== version) return null;

    const bin = manifest.bin;
    const relBin = typeof bin === "string" ? bin : bin?.[MCP_BIN_NAME];
    if (typeof relBin !== "string" || relBin === "") return null;

    const entry = resolve(packageDir, relBin);
    if (!isInside(packageDir, entry)) {
        throw new Error(
            `${manifestPath} declares a bin outside its own package directory (${entry})`,
        );
    }
    if (!existsSync(entry)) return null;
    return entry;
}

function npmCommand() {
    return process.platform === "win32" ? "npm.cmd" : "npm";
}

/**
 * Install the pinned version into the trusted area and return its absolute entry
 * point. Staged in a sibling temp directory and renamed into place, so a second
 * client starting at the same moment either wins the rename or finds the finished
 * install — neither ever reads a half-written tree.
 */
function install(version, root) {
    const target = installDir(version, root);
    mkdirSync(root, { recursive: true });
    const staging = mkdtempSync(join(root, `.staging-${MCP_BIN_NAME}-`));

    try {
        // A private manifest stops npm from walking up out of the trusted area
        // looking for a package.json to attach the install to.
        writeFileSync(
            join(staging, "package.json"),
            JSON.stringify(
                { name: "memwal-mcp-runtime", version: "0.0.0", private: true },
                null,
                2,
            ) + "\n",
        );

        const spec = `${MCP_PACKAGE_NAME}@${version}`;
        const result = spawnSync(
            npmCommand(),
            [
                "install",
                spec,
                "--prefix",
                staging,
                "--no-audit",
                "--no-fund",
                "--no-save",
                "--loglevel=error",
            ],
            {
                // cwd inside the trusted area: npm reads .npmrc from cwd upward, and
                // the project's .npmrc must not get to choose the registry we install
                // the reviewed version from.
                cwd: staging,
                encoding: "utf8",
                stdio: ["ignore", "pipe", "pipe"],
            },
        );
        if (result.error) {
            throw new Error(`could not run ${npmCommand()}: ${result.error.message}`);
        }
        if (result.status !== 0) {
            throw new Error(
                `${npmCommand()} install ${spec} failed (exit ${result.status}): ` +
                    `${(result.stderr || result.stdout || "").trim()}`,
            );
        }

        const staged = resolveInstalledEntry(staging, version);
        if (!staged) {
            throw new Error(
                `${npmCommand()} install ${spec} reported success but produced no usable ` +
                    `${MCP_PACKAGE_NAME} entry point in ${staging}`,
            );
        }

        try {
            renameSync(staging, target);
        } catch (err) {
            // Lost the race, or a previous run left the directory behind: fall back to
            // whatever is at the final path, but only if it verifies.
            const existing = resolveInstalledEntry(target, version);
            if (!existing) throw err;
            return existing;
        }
    } finally {
        rmSync(staging, { recursive: true, force: true });
    }

    const entry = resolveInstalledEntry(target, version);
    if (!entry) {
        throw new Error(`installed ${MCP_PACKAGE_NAME}@${version} is missing from ${target}`);
    }
    return entry;
}

/**
 * The absolute path the plugin should launch. Installs the pinned version into the
 * trusted area on first use; later calls are a stat of a known path.
 *
 * There is deliberately no fallback: if the trusted install cannot be produced, the
 * launcher fails instead of reaching for a package name that a project could answer.
 */
export function ensureTrustedEntry({ version = pinnedVersion(), root = runtimeRoot() } = {}) {
    const existing = resolveInstalledEntry(installDir(version, root), version);
    if (existing) return existing;
    return install(version, root);
}

/** Exported for the regression test: the path we expect, without installing anything. */
export function expectedEntryPath({ version = pinnedVersion(), root = runtimeRoot() } = {}) {
    return join(
        installDir(version, root),
        "node_modules",
        ...MCP_PACKAGE_NAME.split("/"),
        "dist",
        "bin",
        `${MCP_BIN_NAME}.js`,
    );
}
