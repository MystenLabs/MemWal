/**
 * Tiny structured logger — one JSON line per event on stderr. Stdout is
 * reserved in case we ever expose an MCP stdio entrypoint, so we always
 * write logs to stderr.
 *
 * Production deployments are expected to scrape stderr through their log
 * aggregator (CloudWatch, Loki, Logflare, etc.) and key on the `event`
 * field for alerting.
 */

type LogLevel = "info" | "warn" | "error" | "debug";

export interface LogFields {
    [key: string]: unknown;
}

function emit(level: LogLevel, scope: string, event: string, fields: LogFields = {}): void {
    const line = JSON.stringify({
        ts: new Date().toISOString(),
        level,
        scope,
        event,
        ...fields,
    });
    process.stderr.write(line + "\n");
}

export interface Logger {
    info(event: string, fields?: LogFields): void;
    warn(event: string, fields?: LogFields): void;
    error(event: string, fields?: LogFields): void;
    debug(event: string, fields?: LogFields): void;
}

export function createLogger(scope: string): Logger {
    return {
        info: (event, fields) => emit("info", scope, event, fields),
        warn: (event, fields) => emit("warn", scope, event, fields),
        error: (event, fields) => emit("error", scope, event, fields),
        debug: (event, fields) => {
            if (process.env.MEMWAL_MCP_DEBUG) emit("debug", scope, event, fields);
        },
    };
}
