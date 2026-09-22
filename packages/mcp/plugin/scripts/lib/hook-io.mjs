/**
 * Shared I/O + throttle helpers for MemWal Claude Code / Codex hooks.
 *
 * Pure Node, no dependencies, no network. Every hook reads one JSON object
 * from stdin, optionally emits a `hookSpecificOutput` directive on stdout,
 * and always exits 0 — a hook must never block the session.
 */
import { readFileSync, existsSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Read + parse the hook input JSON from stdin. Returns {} on any error. */
export function readStdin() {
    try {
        const raw = readFileSync(0, "utf8");
        return raw ? JSON.parse(raw) : {};
    } catch {
        return {};
    }
}

/** Emit a hook directive. No-op when `additionalContext` is empty. */
export function emitContext(hookEventName, additionalContext) {
    if (!additionalContext) return;
    process.stdout.write(
        JSON.stringify({
            hookSpecificOutput: { hookEventName, additionalContext },
        })
    );
}

const STATE_DIR = join(process.env.TMPDIR || tmpdir(), "memwal-hooks");

function ensureDir() {
    try {
        mkdirSync(STATE_DIR, { recursive: true });
    } catch {
        /* best effort */
    }
}

function safe(s) {
    return String(s || "default")
        .replace(/[^a-zA-Z0-9_-]/g, "_")
        .slice(0, 64);
}

/**
 * Returns true the FIRST time it is called for a (name, session) pair, then
 * false thereafter — used to inject a rubric or banner only once per session.
 */
export function firstTime(name, sessionId) {
    ensureDir();
    const f = join(STATE_DIR, `${safe(name)}_${safe(sessionId)}`);
    if (existsSync(f)) return false;
    try {
        writeFileSync(f, "1");
    } catch {
        /* best effort */
    }
    return true;
}

/** Increment and return a per-(name, session) counter. */
export function bumpCounter(name, sessionId) {
    ensureDir();
    const f = join(STATE_DIR, `count_${safe(name)}_${safe(sessionId)}`);
    let n = 0;
    try {
        n = parseInt(readFileSync(f, "utf8"), 10) || 0;
    } catch {
        /* missing -> 0 */
    }
    n += 1;
    try {
        writeFileSync(f, String(n));
    } catch {
        /* best effort */
    }
    return n;
}
