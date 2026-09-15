/**
 * Shared wait-budget and job-error handling for the two remember tools.
 *
 * `memwal_remember` used to block on `rememberAndWait` until the write reached
 * `done`. Measured against the production relayer that is 30–75s for a single
 * short fact, and the agent can do nothing with the wait: the job is durably
 * accepted ~1s in, and everything after that is upload queue time
 * (`WALRUS_UPLOAD_PER_WALLET_CONCURRENCY` defaults to 1, so a second write
 * waits for the first).
 *
 * So the tool now waits a bounded budget and then hands the caller a job_id.
 * It does NOT claim the fact is saved when it isn't — a job can still fail
 * after acceptance (one observed failure: "Memory encryption backend is
 * unavailable" 31.6s in, from the SEAL sidecar being unreachable).
 */
import { createLogger } from "../logger.js";

const log = createLogger("mcp");

/**
 * Default wait before `memwal_remember` hands back a job_id.
 *
 * Zero — the tool returns at accept (~1.1s measured). A non-zero budget below
 * the real completion time is the worst of both: against the measured 30–75s
 * distribution a 10s wait still lands in the pending branch on nearly every
 * call, so the caller pays the 10s AND gets no guarantee. Either wait long
 * enough to actually mean it (set this to 90000) or don't wait at all.
 *
 * What makes returning at accept safe from disconnects: the job is a row in
 * `remember_jobs` driven by the relayer (`spawn_persisted_remember_preparation`
 * in services/server/src/routes/remember.rs), not work held in this process.
 * Closing the client does not cancel it.
 *
 * What it is NOT safe from: a job that fails after acceptance. Nothing here
 * can catch that — only a later `memwal_remember_status` call can.
 */
const DEFAULT_REMEMBER_WAIT_MS = 0;

/**
 * Hard ceiling on the wait budget. 90s matches the timeout the tool used
 * while it still blocked to terminal, so an operator can restore the old
 * always-block behaviour but cannot push the call past what MCP clients
 * are willing to wait for.
 */
const MAX_REMEMBER_WAIT_MS = 90_000;

/**
 * How long `memwal_remember` waits for the write to land before returning a
 * job_id instead. `0` returns at accept (~1s).
 *
 * Read once — it cannot change mid-process — but validated, because a typo'd
 * value must not silently pick a wait nobody asked for. `Number.parseInt`
 * alone accepts "10s" as 10 (a 10ms wait, effectively fire-and-forget) and
 * yields NaN for "" or "abc", and every NaN comparison is false.
 */
export function parseWaitBudget(raw: string | undefined): number {
    if (raw === undefined || raw.trim() === "") return DEFAULT_REMEMBER_WAIT_MS;
    const parsed = Number(raw);
    if (!Number.isFinite(parsed) || parsed < 0) {
        log.warn("remember.wait_budget_invalid", {
            value: raw,
            usingMs: DEFAULT_REMEMBER_WAIT_MS,
        });
        return DEFAULT_REMEMBER_WAIT_MS;
    }
    if (parsed > MAX_REMEMBER_WAIT_MS) {
        log.warn("remember.wait_budget_clamped", {
            value: raw,
            usingMs: MAX_REMEMBER_WAIT_MS,
        });
        return MAX_REMEMBER_WAIT_MS;
    }
    return Math.floor(parsed);
}

export const REMEMBER_WAIT_MS = parseWaitBudget(
    process.env.MEMWAL_MCP_REMEMBER_WAIT_MS
);

/**
 * Poll interval for a bounded wait.
 *
 * `waitForRememberJob` sleeps BEFORE its first poll and defaults to 1500ms
 * with 1.5^attempt backoff, which spends a 10s budget on ~5 polls and can
 * miss a write that landed at 1.2s. 400ms catches the fast case while
 * staying far below the relayer's 60 weighted-requests/min delegate-key
 * limit — the backoff reaches ~6 polls in 10s, not 25.
 */
export const REMEMBER_POLL_INTERVAL_MS = 400;

