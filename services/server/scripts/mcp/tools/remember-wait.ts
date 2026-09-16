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

/**
 * Longest we let the relayer take to ACCEPT a write before giving up on it.
 *
 * The SDK's `signedRequest` only aborts a request when the caller hands it a
 * signal, and of the memory methods only `recall()` does (15s). `rememberAsync`
 * and every job-status poll call it with no signal at all, so the underlying
 * `fetch` has no deadline of its own. That makes `timeoutMs` a loop-entry
 * check rather than a bound: `waitForRememberJob` tests `Date.now() < deadline`
 * at the top of each iteration, so one stalled HTTP request runs as long as the
 * socket stays open and a tool documented as capping at 90s is observed past
 * 120s. Returning at accept does not fix that on its own — the accept POST is
 * exactly one of the unbounded calls.
 *
 * 15s matches the only deadline the SDK sets for itself. A healthy accept is
 * ~1.1s, so this fires only when something is genuinely wrong.
 *
 * The SDK grows its own 30s per-request backstop in the release after the
 * pinned 0.1.7, which does not make this redundant: that one is a floor for
 * every consumer, this is the tighter bound an interactive agent needs, and
 * whichever is smaller fires first.
 */
export const DEFAULT_ACCEPT_DEADLINE_MS = 15_000;

/**
 * Read once, validated the same way as the wait budget: a typo must not
 * silently pick a deadline nobody asked for. Exposed as an env knob because an
 * operator on a slow link is the one person who can tell a hung relayer from a
 * merely distant one.
 */
export const ACCEPT_DEADLINE_MS = (() => {
    const raw = process.env.MEMWAL_MCP_ACCEPT_DEADLINE_MS;
    if (raw === undefined || raw.trim() === "") return DEFAULT_ACCEPT_DEADLINE_MS;
    const parsed = Number(raw);
    if (!Number.isFinite(parsed) || parsed <= 0) {
        log.warn("remember.accept_deadline_invalid", {
            value: raw,
            usingMs: DEFAULT_ACCEPT_DEADLINE_MS,
        });
        return DEFAULT_ACCEPT_DEADLINE_MS;
    }
    return Math.floor(parsed);
})();

/**
 * Grace added to a wait budget before we stop believing the SDK will return.
 *
 * The budget bounds when the SDK starts its last poll, not when that poll
 * finishes, so a stalled request can overshoot by an unbounded amount. This
 * caps the overshoot instead.
 */
const WAIT_OVERSHOOT_GRACE_MS = 10_000;

class DeadlineExceededError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "MemWalRelayerUnresponsive";
    }
}

/**
 * Bound an SDK call that has no deadline of its own.
 *
 * The underlying request is NOT cancelled — the SDK gives us no way to pass a
 * signal, so `fetch` keeps running until it settles or the socket dies. What
 * this bounds is how long the agent waits on it, which is the part the user
 * experiences as a hang. The orphaned request costs one socket and resolves
 * into a promise nobody reads.
 */
export async function withDeadline<T>(
    work: Promise<T>,
    ms: number,
    message: string,
): Promise<T> {
    let timer: NodeJS.Timeout | undefined;
    try {
        return await Promise.race([
            work,
            new Promise<never>((_, reject) => {
                timer = setTimeout(() => reject(new DeadlineExceededError(message)), ms);
                // Never hold the process open for a deadline nobody is waiting on.
                timer.unref?.();
            }),
        ]);
    } finally {
        if (timer) clearTimeout(timer);
    }
}

/** Bound the accept leg of a write.
 *
 * `idempotent` is not cosmetic. `POST /api/remember` carries a content-derived
 * idempotency_key, so a retry collapses onto the job already in flight.
 * `POST /api/remember/bulk` carries none at all — the handler mints a fresh
 * uuid per item and inserts with no conflict clause — so a retry there is N
 * more paid Walrus blobs for the same N facts.
 *
 * That distinction decides what we may tell the agent, and the deadline makes
 * it urgent rather than theoretical: `withDeadline` does not cancel the
 * underlying request, so when it fires the relayer has usually accepted
 * already. Inviting a blind retry on the bulk path is close to guaranteeing
 * the duplicate.
 */
export function withAcceptDeadline<T>(
    work: Promise<T>,
    what: string,
    opts: { idempotent: boolean },
): Promise<T> {
    const shared =
        `Walrus Memory did not accept the ${what} within ${ACCEPT_DEADLINE_MS / 1000}s — the ` +
        `relayer is unreachable or not responding. The write may or may not have been queued, ` +
        `so do NOT tell the user it was saved.`;

    return withDeadline(
        work,
        ACCEPT_DEADLINE_MS,
        opts.idempotent
            ? `${shared} Retrying in this session is safe: the write carries a content-derived ` +
              `idempotency key until an accept succeeds, so a retry attaches to the existing job ` +
              `instead of queueing a second paid copy.`
            : `${shared} Do NOT retry blindly — this endpoint carries no idempotency key, so a ` +
              `re-send stores every fact a SECOND time at full cost. Check with memwal_recall ` +
              `first, and only re-send what is genuinely missing.`,
    );
}

