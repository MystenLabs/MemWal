/**
 * Shared helpers for tool implementations.
 */
import type { MemWalSession } from "../auth.js";
import { createLogger } from "../logger.js";

const log = createLogger("mcp");

interface ToolResultLike {
    [x: string]: unknown;
    content: Array<{ type: "text"; text: string;[x: string]: unknown }>;
    isError?: boolean;
}

/**
 * Wrap a tool handler so any thrown error is surfaced to the MCP client as
 * an `isError: true` envelope instead of leaking the raw exception.
 *
 * Known error names we map to a specific prefix so agents can route on the
 * class without parsing the message:
 *     MemWalRememberJobFailed  → "Walrus Memory job failed"
 *     MemWalRememberJobTimeout → "Walrus Memory job timed out"
 *     MemWalRememberJobNotFound→ "Walrus Memory job not found"
 *     MemWalError              → "Walrus Memory relayer error"
 * Anything else propagates under "Tool error:".
 *
 * The underlying Error.cause (if present, e.g. Node's `TypeError("fetch
 * failed")`) is logged to sidecar stderr for operators and appended to the
 * client-facing message so the agent has enough context to act.
 */
/**
 * Canonical Walruscan explorer URL for a blob. Built server-side so agents
 * cite the real domain (walruscan.com) instead of guessing one.
 */
export function walruscanBlobUrl(blobId: string): string {
    const network =
        process.env.SUI_NETWORK === "testnet" ? "testnet" : "mainnet";
    return `https://walruscan.com/${network}/blob/${blobId}`;
}

/**
 * One-line footer for write-tool results. A function (not a module const) so
 * SUI_NETWORK is read at call time, after the sidecar's env loading.
 */
export function explorerFooter(): string {
    return `Explorer: ${walruscanBlobUrl("<blob_id>")} for any blob_id above.`;
}

const DEFAULT_SLOW_TOOL_WARN_MS = 5000;

/**
 * Above this, a tool call is reported at `warn` rather than `info`.
 * Tuned to sit above a healthy `memwal_health` (single unsigned GET to the
 * relayer, tens of milliseconds) and below a healthy `memwal_remember`
 * (embed + SEAL + Walrus), so the threshold catches a slow hop to the
 * relayer without crying about work that is slow by nature.
 *
 * Read once, because it cannot change mid-process — but validated, because a
 * typo'd value must not silently disable the only signal this file adds.
 * `Number.parseInt` alone accepts "5s" as 5 and yields NaN for "" or "abc",
 * and every NaN comparison is false, so an unvalidated parse turns the warning
 * off without saying anything.
 */
const SLOW_TOOL_WARN_MS = (() => {
    const raw = process.env.MCP_TOOL_SLOW_WARN_MS;
    if (raw === undefined || raw.trim() === "") return DEFAULT_SLOW_TOOL_WARN_MS;
    const parsed = Number(raw);
    if (!Number.isFinite(parsed) || parsed <= 0) {
        log.warn("tool.slow_threshold_invalid", {
            value: raw,
            usingMs: DEFAULT_SLOW_TOOL_WARN_MS,
        });
        return DEFAULT_SLOW_TOOL_WARN_MS;
    }
    return parsed;
})();

export function wrapTool<Args>(
    session: MemWalSession,
    tool: string,
    handler: (args: Args) => Promise<ToolResultLike>
): (args: Args) => Promise<ToolResultLike> {
    return async (args) => {
        log.info("tool.call", {
            tool,
            agentClient: session.agentClient ?? null,
            clientName: session.clientName ?? null,
            accountId: session.accountId ?? null,
        });
        // How long the call takes is the only number that shows a slow hop to
        // the relayer. Per-request latency on the relayer side cannot: it
        // measures the request once it lands, so a minute spent reaching it
        // reads as a healthy few milliseconds there and as silence here.
        const startedAt = Date.now();
        const durationMs = () => Date.now() - startedAt;
        const outcomeFields = () => ({
            tool,
            durationMs: durationMs(),
            relayerUrl: session.relayerUrl ?? null,
            agentClient: session.agentClient ?? null,
            accountId: session.accountId ?? null,
        });

        // Fire WHILE the call is still running, not when it settles. A hang is
        // precisely the case that never settles: the incident this timing was
        // written for left a tool call outstanding for 61s and the process
        // emitted nothing until it finally returned. A settle-only log would
        // have stayed silent for the whole minute an operator was looking.
        // `unref` so a pending timer can never hold the sidecar open.
        const watchdog = setTimeout(() => {
            log.warn("tool.slow", {
                ...outcomeFields(),
                thresholdMs: SLOW_TOOL_WARN_MS,
                settled: false,
            });
        }, SLOW_TOOL_WARN_MS);
        watchdog.unref?.();
        let warnedInFlight = false;
        const stopWatchdog = () => {
            // `hasRef()` is false once the timer has fired, which is how the
            // settle-time line knows whether the in-flight one already went out
            // and can avoid reporting the same call twice.
            warnedInFlight = watchdog.hasRef ? !watchdog.hasRef() : false;
            clearTimeout(watchdog);
        };

        try {
            const result = await handler(args);
            stopWatchdog();
            const elapsed = durationMs();
            if (elapsed >= SLOW_TOOL_WARN_MS) {
                log.warn("tool.slow", {
                    ...outcomeFields(),
                    thresholdMs: SLOW_TOOL_WARN_MS,
                    settled: true,
                    alreadyWarned: warnedInFlight,
                });
            } else {
                log.info("tool.done", outcomeFields());
            }
            return result;
        } catch (err: any) {
            stopWatchdog();
            // Name the failure in the structured line too. Without this the log
            // says a call failed and the operator still has to go find the
            // separate console.error below to learn how.
            log.warn("tool.failed", {
                ...outcomeFields(),
                errName: err?.constructor?.name ?? "Error",
                errMessage: err?.message ?? String(err),
                causeCode: err?.cause?.code ?? null,
            });
            const name = err?.constructor?.name ?? "Error";
            const msg = err?.message ?? String(err);
            const cause = err?.cause;
            const causeStr = cause
                ? ` | cause: ${cause?.message ?? String(cause)}`
                : "";

            // Operator-side diagnostic — full chain to sidecar stderr.
            console.error(
                `[mcp.tool.error] tool=${tool} agentClient=${session.agentClient ?? ""} name=${name} msg=${msg}` +
                (cause
                    ? ` cause_name=${cause?.constructor?.name} cause_msg=${cause?.message} cause_code=${cause?.code}`
                    : "")
            );

            let prefix = "Tool error";
            switch (name) {
                case "MemWalRememberJobFailed":
                    prefix = "Walrus Memory job failed";
                    break;
                case "MemWalRememberJobTimeout":
                    prefix = "Walrus Memory job timed out";
                    break;
                case "MemWalRememberJobNotFound":
                    prefix = "Walrus Memory job not found";
                    break;
                case "MemWalError":
                    prefix = "Walrus Memory relayer error";
                    break;
            }

            return {
                content: [{ type: "text", text: `${prefix}: ${msg}${causeStr}` }],
                isError: true,
            };
        }
    };
}
