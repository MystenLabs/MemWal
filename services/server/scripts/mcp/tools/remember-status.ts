import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { MemWalSession } from "../auth.js";
import { TOOL_METADATA } from "./annotations.js";
import { wrapTool, walruscanBlobUrl } from "./util.js";
import {
    REMEMBER_POLL_INTERVAL_MS,
    isStillRunning,
    nameJobError,
} from "./remember-wait.js";

/**
 * Ceiling on a single status wait. Past this an MCP client is more likely to
 * time out the call than the job is to finish, and the caller can simply ask
 * again — the job_id stays valid.
 */
const MAX_STATUS_WAIT_MS = 60_000;

const STATUS_INPUT = {
    job_id: z
        .string()
        .min(1)
        .describe("The job_id returned by memwal_remember when the write had not landed yet."),
    waitMs: z
        .number()
        .int()
        .min(0)
        .max(MAX_STATUS_WAIT_MS)
        .optional()
        .describe(
            "How long to wait for the job to finish, in milliseconds (0-60000, default 10000). Pass 0 to read the current state without waiting."
        ),
} as const;

/** Wait applied when the caller does not choose one. */
const DEFAULT_STATUS_WAIT_MS = 10_000;

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
                "Check whether an in-flight memwal_remember write has landed. Call this with the job_id memwal_remember returned when it reported the fact was NOT saved yet. Returns the blob_id once stored, reports that it is still uploading (call again), or reports that it failed — in which case the fact was never stored and you should send it again with memwal_remember.",
            inputSchema: STATUS_INPUT,
        },
        wrapTool<{ job_id: string; waitMs?: number }>(
            session,
            "memwal_remember_status",
            async ({ job_id, waitMs }) => {
                const budget = waitMs ?? DEFAULT_STATUS_WAIT_MS;

                // A zero budget means "read the current state", which is a
                // single GET. waitForRememberJob cannot express that: it
                // sleeps before its first poll, so a 0ms deadline would
                // return "still running" without ever asking the relayer.
                if (budget === 0) {
                    const status = await session.memwal.getRememberStatus(job_id);
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
                    const result = await session.memwal.waitForRememberJob(job_id, {
                        timeoutMs: budget,
                        pollIntervalMs: REMEMBER_POLL_INTERVAL_MS,
                    });
                    return saved(result.blob_id, result.namespace);
                } catch (err) {
                    if (isStillRunning(err)) return stillRunning(job_id);
                    throw nameJobError(err);
                }
            }
        )
    );
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