/** Bound a status wait at its own budget plus the overshoot grace. */
export function withWaitDeadline<T>(work: Promise<T>, budgetMs: number): Promise<T> {
    return withDeadline(
        work,
        budgetMs + WAIT_OVERSHOOT_GRACE_MS,
        `Walrus Memory stopped responding while waiting for the write to land. The job is ` +
            `still queued relayer-side — do NOT tell the user it was saved, and do NOT re-send ` +
            `the fact. Call memwal_remember_status with the job_id to settle it.`,
    );
}

/**
 * Longest we will sit on a relayer-advised cooldown before handing the problem
 * back to the agent.
 *
 * The relayer answers a spent rate-limit budget with `retry_after_seconds: 60`.
 * Sleeping that out inside a tool call is not a fix — it is the 60s hang this
 * whole change set exists to remove, and the MCP client would time out first.
 * So a short cooldown is absorbed and a long one is reported, with the wait
 * named so the agent can come back rather than guess.
 */
export const MAX_ABSORBED_COOLDOWN_MS = 8_000;

/** Attempts, including the first. Two retries is enough for a transient blip;
 * more just delays an answer the agent could act on. */
const RELAYER_RETRY_ATTEMPTS = 3;

/**
 * Errors where the request provably did NOT reach the handler, so re-sending
 * cannot duplicate work.
 *
 * This matters most for `/api/remember/bulk`, which carries no idempotency key
 * — a blind retry there would store every fact twice. Both cases below are
 * rejections BEFORE any job row exists: 429 comes from the rate limiter, and
 * AUTH_UPSTREAM_UNAVAILABLE from the delegate-key lookup failing open. Any
 * other 5xx could have been thrown after a write started, so it is not retried.
 */
function isSafelyRetryable(err: unknown): boolean {
    const e = err as { status?: number; serverCode?: string } | null;
    if (e?.status === 429) return true;
    return e?.status === 503 && e?.serverCode === "AUTH_UPSTREAM_UNAVAILABLE";
}

function advisedCooldownMs(err: unknown): number {
    const secs = (err as { retryAfterSeconds?: number } | null)?.retryAfterSeconds;
    return typeof secs === "number" && secs > 0 ? secs * 1000 : 1_000;
}

/**
 * Honour the relayer's own `retry_after` instead of surfacing a raw 429.
 *
 * Observed against production: once the per-delegate-key budget (60 weighted
 * requests/minute) is spent, `memwal_remember` fails with
 * `Tool error: ... 429 ... retry_after_seconds: 60` and the fact is simply
 * never written. Nothing retried, and nothing told the user their memory had
 * been dropped — the worst failure this system has, because it is silent.
 *
 * Fast-return makes it likelier, not rarer: settling a batch adds requests on
 * top of the write itself, so an agent saving several facts in one turn spends
 * the budget faster than one that blocked.
 */
export async function withRelayerRetry<T>(work: () => Promise<T>, what: string): Promise<T> {
    let last: unknown;
    for (let attempt = 1; attempt <= RELAYER_RETRY_ATTEMPTS; attempt++) {
        try {
            return await work();
        } catch (err) {
            last = err;
            if (!isSafelyRetryable(err)) throw err;

            const cooldown = advisedCooldownMs(err);
            if (attempt === RELAYER_RETRY_ATTEMPTS || cooldown > MAX_ABSORBED_COOLDOWN_MS) {
                const secs = Math.ceil(cooldown / 1000);
                const limited = (err as { status?: number }).status === 429;
                const e = new Error(
                    limited
                        ? `Walrus Memory rate limit reached while trying to ${what}. THE FACT WAS NOT ` +
                          `SAVED — tell the user it could not be stored rather than that it is being ` +
                          `saved. The limit is per delegate key and resets in about ${secs}s; retry ` +
                          `after that. To spend less of the budget, save several facts with one ` +
                          `memwal_remember_bulk call instead of repeated memwal_remember calls, and ` +
                          `settle a batch with a single memwal_remember_status(job_ids=[...]).`
                        : `Walrus Memory could not ${what}: the relayer's credential check is ` +
                          `temporarily unavailable. THE FACT WAS NOT SAVED. Retry in about ${secs}s.`,
                );
                e.name = "MemWalRelayerUnavailable";
                (e as Error & { status?: number }).status = (err as { status?: number }).status;
                throw e;
            }

            log.warn("remember.relayer_retry", {
                what,
                attempt,
                status: (err as { status?: number }).status,
                cooldownMs: cooldown,
            });
            await new Promise((r) => setTimeout(r, cooldown));
        }
    }
    throw last;
}
