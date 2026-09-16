import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { MemWalSession } from "../auth.js";
import { TOOL_METADATA } from "./annotations.js";
import { wrapTool, walruscanBlobUrl } from "./util.js";
import {
    REMEMBER_WAIT_MS,
    REMEMBER_POLL_INTERVAL_MS,
    isStillRunning,
    nameJobError,
    pendingMessage,
    withAcceptDeadline,
    withWaitDeadline,
    withRelayerRetry,
    derivedIdempotencyKey,
} from "./remember-wait.js";

const REMEMBER_INPUT = {
    text: z
        .string()
        .min(1)
        .describe(
            "The full, detailed fact to save. Pass the COMPLETE statement — do not summarize."
        ),
    namespace: z
        .string()
        .optional()
        .describe(
            "Optional namespace bucket. Defaults to the session's namespace when omitted."
        ),
} as const;

/**
 * memwal_remember — persist a durable fact to MemWal.
 *
 * Returns as soon as the blob is written end-to-end (embed → SEAL encrypt →
 * Walrus upload → on-chain) when that happens inside `REMEMBER_WAIT_MS`.
 * Otherwise it returns the job_id and says plainly that the fact is not saved
 * yet — see `remember-wait.ts` for why the old always-block behaviour cost
 * 30–75s per call.
 *
 * Call this PROACTIVELY whenever the user reveals a durable fact about
 * themselves or the project (preference, decision, constraint, correction,
 * identity, recurring workflow) — you do not need to be explicitly asked.
 * Skip one-off tasks, the current file or bug, and small talk.
 * For several facts at once, prefer `memwal_remember_bulk`.
 */
export function registerRememberTool(
    server: McpServer,
    session: MemWalSession
): void {
    server.registerTool(
        "memwal_remember",
        {
            ...TOOL_METADATA.memwal_remember,
            description:
                "Save a durable fact about the user or project to their Walrus Memory. Call this PROACTIVELY whenever the user states a preference, decision, constraint, correction, identity detail, or recurring workflow — even if they did not say 'remember this'. Skip one-off tasks, the current file or bug, and small talk. Pass the full statement; do not summarize. To save several facts at once, use memwal_remember_bulk instead. A Walrus write takes 30-60s and this call waits for it, so a success carries a blob_id and means the fact is stored. If it outruns that budget you get a job_id and the fact is NOT yet saved — say so rather than claiming it is stored, and resolve it with memwal_remember_status.",
            inputSchema: REMEMBER_INPUT,
        },
        wrapTool<{ text: string; namespace?: string }>(session, "memwal_remember", async ({ text, namespace }) => {
            // Two steps rather than `rememberAndWait`, because the accept and
            // the wait need separate budgets: acceptance is the part that
            // must succeed, the wait is a courtesy we cut short.
            const accepted = await withAcceptDeadline(
                withRelayerRetry(
                    () =>
                        session.memwal.rememberAsync(text, namespace, {
                            // Ours, not the SDK's random one — see
                            // derivedIdempotencyKey. This is what makes the
                            // accept-timeout message's retry promise true.
                            idempotencyKey: derivedIdempotencyKey(namespace, text),
                        }),
                    "save this fact",
                ),
                "memwal_remember write",
                { idempotent: true },
            );

            const pending = (waitedMs: number) => ({
                content: [
                    {
                        type: "text" as const,
                        text: pendingMessage(accepted.job_id, waitedMs),
                    },
                ],
            });

            // A zero budget is the documented fire-and-accept mode. Skip the
            // wait entirely instead of entering a loop that cannot poll.
            if (REMEMBER_WAIT_MS === 0) return pending(0);

            const startedAt = Date.now();
            try {
                const result = await withWaitDeadline(
                    session.memwal.waitForRememberJob(accepted.job_id, {
                        timeoutMs: REMEMBER_WAIT_MS,
                        pollIntervalMs: REMEMBER_POLL_INTERVAL_MS,
                    }),
                    REMEMBER_WAIT_MS,
                );
                return {
                    content: [
                        {
                            type: "text" as const,
                            text: `Saved to Walrus Memory. blob_id=${result.blob_id} namespace=${result.namespace}\nExplorer: ${walruscanBlobUrl(result.blob_id)}`,
                        },
                    ],
                };
            } catch (err) {
                // Still running at the deadline is the expected path, not a
                // failure — the job is durably accepted and keeps going.
                if (isStillRunning(err)) return pending(Date.now() - startedAt);
                throw nameJobError(err);
            }
        })
    );
}
