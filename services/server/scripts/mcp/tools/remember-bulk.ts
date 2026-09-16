import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { MemWalSession } from "../auth.js";
import { TOOL_METADATA } from "./annotations.js";
import { wrapTool, explorerFooter } from "./util.js";

const REMEMBER_BULK_INPUT = {
    facts: z
        .array(z.string().min(1))
        .min(1)
        .max(20)
        .describe(
            "Array of complete, detailed fact statements to save (1-20). Each entry is one full fact — do not summarize or merge them."
        ),
    namespace: z
        .string()
        .optional()
        .describe(
            "Optional namespace bucket applied to every fact. Defaults to the session's namespace when omitted."
        ),
} as const;

/**
 * memwal_remember_bulk — persist several durable facts in one batched request
 * and return only once every job reaches a terminal state. Wraps the SDK's
 * `rememberBulkAndWait` (embed + SEAL-encrypt all items concurrently, upload
 * N blobs in parallel). Prefer this over N separate `memwal_remember` calls
 * when you learned multiple distinct facts at once.
 */
/**
 * Summarise a bulk save without repeating the SDK's conflation.
 *
 * `RememberBulkResult.failed` is documented as "Count of items that failed or
 * timed out", and it is computed as `total - succeeded`. A timeout is not a
 * failure: the relayer answers `/api/remember/bulk` with HTTP 202 and finishes
 * the work in a durable queue, so a client-side deadline cancels nothing and
 * those items routinely land minutes later. Reported as `failed=N`, that reads
 * as data loss, and the obvious response — save them again — buys a second paid
 * blob, because `/api/remember/bulk` carries no idempotency key.
 *
 * Observed on dev: a bulk reported `failed=1` while `memwal_recall` found all
 * five facts present.
 *
 * `results[].status` keeps the real label, so count from that instead. An
 * unfinished item is named as unfinished, carries its job id so the agent has a
 * handle, and is explicitly not something to re-save.
 */
export function summariseBulk(result: {
    results: { status: string; id?: string }[];
    total: number;
    succeeded: number;
    failed: number;
}): string {
    const byStatus = (want: string) =>
        result.results.filter((r) => r.status === want);
    // Fall back to the SDK's numbers only if `results` is missing or short —
    // never silently disagree with it about the total.
    if (result.results.length !== result.total) {
        return `Saved ${result.succeeded}/${result.total} fact(s) to Walrus Memory (failed=${result.failed}).`;
    }
    const done = byStatus("done").length;
    const failed = byStatus("failed").length;
    const pending = result.results.filter(
        (r) => r.status !== "done" && r.status !== "failed",
    );

    let out = `Saved ${done}/${result.total} fact(s) to Walrus Memory.`;
    if (failed > 0) out += ` ${failed} failed.`;
    if (pending.length > 0) {
        const ids = pending
            .map((r) => r.id)
            .filter(Boolean)
            .join(", ");
        out +=
            ` ${pending.length} still finishing — the relayer accepted them and a timeout here` +
            " does not cancel the write, so do NOT save them again: that stores a second paid" +
            " copy. Check with `memwal_recall` in a minute" +
            (ids ? `, or track job ${ids}.` : ".");
    }
    return out;
}

export function registerRememberBulkTool(
    server: McpServer,
    session: MemWalSession
): void {
    server.registerTool(
        "memwal_remember_bulk",
        {
            ...TOOL_METADATA.memwal_remember_bulk,
            description:
                "Save multiple durable facts in one call. Use when you learned several distinct facts at once (onboarding details, a list of preferences, decisions from a discussion). Pass an array of complete fact statements (max 20) — do not summarize. Prefer this over repeated memwal_remember calls.",
            inputSchema: REMEMBER_BULK_INPUT,
        },
        wrapTool<{ facts: string[]; namespace?: string }>(session, "memwal_remember_bulk", async ({ facts, namespace }) => {
            const items = facts.map((text) => ({ text, namespace }));
            const result = await session.memwal.rememberBulkAndWait(items, {
                timeoutMs: 120_000,
            });
            const lines = result.results.map((r, i) => {
                // Label each result with its source fact by index. The SDK
                // returns results in input order, but guard against a length /
                // ordering mismatch so we never print "— undefined".
                const text = facts[i] ?? "";
                const blob = r.blob_id ? ` blob_id=${r.blob_id}` : "";
                const err = r.error ? ` error=${r.error}` : "";
                return `${i + 1}. [${r.status}]${blob}${err}${text ? ` — ${text}` : ""}`;
            });
            const summary = summariseBulk(result);
            const footer = result.succeeded > 0 ? `\n\n${explorerFooter()}` : "";
            return {
                content: [
                    {
                        type: "text",
                        text:
                            lines.length > 0
                                ? `${summary}\n\n${lines.join("\n")}${footer}`
                                : `${summary}${footer}`,
                    },
                ],
            };
        })
    );
}
