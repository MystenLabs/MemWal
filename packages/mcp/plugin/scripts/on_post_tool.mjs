/**
 * PostToolUse hook (Bash) — when a command's output looks like an error,
 * remind the agent it can recall prior fixes and save the resolution.
 *
 * Heuristic only: no fetch, no network. Always exits 0.
 *
 * WALM-642: the "save the fix" half is injected only when the user has turned
 * automatic memory on. A failing command is exactly where a secret shows up in
 * the scrollback — a connection string, an auth header, a token echoed by a
 * CLI — so a hook that nudges an unasked-for save right after one is the worst
 * place to have had that nudge unconditional.
 */
import { readStdin, emitContext } from "./lib/hook-io.mjs";
import { detectError } from "./lib/signals.mjs";
import { SECRET_EXCLUSION_SUMMARY } from "./lib/memory-policy.mjs";
import { isAutoSaveEnabled } from "./lib/auto-save.mjs";

const input = readStdin();
const output = extractToolOutput(input);

// Ignore short / empty output — not enough to reason about.
if (!output || output.length < 50) process.exit(0);

if (detectError(output)) {
    emitContext(
        "PostToolUse",
        isAutoSaveEnabled()
            ? "That command produced an error. Consider calling memwal_recall to check for a prior fix to a similar error; once you resolve it, save the fix with memwal_remember so it's available next time. " +
                  SECRET_EXCLUSION_SUMMARY +
                  " Error output often contains one — save your own description of the fix, never the output."
            : "That command produced an error. Consider calling memwal_recall to check for a prior fix to a similar error. Automatic saving is OFF, so do not save the fix unless the user asks you to."
    );
}

process.exit(0);

/** Best-effort extraction of a tool's textual output across hook-input shapes. */
function extractToolOutput(input) {
    const r =
        input.tool_response ??
        input.tool_result ??
        input.response ??
        input.output ??
        "";
    if (typeof r === "string") return r;
    if (r && typeof r === "object") {
        if (typeof r.stdout === "string" || typeof r.stderr === "string") {
            return `${r.stdout || ""}\n${r.stderr || ""}`;
        }
        try {
            return JSON.stringify(r);
        } catch {
            return "";
        }
    }
    return "";
}
