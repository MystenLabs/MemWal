import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { MemWalSession } from "../auth.js";
import { TOOL_METADATA } from "./annotations.js";
import { wrapTool, walruscanBlobUrl, explorerFooter } from "./util.js";
import {
    REMEMBER_POLL_INTERVAL_MS,
    isStillRunning,
    nameJobError,
    withAcceptDeadline,
    withWaitDeadline,
} from "./remember-wait.js";

/**
 * Ceiling on a single status wait, held under the MCP client's own deadline.
 *
 * `@modelcontextprotocol/sdk` times a request out after
 * `DEFAULT_REQUEST_TIMEOUT_MSEC` = 60s unless the caller overrides it. A tool
 * that waits the full 60s therefore loses every race it enters: the client
 * gives up first and the agent sees `MCP error -32001: Request timed out`
 * instead of the answer the tool was about to return. Confirmed live against
 * the production relayer — `waitMs: 60000` on a three-job batch returned
 * exactly that, with no way for the caller to tell a slow write from a broken
 * tool.
 *
 * 45s leaves room for the round trip and still covers the median write. A job
 * that outlives it is not lost: the job_id stays valid and the caller asks
 * again, which is the whole point of this tool being separate from the write.
 */
const MAX_STATUS_WAIT_MS = 45_000;

/** Wait applied when the caller does not choose one. Declared above
 * `STATUS_INPUT` because the tool description interpolates it. */
const DEFAULT_STATUS_WAIT_MS = 10_000;

/** Matches the bulk write cap, so a whole batch settles in one call. */
const MAX_STATUS_JOB_IDS = 20;

const STATUS_INPUT = {
    job_id: z
        .string()
        .min(1)
        .optional()
        .describe("The job_id returned by memwal_remember when the write had not landed yet."),
    job_ids: z
        .array(z.string().min(1))
        .min(1)
        .max(MAX_STATUS_JOB_IDS)
        .optional()
        .describe(
            "The job_ids returned by memwal_remember_bulk when the writes had not landed yet. Pass the whole batch in one call rather than polling each id separately. Supply either this or job_id."
        ),
    waitMs: z
        .number()
        .int()
        .min(0)
        .max(MAX_STATUS_WAIT_MS)
        .optional()
        .describe(
            `How long to wait for the job to finish, in milliseconds (0-${MAX_STATUS_WAIT_MS}, default ${DEFAULT_STATUS_WAIT_MS}). Pass 0 to read the current state without waiting.`
        ),
} as const;

/**
 * memwal_remember_status — resolve a remember job that `memwal_remember`
 * handed back as still in flight.
 *
 * This is the other half of the bounded wait: `memwal_remember` refuses to
 * claim a fact is saved when it isn't, so something has to be able to say
 * whether it landed. Three outcomes, kept distinct because an agent acts
 * differently on each — saved (blob_id), still running (ask again), failed
 * (the fact is NOT stored and must be re-sent).
 */
export function registerRememberStatusTool(
    server: McpServer,
    session: MemWalSession
): void {
    server.registerTool(
        "memwal_remember_status",
        {
            ...TOOL_METADATA.memwal_remember_status,
            description:
                "Check whether in-flight Walrus Memory writes have landed. Call this with the job_id memwal_remember returned, or job_ids from memwal_remember_bulk, when the write was reported NOT saved yet. Returns the blob_id once stored, reports that it is still uploading (call again with the ids still listed), or reports that it failed — in which case the fact was never stored and you should send it again. A batch can come back mixed, so read every line before telling the user anything is saved.",
            inputSchema: STATUS_INPUT,
        },
        wrapTool<{ job_id?: string; job_ids?: string[]; waitMs?: number }>(
            session,
            "memwal_remember_status",
            async ({ job_id, job_ids, waitMs }) => {
                const budget = waitMs ?? DEFAULT_STATUS_WAIT_MS;

                // Exactly one of the two. Enforced here rather than in the
                // schema because `registerTool` takes a raw shape, which has
                // nowhere to hang a cross-field refinement.
                const batch = job_ids ?? [];
                if (batch.length > 0 && job_id) {
                    throw new Error(
                        "Pass job_id or job_ids, not both — they would describe different writes."
                    );
                }
                if (batch.length > 0) return await settleBatch(session, batch, budget);
                if (!job_id) {
                    throw new Error(
                        "Pass job_id (from memwal_remember) or job_ids (from memwal_remember_bulk)."
                    );
                }

                // A zero budget means "read the current state", which is a
                // single GET. waitForRememberJob cannot express that: it
                // sleeps before its first poll, so a 0ms deadline would
                // return "still running" without ever asking the relayer.
                if (budget === 0) {
                    const status = await withAcceptDeadline(
                        session.memwal.getRememberStatus(job_id),
                        "status read",
                        { idempotent: true },
                    );
                    if (status.status === "done") {
                        return saved(status.blob_id ?? "", status.namespace);
                    }
                    if (status.status === "failed") {
                        throw nameJobError(
                            Object.assign(
                                new Error(
                                    `remember job failed: ${status.error ?? "unknown error"}`
                                ),
                                { status: 500, jobId: job_id }
                            )
                        );
                    }
                    if (status.status === "not_found") {
                        throw nameJobError(
                            Object.assign(
                                new Error(`remember job not found: ${job_id}`),
                                { status: 404, jobId: job_id }
                            )
                        );
                    }
                    return stillRunning(job_id, status.status);
                }

                try {
                    const result = await withWaitDeadline(
                        session.memwal.waitForRememberJob(job_id, {
                            timeoutMs: budget,
                            pollIntervalMs: REMEMBER_POLL_INTERVAL_MS,
                        }),
                        budget,
                    );
                    return saved(result.blob_id, result.namespace);
                } catch (err) {
                    if (isStillRunning(err)) return stillRunning(job_id);
                    throw nameJobError(err);
                }
            }
        )
    );
}

