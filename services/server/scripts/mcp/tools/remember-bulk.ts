import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { MemWalSession } from "../auth.js";
import { TOOL_METADATA } from "./annotations.js";
import { wrapTool, explorerFooter } from "./util.js";
import {
    REMEMBER_POLL_INTERVAL_MS,
    REMEMBER_WAIT_MS,
    pendingBulkMessage,
    withAcceptDeadline,
    withWaitDeadline,
    withRelayerRetry,
} from "./remember-wait.js";

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
 * memwal_remember_bulk — persist several durable facts in one batched request.
 *
 * Mirrors `memwal_remember`: returns once every job reaches a terminal state
 * if that happens inside `REMEMBER_WAIT_MS`, and otherwise hands back the
 * job_ids saying plainly that the facts are not saved yet.
 *
 * Blocking here was worse than blocking on a single fact, not better. The
 * server instructions steer an agent to this tool whenever it learned more
 * than one thing, so it is the common path — and a batch is N separate Walrus
 * writes contending for the same upload slots
 * (`WALRUS_UPLOAD_PER_WALLET_CONCURRENCY` defaults to 1), so they land one
 * after another rather than together. Against a 30–75s single-write spread a
 * five-fact batch could exhaust the old fixed 120s budget outright and return
 * nothing but timeouts, having blocked the agent for two minutes first.
 */
export function registerRememberBulkTool(
    server: McpServer,
    session: MemWalSession
): void {
    server.registerTool(
        "memwal_remember_bulk",
        {
            ...TOOL_METADATA.memwal_remember_bulk,
            description:
                "Save multiple durable facts in one call. Use when you learned several distinct facts at once (onboarding details, a list of preferences, decisions from a discussion). Pass an array of complete fact statements (max 20) — do not summarize. Prefer this over repeated memwal_remember calls. A Walrus write takes 30-60s and this call waits for them, so a success carries blob_ids and means the facts are stored. If they outrun that budget you get job_ids and the facts are NOT yet saved — say they are being saved rather than stored, and resolve them with memwal_remember_status.",
            inputSchema: REMEMBER_BULK_INPUT,
        },
        wrapTool<{ facts: string[]; namespace?: string }>(session, "memwal_remember_bulk", async ({ facts, namespace }) => {
            const items = facts.map((text) => ({ text, namespace }));
            // Two steps rather than `rememberBulkAndWait`, for the same reason
            // `memwal_remember` splits them: acceptance is the part that must
            // succeed, the wait is a courtesy we cut short.
            const accepted = await withAcceptDeadline(
                // Safe to wrap despite bulk having no idempotency key: the
                // retry only fires on rejections that never reached the
                // handler, so no job row can exist to duplicate.
                withRelayerRetry(
                    () => session.memwal.rememberBulkAsync(items),
                    "save these facts",
                ),
                "memwal_remember_bulk batch",
                { idempotent: false },
            );

            // Pair each job with its fact up front. Every later branch needs
            // it, and the relayer returns job_ids in input order.
            const entries = accepted.job_ids.map((jobId, i) => ({
                jobId,
                text: facts[i] ?? "",
            }));

            const pending = (waitedMs: number) => ({
                content: [
                    {
                        type: "text" as const,
                        text: pendingBulkMessage(entries, waitedMs),
                    },
                ],
            });

            if (REMEMBER_WAIT_MS === 0) return pending(0);

            const startedAt = Date.now();
            const namespaces = items.map(
                (item) => item.namespace ?? session.namespace ?? "default"
            );
            // Unlike `waitForRememberJob`, this never throws on expiry — it
            // reports the stragglers as `timeout` per item, so a batch can come
            // back part landed and part still in flight.
            const result = await withWaitDeadline(
                session.memwal.waitForRememberJobs(accepted.job_ids, namespaces, {
                    timeoutMs: REMEMBER_WAIT_MS,
                    pollIntervalMs: REMEMBER_POLL_INTERVAL_MS,
                }),
                REMEMBER_WAIT_MS,
            );
            const waitedMs = Date.now() - startedAt;

            const unfinished = result.results.flatMap((r, i) =>
                r.status === "timeout" ? [{ jobId: r.id, text: facts[i] ?? "" }] : []
            );
            // Nothing landed inside the budget — the ordinary outcome when the
            // queue is busy. Say so once rather than printing N timeout rows.
            if (unfinished.length === result.results.length) return pending(waitedMs);

            const lines = result.results.map((r, i) => {
                // Label each result with its source fact by index. The SDK
                // returns results in input order, but guard against a length /
                // ordering mismatch so we never print "— undefined".
                const text = facts[i] ?? "";
                const blob = r.blob_id ? ` blob_id=${r.blob_id}` : "";
                const err = r.error ? ` error=${r.error}` : "";
                // `timeout` is not a failure — the write is still running and
                // its job_id is how the caller settles it later.
                const state = r.status === "timeout" ? `still uploading, job_id=${r.id}` : r.status;
                return `${i + 1}. [${state}]${blob}${err}${text ? ` — ${text}` : ""}`;
            });
            const summary = `Saved ${result.succeeded}/${result.total} fact(s) to Walrus Memory (failed=${result.failed}).`;
            const footer = result.succeeded > 0 ? `\n\n${explorerFooter()}` : "";
            const tail = unfinished.length
                ? `\n\n${unfinished.length} write(s) are STILL UPLOADING and are NOT saved yet. ` +
                  `Do not claim those facts are stored; resolve them with memwal_remember_status ` +
                  `using job_ids=[${unfinished.map((u) => u.jobId).join(", ")}]. Do not re-send ` +
                  `them — that queues duplicates behind the originals.`
                : "";
            return {
                content: [
                    {
                        type: "text",
                        text:
                            (lines.length > 0
                                ? `${summary}\n\n${lines.join("\n")}${footer}`
                                : `${summary}${footer}`) + tail,
                    },
                ],
            };
        })
    );
}