/**
 * `waitForRememberJob` signals outcome through `status` on a plain Error:
 * 504 = still running at the deadline, 500 = the job failed, 404 = no such
 * job. Only 504 is a non-error for us — the write is still in flight and the
 * caller gets a job_id to resolve later.
 */
export function isStillRunning(err: unknown): boolean {
    return (err as { status?: number } | null)?.status === 504;
}

/**
 * Give a job error the name `wrapTool` routes on, so the agent can tell a
 * failed write from a missing one without parsing the message. The SDK throws
 * an unnamed Error with a status code; `wrapTool` cannot classify that.
 */
export function nameJobError(err: unknown): unknown {
    if (!(err instanceof Error)) return err;
    const status = (err as { status?: number }).status;
    if (status === 500) err.name = "MemWalRememberJobFailed";
    else if (status === 404) err.name = "MemWalRememberJobNotFound";
    else if (status === 504) err.name = "MemWalRememberJobTimeout";
    return err;
}

/**
 * The line shown when a write is accepted but has not landed inside the wait
 * budget. Worded so an agent cannot read it as success: the fact is NOT saved
 * yet, and there is exactly one way to find out whether it lands.
 */
export function pendingMessage(jobId: string, waitedMs: number): string {
    // The zero-budget path never waited, so saying "has not finished after
    // 0.0s" would misdescribe it — and that is the default path, the one an
    // agent reads on nearly every call.
    const opening =
        waitedMs === 0
            ? "ACCEPTED, NOT YET SAVED — the relayer has durably queued this write."
            : `NOT SAVED YET — the write was accepted but has not finished after ${(waitedMs / 1000).toFixed(1)}s.`;

    return (
        `${opening}\n` +
        `job_id=${jobId}\n` +
        `Walrus uploads queue, so storing typically takes another 30-60s. Do NOT tell the ` +
        `user the fact is stored — say it is being saved. Call memwal_remember_status with ` +
        `this job_id to get the blob_id once it lands, or to learn that it failed; a job ` +
        `CAN fail after acceptance, and this is the only way to find out. Do not re-send ` +
        `the same fact with memwal_remember — that queues a second copy behind this one.`
    );
}

/** Longest fact echoed back in a pending listing. The line exists so the
 * agent can tell which job_id belongs to which fact, not to reproduce the
 * fact — and 20 of them at full length would crowd out the instructions
 * underneath. */
const PENDING_FACT_PREVIEW_CHARS = 80;

function previewFact(text: string): string {
    const flat = text.replace(/\s+/g, " ").trim();
    return flat.length > PENDING_FACT_PREVIEW_CHARS
        ? `${flat.slice(0, PENDING_FACT_PREVIEW_CHARS - 1)}…`
        : flat;
}

/**
 * The bulk counterpart of `pendingMessage`. Same contract — an agent must not
 * read it as success — with the one addition bulk needs: each job_id is paired
 * with the fact it carries, because "one of these five failed" is only
 * actionable if the agent can tell which.
 */
export function pendingBulkMessage(
    entries: Array<{ jobId: string; text: string }>,
    waitedMs: number,
): string {
    const n = entries.length;
    const opening =
        waitedMs === 0
            ? `ACCEPTED, NOT YET SAVED — the relayer has durably queued ${n} write(s).`
            : `NOT SAVED YET — ${n} write(s) were accepted but had not finished after ${(waitedMs / 1000).toFixed(1)}s.`;

    const lines = entries
        .map((e, i) => `${i + 1}. job_id=${e.jobId} — ${previewFact(e.text)}`)
        .join("\n");

    return (
        `${opening}\n${lines}\n` +
        `Walrus uploads queue and are written one at a time per wallet, so a batch takes ` +
        `longer than a single fact. Do NOT tell the user these facts are stored — say they ` +
        `are being saved. Call memwal_remember_status with job_ids=[...] to get the blob_ids ` +
        `once they land, or to learn that one failed; a job CAN fail after acceptance, and ` +
        `this is the only way to find out. Do not re-send these facts with ` +
        `memwal_remember_bulk — that queues a second copy behind them.`
    );
}
