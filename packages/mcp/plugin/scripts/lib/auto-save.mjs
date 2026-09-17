/**
 * Automatic-save opt-in, hook-side (WALM-642).
 *
 * The mirror of `packages/mcp/src/auto-save.ts`, in plain ESM with no
 * dependencies and no network, because a hook is a `.mjs` file the client
 * spawns directly — it never loads this package's compiled `dist/`, and it
 * inherits none of the MCP server's configuration (a hook is spawned by Claude
 * Code or Codex, the MCP server by its own `command`/`env` block). A shared
 * file on disk is the only thing both sides can actually see, which is why the
 * choice is persisted rather than passed.
 *
 * Resolution is deliberately identical to the TypeScript side:
 *   1. `MEMWAL_AUTO_SAVE` in the environment.
 *   2. `autoSave` in `settings.json`, in whichever `.memwal` directory the
 *      credentials resolve to — `MEMWAL_CREDS_DIR`, else the nearest
 *      project-local `.memwal/credentials.json` at or above the working
 *      directory, else `~/.memwal`.
 *   3. Off.
 *
 * Any error reads as "off": a hook must never block a session, and an
 * unreadable file is not consent.
 */
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export const AUTO_SAVE_ENV = "MEMWAL_AUTO_SAVE";

const CREDS_FILE = "credentials.json";
const SETTINGS_FILE = "settings.json";

function globalCredsPath() {
    return join(homedir(), ".memwal", CREDS_FILE);
}

/**
 * Nearest project-local credentials file, walking up from the working
 * directory and stopping at the project root, the home directory, or the
 * filesystem root. Mirrors `projectCredsPath()` in src/auth.ts — the two must
 * agree, or a project-scoped opt-in would apply to the hooks and not the server
 * (or the other way round).
 */
function projectCredsPath() {
    const home = homedir();
    const global = globalCredsPath();
    let dir = process.cwd();
    for (;;) {
        if (dir === home) return null;
        const candidate = join(dir, ".memwal", CREDS_FILE);
        if (candidate !== global && existsSync(candidate)) return candidate;
        if (existsSync(join(dir, ".git"))) return null;
        const parent = dirname(dir);
        if (parent === dir) return null;
        dir = parent;
    }
}

function credsPath() {
    const override = process.env.MEMWAL_CREDS_DIR;
    if (override) return join(override, CREDS_FILE);
    return projectCredsPath() ?? globalCredsPath();
}

/** Where a persisted choice lives for this working directory. */
export function settingsPath() {
    return join(dirname(credsPath()), SETTINGS_FILE);
}

/** Human-written boolean. null = not set / unparseable, which is not consent. */
export function parseBooleanSetting(raw) {
    if (raw === undefined || raw === null) return null;
    const v = String(raw).trim().toLowerCase();
    if (v === "") return null;
    if (["1", "true", "on", "yes", "y", "enable", "enabled"].includes(v)) return true;
    if (["0", "false", "off", "no", "n", "disable", "disabled"].includes(v)) return false;
    return null;
}

/** `{ enabled, source }` where source is "env" | "settings" | "default". */
export function autoSaveStatus() {
    const fromEnv = parseBooleanSetting(process.env[AUTO_SAVE_ENV]);
    if (fromEnv !== null) return { enabled: fromEnv, source: "env" };

    try {
        const path = settingsPath();
        if (existsSync(path)) {
            const parsed = JSON.parse(readFileSync(path, "utf8"));
            if (parsed && typeof parsed.autoSave === "boolean") {
                return { enabled: parsed.autoSave, source: "settings" };
            }
        }
    } catch {
        /* unreadable or corrupt — fall through to the default */
    }
    return { enabled: false, source: "default" };
}

/** True only when the user has turned automatic saving on. */
export function isAutoSaveEnabled() {
    return autoSaveStatus().enabled;
}
