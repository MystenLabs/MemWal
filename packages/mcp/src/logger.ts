/**
 * Tiny stderr logger — one JSON line per event. stdout is reserved for MCP
 * stdio messages, so logs MUST never go there.
 */

type Level = "info" | "warn" | "error" | "debug";
const DEBUG = !!process.env.MEMWAL_MCP_DEBUG;

function emit(level: Level, event: string, fields: Record<string, unknown> = {}): void {
    if (level === "debug" && !DEBUG) return;
    const line = JSON.stringify({
        ts: new Date().toISOString(),
        level,
        scope: "memwal-mcp",
        event,
        ...fields,
    });
    process.stderr.write(line + "\n");
}

export const log = {
    info: (event: string, fields?: Record<string, unknown>) => emit("info", event, fields),
    warn: (event: string, fields?: Record<string, unknown>) => emit("warn", event, fields),
    error: (event: string, fields?: Record<string, unknown>) => emit("error", event, fields),
    debug: (event: string, fields?: Record<string, unknown>) => emit("debug", event, fields),
};

/** Print a friendly human-readable line to stderr (not JSON). */
export function note(msg: string): void {
    process.stderr.write(`[memwal-mcp] ${msg}\n`);
}
