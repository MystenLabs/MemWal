#!/usr/bin/env node
/**
 * The plugin's MCP launcher (WALM-640).
 *
 * Replaces `npx -y @mysten-incubation/memwal-mcp@<pin>` in every plugin manifest.
 * npx resolves that name against the directory the MCP client started in — the
 * user's project — so a package installed there under the same name, claiming the
 * pinned version, was run instead of ours. This launcher never resolves a name:
 * it makes sure the pinned version is installed under ~/.memwal/runtime and runs
 * that absolute entry point with the current node binary.
 *
 * Everything after the script path is forwarded to the server untouched, so the
 * manifests keep working with flags such as `--dev`, `--namespace work` or
 * `--relayer <url>`. The environment is inherited as-is, and the working directory
 * is left alone so project-local credentials (`.memwal/credentials.json` at or
 * above the cwd) still resolve the way they do today.
 *
 * Usage:
 *   node launch_mcp.mjs [server args...]   # start the MCP stdio server
 *   node launch_mcp.mjs --print-entry      # print the resolved path and exit
 */
import { spawn } from "node:child_process";

import { ensureTrustedEntry, pinnedVersion } from "./lib/mcp-launch.mjs";

const argv = process.argv.slice(2);
const printOnly = argv[0] === "--print-entry";

let entry;
try {
    entry = ensureTrustedEntry();
} catch (err) {
    process.stderr.write(
        `[memwal-mcp] launcher: could not prepare the pinned server ` +
            `(${pinnedVersionSafe()}): ${err?.message ?? String(err)}\n` +
            `[memwal-mcp] launcher: refusing to fall back to a package resolved from ` +
            `the current directory.\n`,
    );
    process.exit(1);
}

if (printOnly) {
    process.stdout.write(entry + "\n");
    process.exit(0);
}

const child = spawn(process.execPath, [entry, ...argv], {
    stdio: "inherit",
    env: process.env,
});

for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
    process.on(signal, () => {
        if (!child.killed) child.kill(signal);
    });
}

child.on("error", (err) => {
    process.stderr.write(`[memwal-mcp] launcher: failed to start ${entry}: ${err.message}\n`);
    process.exitCode = 1;
});

child.on("exit", (code, signal) => {
    process.exitCode = signal ? 1 : (code ?? 0);
});

function pinnedVersionSafe() {
    try {
        return pinnedVersion();
    } catch {
        return "unknown version";
    }
}
