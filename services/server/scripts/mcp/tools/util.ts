/**
 * Shared helpers for tool implementations.
 */

interface ToolResultLike {
    [x: string]: unknown;
    content: Array<{ type: "text"; text: string; [x: string]: unknown }>;
    isError?: boolean;
}

/**
 * Wrap a tool handler so any thrown error is surfaced to the MCP client as
 * an `isError: true` envelope instead of leaking the raw exception.
 *
 * Known error names we map to a specific prefix so agents can route on the
 * class without parsing the message:
 *     MemWalRememberJobFailed  → "MemWal job failed"
 *     MemWalRememberJobTimeout → "MemWal job timed out"
 *     MemWalRememberJobNotFound→ "MemWal job not found"
 *     MemWalError              → "MemWal relayer error"
 * Anything else propagates under "Tool error:".
 *
 * The underlying Error.cause (if present, e.g. Node's `TypeError("fetch
 * failed")`) is logged to sidecar stderr for operators and appended to the
 * client-facing message so the agent has enough context to act.
 */
export function wrapTool<Args>(
    handler: (args: Args) => Promise<ToolResultLike>
): (args: Args) => Promise<ToolResultLike> {
    return async (args) => {
        try {
            return await handler(args);
        } catch (err: any) {
            const name = err?.constructor?.name ?? "Error";
            const msg = err?.message ?? String(err);
            const cause = err?.cause;
            const causeStr = cause
                ? ` | cause: ${cause?.message ?? String(cause)}`
                : "";

            // Operator-side diagnostic — full chain to sidecar stderr.
            console.error(
                `[mcp.tool.error] name=${name} msg=${msg}` +
                    (cause
                        ? ` cause_name=${cause?.constructor?.name} cause_msg=${cause?.message} cause_code=${cause?.code}`
                        : "")
            );

            let prefix = "Tool error";
            switch (name) {
                case "MemWalRememberJobFailed":
                    prefix = "MemWal job failed";
                    break;
                case "MemWalRememberJobTimeout":
                    prefix = "MemWal job timed out";
                    break;
                case "MemWalRememberJobNotFound":
                    prefix = "MemWal job not found";
                    break;
                case "MemWalError":
                    prefix = "MemWal relayer error";
                    break;
            }

            return {
                content: [{ type: "text", text: `${prefix}: ${msg}${causeStr}` }],
                isError: true,
            };
        }
    };
}
