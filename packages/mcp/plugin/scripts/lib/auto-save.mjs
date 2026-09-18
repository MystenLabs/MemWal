/**
 * Automatic-save opt-in, hook-side (WALM-642).
 *
 * This file used to be a hand-written MIRROR of `packages/mcp/src/auto-save.ts`
 * — the same walk up the directory tree, the same "nearest project-local
 * `.memwal/credentials.json` wins", the same settings lookup beside whatever
 * that resolved to. Keeping two implementations of one security decision in
 * step is not a thing anyone manages to do, and they drifted: the TypeScript
 * side grew an approval gate (WALM-639) and this side did not, so a repository
 * containing nothing but `.memwal/credentials.json` — contents never parsed,
 * only `existsSync` — read as proof of a long-standing install and switched
 * automatic memory ON for anyone who opened it. A committed `settings.json`
 * next to it could pin `autoSave: true` outright and silence the
 * consent-pending warning while it did.
 *
 * So the mirror is gone. The MCP server resolves the state — approvals,
 * project scoping, the consent answer, all of it — and publishes the ANSWER to
 * `auto-save-state.json` in the trusted state dir (`MEMWAL_CREDS_DIR`, else
 * `~/.memwal`). This file reads that file and nothing else.
 *
 * What that buys:
 *   - No resolution here at all, so there is nothing left to drift.
 *   - Nothing under `process.cwd()` is ever read, so a checkout cannot
 *     influence hook behaviour — not through a credentials file, not through a
 *     settings file, not through anything it can add later.
 *   - Unreadable, missing, malformed, or written by a newer version reads as
 *     "state unknown", which is automatic memory OFF. A hook must never block a
 *     session, and an absent answer is not consent.
 *
 * `MEMWAL_AUTO_SAVE` is still honoured first. It comes from this process's
 * environment — the client's hook configuration, set by the user — never from a
 * file a repository can carry.
 */
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const AUTO_SAVE_ENV = "MEMWAL_AUTO_SAVE";

const HOOK_STATE_FILE = "auto-save-state.json";
/** The only shape this file knows how to read. */
const SUPPORTED_VERSION = 1;

/**
 * The trusted state dir, resolved from the environment and the home directory
 * only. Deliberately does NOT look at `process.cwd()`: that is the whole point.
 *
 * `MEMWAL_CREDS_DIR` is the same trusted escape hatch auth.ts uses, so a
 * sandboxed run (tests, CI) points both sides at the same temporary directory.
 */
function trustedStateDir() {
    const override = process.env.MEMWAL_CREDS_DIR;
    if (override) return override;
    return join(homedir(), ".memwal");
}

/** Where the MCP server publishes the resolved state. */
export function hookStatePath() {
    return join(trustedStateDir(), HOOK_STATE_FILE);
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

/**
 * The published state, or null when there is not a readable, understood one.
 *
 * Every failure mode collapses to null on purpose — missing file, unreadable
 * file, corrupt JSON, a version this build does not know, a payload whose
 * `enabled` is not a boolean. The caller turns null into "off".
 */
function readPublishedState() {
    try {
        const path = hookStatePath();
        if (!existsSync(path)) return null;
        const parsed = JSON.parse(readFileSync(path, "utf8"));
        if (!parsed || typeof parsed !== "object") return null;
        if (parsed.version !== SUPPORTED_VERSION) return null;
        if (typeof parsed.enabled !== "boolean") return null;
        return parsed;
    } catch {
        return null;
    }
}

/**
 * `{ enabled, state, source, pendingConsent }`.
 *
 * `source: "unavailable"` is the fail-safe: the server has not published a
 * state this hook can read, so nothing is saved unprompted and the session is
 * told the question is still open.
 */
export function autoSaveStatus() {
    const fromEnv = parseBooleanSetting(process.env[AUTO_SAVE_ENV]);
    if (fromEnv !== null) {
        return {
            enabled: fromEnv,
            state: fromEnv ? "on" : "off",
            source: "env",
            pendingConsent: false,
        };
    }

    const published = readPublishedState();
    if (!published) {
        return {
            enabled: false,
            state: "unset",
            source: "unavailable",
            pendingConsent: true,
        };
    }
    return {
        enabled: published.enabled,
        state: published.state === "on" || published.state === "off" ? published.state : "unset",
        source: typeof published.source === "string" ? published.source : "unavailable",
        pendingConsent: published.pendingConsent === true,
    };
}

/** True when this session may save without being asked. */
export function isAutoSaveEnabled() {
    return autoSaveStatus().enabled;
}

/** True while a human still owes the consent question an answer. */
export function isConsentPending() {
    return autoSaveStatus().pendingConsent;
}