/**
 * Settle a batch of job_ids in one report.
 *
 * Unlike the single-job path this never throws on a failed job: a batch
 * routinely comes back mixed, and throwing on the first failure would hide the
 * blob_ids of the writes that did land — the agent would have no way to tell
 * which facts still need re-sending.
 */
async function settleBatch(
    session: MemWalSession,
    jobIds: string[],
    budgetMs: number
) {
    // A zero budget is a single batched read, the same shortcut the one-job
    // path takes: `waitForRememberJobs` sleeps before its first poll, so a 0ms
    // deadline would report everything as still running without ever asking.
    const rows =
        budgetMs === 0
            ? (
                  await withAcceptDeadline(
                      session.memwal.getRememberBulkStatus(jobIds),
                      "batch status read",
                      { idempotent: true },
                  )
              ).results.map((r) => ({
                  id: r.job_id,
                  status: r.status,
                  blob_id: r.blob_id ?? "",
                  error: r.error,
              }))
            : (
                  await withWaitDeadline(
                      session.memwal.waitForRememberJobs(jobIds, [], {
                          timeoutMs: budgetMs,
                          pollIntervalMs: REMEMBER_POLL_INTERVAL_MS,
                      }),
                      budgetMs,
                  )
              ).results.map((r) => ({
                  id: r.id,
                  status: r.status,
                  blob_id: r.blob_id,
                  error: r.error,
              }));

    // `timeout` (the waited path) and pending/running/uploaded (the immediate
    // read) are the same thing to a caller: still in flight, ask again.
    const inFlight = rows.filter(
        (r) => r.status !== "done" && r.status !== "failed" && r.status !== "not_found"
    );
    const failed = rows.filter((r) => r.status === "failed" || r.status === "not_found");
    const done = rows.filter((r) => r.status === "done");

    const lines = rows.map((r, i) => {
        const blob = r.blob_id ? ` blob_id=${r.blob_id}` : "";
        // `waitForRememberJobs` stamps "polling timed out after Nms" on rows
        // that simply had not landed when the budget ran out. That is our
        // clock expiring, not the job failing, so showing it as `error=` next
        // to "still uploading" reads like the write broke when it is still on
        // its way. Only a terminal row gets to explain itself.
        const terminal = r.status === "failed" || r.status === "not_found";
        const err = terminal && r.error ? ` error=${r.error}` : "";
        const state =
            r.status === "done"
                ? "saved"
                : r.status === "failed" || r.status === "not_found"
                  ? `NOT STORED (${r.status})`
                  : "still uploading";
        return `${i + 1}. [${state}] job_id=${r.id}${blob}${err}`;
    });

    const parts = [
        `${done.length}/${rows.length} saved` +
            (inFlight.length ? `, ${inFlight.length} still uploading` : "") +
            (failed.length ? `, ${failed.length} NOT stored` : "") +
            ".",
        lines.join("\n"),
    ];
    if (inFlight.length) {
        parts.push(
            `Still uploading — call memwal_remember_status again with job_ids=[${inFlight
                .map((r) => r.id)
                .join(", ")}]. Do not re-send those facts; that queues duplicates.`
        );
    }
    if (failed.length) {
        parts.push(
            `NOT stored — these facts were never saved and must be sent again with ` +
                `memwal_remember or memwal_remember_bulk.`
        );
    }
    if (done.length) parts.push(explorerFooter());

    return { content: [{ type: "text" as const, text: parts.join("\n\n") }] };
}

function saved(blobId: string, namespace?: string) {
    return {
        content: [
            {
                type: "text" as const,
                text:
                    `Saved to Walrus Memory. blob_id=${blobId}` +
                    (namespace ? ` namespace=${namespace}` : "") +
                    `\nExplorer: ${walruscanBlobUrl(blobId)}`,
            },
        ],
    };
}

function stillRunning(jobId: string, state?: string) {
    return {
        content: [
            {
                type: "text" as const,
                text:
                    `STILL UPLOADING — not saved yet${state ? ` (state: ${state})` : ""}.\n` +
                    `job_id=${jobId}\n` +
                    `The job is still queued or uploading. Call memwal_remember_status again ` +
                    `with this job_id. Do not re-send the fact with memwal_remember — that ` +
                    `queues a duplicate behind this one.`,
            },
        ],
    };
}
