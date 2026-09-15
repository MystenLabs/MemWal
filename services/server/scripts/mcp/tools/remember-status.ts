import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { MemWalSession } from "../auth.js";
import { TOOL_METADATA } from "./annotations.js";
import { wrapTool, walruscanBlobUrl } from "./util.js";

/** `waitForRememberJob` rejects with 504 when its deadline passes with the job
 * still running, and 500 when the job itself failed. Neither is a distinct
 * error class in any shipped SDK line, so the status code is the only stable
 * discriminator. */
const JOB_STILL_RUNNING_STATUS = 504;
const JOB_FAILED_STATUS = 500;

/** Default settle window. Short: this tool answers "did it land yet", and an
 * agent that wants to keep waiting can just call it again. */
const DEFAULT_WAIT_SECONDS = 2;
const MAX_WAIT_SECONDS = 30;

const REMEMBER_STATUS_INPUT = {
    job_id: z
        .string()
        .min(1)
        .describe(
            "The job_id returned by memwal_remember when the write was still in flight."
        ),
    wait_seconds: z
        .number()
        .int()
        .min(0)
        .max(MAX_WAIT_SECONDS)
        .optional()
        .describe(
            `How long to wait for the job to settle before answering (default ${DEFAULT_WAIT_SECONDS}s, max ${MAX_WAIT_SECONDS}s). Use 0 for an immediate answer.`
        ),
} as const;

/**
 * memwal_remember_status — resolve a `memwal_remember` job that had not
 * finished when the tool returned.
 *
 * This is the other half of the fast-return path in `remember.ts`. That tool
 * stops waiting once the write is durably accepted, which means a job can
 * still fail afterwards — a Walrus upload or SEAL encrypt outage lands the job
 * in `failed`, long after the agent was told it was accepted. Without a way to
 * ask after the fact, returning early would turn a slow write into a silently
 * lost one.
 *
 * `waitForRememberJob` already encodes the outcomes an agent has to tell apart,
 * so this tool leans on it rather than re-deriving them: it resolves at `done`,
 * and otherwise rejects with a plain Error carrying a `status` — 500 when the
 * job failed, 504 when only our wait ran out and the job is still going. The
 * SDK ships no dedicated error classes for these, so `status` is what we match
 * on; a constructor-name check silently never fires.
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
                "Check whether an in-flight memwal_remember job finished. Call this with the job_id from a memwal_remember result that came back still writing, when you need to confirm the fact was actually stored. Returns the blob_id once stored, an error if the write failed, or tells you it is still running.",
            inputSchema: REMEMBER_STATUS_INPUT,
        },
        wrapTool<{ job_id: string; wait_seconds?: number }>(
            session,
            "memwal_remember_status",
            async ({ job_id, wait_seconds }) => {
                const waitSeconds = Math.min(
                    wait_seconds ?? DEFAULT_WAIT_SECONDS,
                    MAX_WAIT_SECONDS
                );
                try {
                    const result = await session.memwal.waitForRememberJob(
                        job_id,
                        // Floor at one poll: a zero deadline would expire
                        // before the first status read and report "still
                        // running" without ever having asked.
                        { timeoutMs: Math.max(250, waitSeconds * 1000) }
                    );
                    return {
                        content: [
                            {
                                type: "text",
                                text: `Stored. job_id=${job_id} blob_id=${result.blob_id} namespace=${result.namespace}\nExplorer: ${walruscanBlobUrl(result.blob_id)}`,
                            },
                        ],
                    };
                } catch (err: any) {
                    // Still running is the expected answer here, not a failure.
                    if (err?.status === JOB_STILL_RUNNING_STATUS) {
                        return {
                            content: [
                                {
                                    type: "text",
                                    text: `Still writing after ${waitSeconds}s. job_id=${job_id}. Check again shortly; do not tell the user it is saved yet.`,
                                },
                            ],
                        };
                    }
                    // A terminal failure is the case this tool exists for, so
                    // it is named plainly rather than left to the generic
                    // "Tool error" prefix: the fact was NOT stored.
                    if (err?.status === JOB_FAILED_STATUS) {
                        return {
                            content: [
                                {
                                    type: "text",
                                    text: `Walrus Memory job failed: job_id=${job_id} was not stored — ${err?.message ?? "unknown error"}. The fact is NOT in memory; save it again.`,
                                },
                            ],
                            isError: true,
                        };
                    }
                    throw err;
                }
            }
        )
    );
}
