/**
 * Shared helpers for tool implementations.
 */

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
