/**
 * Automatic-save opt-in (WALM-642).
 *
 * Saving a fact the user explicitly asked for has never needed permission and
 * still does not. What this module gates is the other thing the package does:
 * telling the model, unprompted, to save anything it judges durable. That
 * guidance ships from three places — the MCP `instructions` field, the
 * cold-start tool descriptions, and the plugin's lifecycle hooks — and until
 * now it was always on, so a preference stated next to a password could be
 * forwarded whole without the user ever choosing automatic memory.
 *
 * Default OFF. An install that says nothing saves nothing on its own.
 *
 * ── Where the answer comes from ────────────────────────────────────────────
 * Two mechanisms, both of which the package already uses, and no third one:
 *
 *   1. `MEMWAL_AUTO_SAVE` — the env-var surface every other option has
 *      (`MEMWAL_NAMESPACE`, `MEMWAL_SERVER_URL`, ...). Set it in the client's
 *      `env` block to pin one MCP server on or off.
 *   2. `settings.json`, next to `credentials.json` — resolved by
 *      `credsPath()`, so it inherits project-local-beats-global and the
 *      `MEMWAL_CREDS_DIR` override for free, and a project that scopes its
 *      credentials scopes its memory behaviour with them.
 *
 * Env beats file, file beats off — the same CLI > env > default ordering the
 * rest of the package uses, with the file standing in for the CLI because the
 * plugin's hooks are separate processes that never see the MCP server's argv.
 * That is also why the state has to live on disk at all: a hook is spawned by
 * the client, not by this package, and inherits none of its configuration.
 */
import { dirname, join } from "node:path";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { credsPath } from "./auth.js";
import { log } from "./logger.js";

/** Env var that pins automatic saving on or off for one MCP server process. */
export const AUTO_SAVE_ENV = "MEMWAL_AUTO_SAVE";

const SETTINGS_FILE = "settings.json";

/** Where the opt-in is stored: beside whichever credentials file is in play. */
export function settingsPath(): string {
    return join(dirname(credsPath()), SETTINGS_FILE);
}

/** Shape of `settings.json`. Unknown keys are preserved on write. */
interface MemWalSettings {
    /** Present only once the user has made a choice either way. */
    autoSave?: boolean;
    [key: string]: unknown;
}

/**
 * Parse a human-written boolean. Returns null for "not set" and for anything
 * unparseable — an unreadable value must not be read as consent.
 */
export function parseBooleanSetting(raw: string | undefined | null): boolean | null {
    if (raw === undefined || raw === null) return null;
    const v = raw.trim().toLowerCase();
    if (v === "") return null;
    if (["1", "true", "on", "yes", "y", "enable", "enabled"].includes(v)) return true;
    if (["0", "false", "off", "no", "n", "disable", "disabled"].includes(v)) return false;
    return null;
}

function readSettings(): MemWalSettings {
    const path = settingsPath();
    if (!existsSync(path)) return {};
    try {
        const parsed = JSON.parse(readFileSync(path, "utf8"));
        return parsed && typeof parsed === "object" ? (parsed as MemWalSettings) : {};
    } catch {
        // A corrupt settings file is not consent. Fall through to the default.
        return {};
    }
}

export type AutoSaveSource = "env" | "settings" | "default";

export interface AutoSaveStatus {
    enabled: boolean;
    source: AutoSaveSource;
    /** Where a persisted choice lives (or would be written). */
    path: string;
}

/** Resolve the opt-in: env, then the settings file, then off. */
export function autoSaveStatus(): AutoSaveStatus {
    const path = settingsPath();
    const fromEnv = parseBooleanSetting(process.env[AUTO_SAVE_ENV]);
    if (fromEnv !== null) return { enabled: fromEnv, source: "env", path };

    const settings = readSettings();
    if (typeof settings.autoSave === "boolean") {
        return { enabled: settings.autoSave, source: "settings", path };
    }
    return { enabled: false, source: "default", path };
}

/**
 * True when the user has turned automatic saving on.
 *
 * Read at call time, never cached: a login can move `credsPath()` and the user
 * can flip the setting between calls in the same process.
 */
export function isAutoSaveEnabled(): boolean {
    return autoSaveStatus().enabled;
}

/**
 * Persist the choice, preserving any other keys already in the file.
 *
 * Written `0600` into the `0700` credentials directory. It holds no secret, but
 * it decides whether this machine saves memories unprompted, so it is not
 * something another account on the box should be able to flip.
 */
export function setAutoSave(enabled: boolean): { path: string; enabled: boolean } {
    const path = settingsPath();
    const next: MemWalSettings = { ...readSettings(), autoSave: enabled };
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    writeFileSync(path, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
    // `writeFileSync`'s `mode` follows POSIX `open()`: the kernel applies it
    // when it CREATES the inode and ignores it for one that already exists, so
    // a file left permissive by anything else would keep its old mode forever.
    // Unlike credentials.json (see `writeSecretFile` in auth.ts) there is no
    // secret in flight here, so tightening afterwards is enough — no reader can
    // learn anything from the window, only whether the flag is set.
    chmodSync(path, 0o600);
    log.info("autosave.set", { enabled, path });
    return { path, enabled };
}

/** One line for a TTY, naming the state, where it came from, and how to flip it. */
export function autoSaveSummary(): string {
    const status = autoSaveStatus();
    const where =
        status.source === "env"
            ? `from ${AUTO_SAVE_ENV}`
            : status.source === "settings"
              ? `from ${status.path}`
              : "default";
    const how = status.enabled
        ? "Turn it off with `memwal-mcp auto-save off`."
        : "Turn it on with `memwal-mcp auto-save on`. Facts you explicitly ask to save are stored either way.";
    return `Automatic memory: ${status.enabled ? "ON" : "OFF"} (${where}). ${how}`;
}
