import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { MemWalSession } from "../auth.js";
import { TOOL_METADATA } from "./annotations.js";
import { wrapTool, walruscanBlobUrl } from "./util.js";
import { createLogger } from "../logger.js";

const log = createLogger("mcp");

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
 * How long `memwal_remember` waits for the write to finish before handing the
 * agent a job id instead.
 *
 * The write itself is a background job (`pending` → `running` → `uploaded` →
 * `done`). Blocking to `done` used to be the whole tool, which made a healthy
 * save cost as much as the slowest step in that pipeline — measured at 30-75s
 * against production, dominated by the Walrus upload phase. Almost none of
 * that time tells the agent anything it can act on: the job is already durably
 * accepted a second or so in.
 *
 * So this is a deadline for the *answer*, not for the write. The job keeps
 * running past it either way; the only question is whether the tool stays
 * parked. `memwal_remember_status` resolves the ones that run long.
 *
 * Set to `0` to always return as soon as the job is accepted. Set it to the
 * old `90000` to restore the previous always-block behaviour.
 */
const DEFAULT_REMEMBER_WAIT_MS = 10_000;

/** `waitForRememberJob` rejects with this HTTP status when the deadline passes
 * without the job settling. The job itself is still running; only the wait
 * ended. A genuinely failed job rejects with 500 instead. */
const JOB_STILL_RUNNING_STATUS = 504;

/** Hard ceiling — the relayer's own remember deadline. Waiting past it cannot
 * observe anything the job has not already settled. */
const MAX_REMEMBER_WAIT_MS = 90_000;

const REMEMBER_WAIT_MS = (() => {
    const raw = process.env.MEMWAL_MCP_REMEMBER_WAIT_MS;
    if (raw === undefined || raw.trim() === "") return DEFAULT_REMEMBER_WAIT_MS;
    const parsed = Number(raw);
    // Zero is meaningful here (return at accept), so it is allowed while every
    // other unusable value falls back rather than silently disabling the wait.
    if (!Number.isFinite(parsed) || parsed < 0) {
        log.warn("remember.wait_ms_invalid", {
            value: raw,
            usingMs: DEFAULT_REMEMBER_WAIT_MS,
        });
        return DEFAULT_REMEMBER_WAIT_MS;
    }
    return Math.min(parsed, MAX_REMEMBER_WAIT_MS);
})();

/**
 * memwal_remember — persist a durable fact to MemWal.
 *
 * Returns once the write is durably accepted by the relayer, waiting up to
 * `MEMWAL_MCP_REMEMBER_WAIT_MS` for it to finish so the common fast case still
 * comes back with a `blob_id`. A job that outlives that window is reported as
 * still writing, with its `job_id`, and is resolved by
 * `memwal_remember_status` — the job is NOT abandoned.
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
                "Save a durable fact about the user or project to their Walrus Memory. Call this PROACTIVELY whenever the user states a preference, decision, constraint, correction, identity detail, or recurring workflow — even if they did not say 'remember this'. Skip one-off tasks, the current file or bug, and small talk. Pass the full statement; do not summarize. To save several facts at once, use memwal_remember_bulk instead. If the result says the write is still in flight, it carries a job_id — confirm it later with memwal_remember_status rather than telling the user it is saved.",
            inputSchema: REMEMBER_INPUT,
        },
        wrapTool<{ text: string; namespace?: string }>(session, "memwal_remember", async ({ text, namespace }) => {
            const accepted = await session.memwal.rememberAsync(text, namespace);

            const stillWriting = () => {
                log.info("remember.returned_in_flight", {
                    jobId: accepted.job_id,
                    waitedMs: REMEMBER_WAIT_MS,
                    accountId: session.accountId ?? null,
                });
                return {
                    content: [
                        {
                            type: "text" as const,
                            text:
                                `Accepted by Walrus Memory and still writing. job_id=${accepted.job_id}` +
                                `${namespace ? ` namespace=${namespace}` : ""}\n` +
                                (REMEMBER_WAIT_MS === 0
                                    ? "The tool did not wait for the write, so there is no blob_id yet. "
                                    : `The write did not finish within ${Math.round(REMEMBER_WAIT_MS / 1000)}s, so there is no blob_id yet. `) +
                                `Do not tell the user it is saved — confirm with memwal_remember_status(job_id="${accepted.job_id}").`,
                        },
                    ],
                };
            };

            if (REMEMBER_WAIT_MS === 0) return stillWriting();

            try {
                const result = await session.memwal.waitForRememberJob(
                    accepted.job_id,
                    { timeoutMs: REMEMBER_WAIT_MS }
                );
                return {
                    content: [
                        {
                            type: "text" as const,
                            text: `Saved to Walrus Memory. blob_id=${result.blob_id} namespace=${result.namespace}\nExplorer: ${walruscanBlobUrl(result.blob_id)}`,
                        },
                    ],
                };
            } catch (err: any) {
                // Only our own wait expiring is a non-failure. The SDK signals
                // that as a plain Error carrying `status: 504` (a failed job
                // carries 500) — it has no dedicated error class, in either the
                // pinned 0.0.x or the current 0.1.x line, so matching on a
                // constructor name would never fire and every slow write would
                // surface as an error.
                if (err?.status === JOB_STILL_RUNNING_STATUS) {
                    return stillWriting();
                }
                throw err;
            }
        })
    );
}
