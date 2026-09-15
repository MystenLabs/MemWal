import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { MemWalSession } from "../auth.js";
import { TOOL_METADATA } from "./annotations.js";
import { wrapTool, walruscanBlobUrl } from "./util.js";

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
 * `waitForRememberJob` already encodes the three outcomes an agent has to tell
 * apart, so this tool leans on it rather than re-deriving them: it resolves at
 * `done`, throws `MemWalRememberJobFailed` / `MemWalRememberJobNotFound` for
 * the terminal bad cases (mapped to an error envelope by `wrapTool`), and
 * throws `MemWalRememberJobTimeout` while the job is simply still running —
 * the one case that is not an error here.
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
                    // Still running is the expected answer, not a failure.
                    // Everything else — failed, not_found, transport — is a
                    // real error and propagates to wrapTool's mapping, which
                    // already names those classes for the agent.
                    if (err?.constructor?.name === "MemWalRememberJobTimeout") {
                        return {
                            content: [
                                {
                                    type: "text",
                                    text: `Still writing after ${waitSeconds}s. job_id=${job_id}. Check again shortly; do not tell the user it is saved yet.`,
                                },
                            ],
                        };
                    }
                    throw err;
                }
            }
        )
    );
}
