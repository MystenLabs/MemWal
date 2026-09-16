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
    withRelayerRetry,
    withWaitDeadline,
    isStillRunning,
} from "./remember-wait.js";

const ANALYZE_INPUT = {
    text: z
        .string()
        .min(1)
        .describe(
            "Conversation transcript, note, or arbitrary text from which to extract memorable facts."
        ),
    namespace: z
        .string()
        .optional()
        .describe(
            "Optional namespace bucket for the extracted facts. Defaults to the session's namespace."
        ),
} as const;

/**
 * memwal_analyze — let Walrus Memory's LLM extract distinct facts from a piece
 * of text and persist each as its own memory.
 *
 * Returns once the relayer has extracted the facts and durably queued a write
 * for each, the same contract as `memwal_remember_bulk`.
 *
 * Blocking to terminal was left in place while the two remember tools moved to
 * a bounded wait, which made this the slowest tool in the set by a wide
 * margin: measured at 37.0s against dev after `memwal_remember` had dropped to
 * 0.2s there. The shape of the wait is the same as bulk's — N Walrus writes,
 * one upload per wallet — so there was no reason for the answer to be shaped
 * differently.
 *
 * Extraction itself is worth waiting for, and this still does: `analyze()`
 * resolves after the LLM has run, so the facts it found are in the reply.
 * Only the upload of those facts is handed back as job_ids.
 */
export function registerAnalyzeTool(
    server: McpServer,
    session: MemWalSession
): void {
    server.registerTool(
        "memwal_analyze",
        {
            ...TOOL_METADATA.memwal_analyze,
            description:
                "Extract memorable facts from a longer passage of text (preferences, habits, biographical info, constraints) and save each as a separate Walrus Memory memory. Use this when you want MemWal's LLM to split the facts out of a transcript or notes for you; if you already know the exact facts, use memwal_remember or memwal_remember_bulk instead. The extracted facts come back immediately; if the result says the writes are still in flight it carries job_ids — confirm them with memwal_remember_status rather than telling the user they are saved.",
            inputSchema: ANALYZE_INPUT,
        },
        wrapTool<{ text: string; namespace?: string }>(session, "memwal_analyze", async ({ text, namespace }) => {
            // `analyze` (not `analyzeAndWait`) returns once extraction is done
            // and every fact has a queued job, which is the point this tool can
            // usefully answer at.
            const accepted = await withAcceptDeadline(
                // Same reasoning as bulk: the retry only fires on rejections
                // that never reached the handler, so no job row can exist yet
                // to duplicate.
                withRelayerRetry(
                    () => session.memwal.analyze(text, namespace),
                    "analyze this text",
                ),
                "memwal_analyze extraction",
                // Not an accept. `/api/analyze` runs the extractor LLM inline
                // before it answers — which is why the SDK allows this call 60s
                // where it allows a remember 30s. The 15s accept ceiling would
                // have cut off healthy extraction on any transcript long enough
                // to be worth extracting from.
                { idempotent: false, deadlineMs: 60_000 },
            );

            const facts = accepted.facts ?? [];
            // Nothing to wait on, and nothing to confirm later. Say so plainly
            // rather than handing back an empty job list.
            if (accepted.job_ids.length === 0) {
                return {
                    content: [
                        {
                            type: "text" as const,
                            text: `Extracted 0 facts from that text — nothing was saved.`,
                        },
                    ],
                };
            }

            const entries = accepted.job_ids.map((jobId, i) => ({
                jobId,
                text: facts[i]?.text ?? "",
            }));

            // The extraction result is the part of this call an agent can act
            // on immediately, so it leads — the write status follows it.
            const extracted = `Extracted ${facts.length} fact(s):\n${entries
                .map((e, i) => `${i + 1}. ${e.text || "(unknown fact)"}`)
                .join("\n")}`;

            const pending = (waitedMs: number) => ({
                content: [
                    {
                        type: "text" as const,
                        text: `${extracted}\n\n${pendingBulkMessage(entries, waitedMs)}`,
                    },
                ],
            });

            if (REMEMBER_WAIT_MS === 0) return pending(0);

            const startedAt = Date.now();
            const namespaces = entries.map(
                () => namespace ?? session.namespace ?? "default"
            );
            // The wait is a courtesy; the accept above is the part that had to
            // succeed. If the relayer goes quiet mid-poll `withWaitDeadline`
            // raises MemWalRelayerUnresponsive, and letting that propagate
            // would discard both the job_ids and the extracted facts — the
            // caller would have no way to settle writes that are still running
            // and no way to get the extraction back without paying for it
            // again. `memwal_remember` already degrades this way; so does this.
            let result;
            try {
                result = await withWaitDeadline(
                    session.memwal.waitForRememberJobs(accepted.job_ids, namespaces, {
                        timeoutMs: REMEMBER_WAIT_MS,
                        pollIntervalMs: REMEMBER_POLL_INTERVAL_MS,
                    }),
                    REMEMBER_WAIT_MS,
                );
            } catch (err) {
                if (!isStillRunning(err)) throw err;
                return pending(Date.now() - startedAt);
            }
            const waitedMs = Date.now() - startedAt;

            const unfinished = result.results.filter((r) => r.status === "timeout");
            if (unfinished.length === result.results.length) return pending(waitedMs);

            const lines = result.results.map((r, i) => {
                // `timeout` is not a failure — the write is still running and
                // its job_id is how the caller settles it later. Rendered the
                // same way memwal_remember_bulk renders it.
                const state =
                    r.status === "timeout" ? `still uploading, job_id=${r.id}` : r.status;
                return `${i + 1}. [${state}]${r.blob_id ? ` blob_id=${r.blob_id}` : ""} ${
                    entries[i]?.text || "(unknown fact)"
                }`;
            });
            // `result.failed` is total-minus-succeeded, so it counts a
            // still-uploading write as failed — while the stragglers block
            // below tells the agent those same jobs are on their way and must
            // not be re-sent. An agent reading `failed=` re-sends an in-flight
            // write, which is a duplicate paid Walrus blob queued behind the
            // original. Count only what actually reached a terminal failure.
            // Same correction as remember-bulk.ts; this file was written from
            // the same template one commit earlier and missed it.
            const reallyFailed = result.results.filter(
                (r) => r.status !== "done" && r.status !== "timeout",
            ).length;
            const summary =
                `Extracted ${facts.length} fact(s) — succeeded=${result.succeeded}` +
                (reallyFailed ? ` failed=${reallyFailed}` : "") +
                (unfinished.length ? ` (${unfinished.length} still uploading)` : "");
            const stragglers =
                unfinished.length > 0
                    ? `\n\n${pendingBulkMessage(
                          result.results.flatMap((r, i) =>
                              r.status === "timeout"
                                  ? [{ jobId: r.id, text: entries[i]?.text ?? "" }]
                                  : [],
                          ),
                          waitedMs,
                      )}`
                    : "";
            const footer = result.succeeded > 0 ? `\n\n${explorerFooter()}` : "";
            return {
                content: [
                    {
                        type: "text" as const,
                        text: `${summary}\n\n${lines.join("\n")}${stragglers}${footer}`,
                    },
                ],
            };
        })
    );
}
