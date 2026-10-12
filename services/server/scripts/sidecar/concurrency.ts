/**
 * Walrus upload concurrency limiting.
 *
 * Keeps Walrus write flows bounded in-process. The Rust worker can retry
 * faster than old sidecar requests unwind, so the sidecar owns the
 * effective global/per-wallet upload concurrency limit.
 */

import {
    WALRUS_UPLOAD_ACQUIRE_TIMEOUT_MS,
    WALRUS_UPLOAD_MAX_CONCURRENCY,
    WALRUS_UPLOAD_PER_WALLET_CONCURRENCY,
} from "./config.js";

export class WalrusUploadLimitError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "WalrusUploadLimitError";
    }
}

/** The HTTP client went away while this request was still queued for a slot. */
export class WalrusUploadCancelledError extends Error {
    constructor(label: string) {
        super(`upload client disconnected while waiting for ${label} upload slot`);
        this.name = "WalrusUploadCancelledError";
    }
}

export type UploadSlotRelease = {
    (): void;
    /** The write will not continue. The next release frees the permit now. */
    finishJob: () => void;
};

export type UploadSlotAcquireOptions = {
    signal?: AbortSignal;
    /**
     * Keep the wallet and global permits across the HTTP steps of this job.
     * The Rust writer checkpoints between steps and calls straight back.
     * 15s is enough for that gap plus one slow system-state read, and shorter
     * than the 30s congestion requeue, so a dropped client does not pin the
     * slot until its retry.
     */
    holdForJob?: boolean;
};

const JOB_SLOT_IDLE_MS = 15_000;
let jobSlotIdleMs = JOB_SLOT_IDLE_MS;

/** Test-only. Production uses {@link JOB_SLOT_IDLE_MS}. */
export function setJobSlotIdleMsForTests(ms: number): void {
    jobSlotIdleMs = ms;
}

export class AsyncSemaphore {
    private available: number;
    private waiters: Array<() => void> = [];

    constructor(private readonly capacity: number) {
        this.available = capacity;
    }

    acquire(timeoutMs: number, label: string, signal?: AbortSignal): Promise<() => void> {
        if (signal?.aborted) {
            return Promise.reject(new WalrusUploadCancelledError(label));
        }
        if (this.available > 0) {
            this.available -= 1;
            return Promise.resolve(() => this.release());
        }

        return new Promise((resolve, reject) => {
            let settled = false;
            let timer: ReturnType<typeof setTimeout> | undefined;
            const arm = () => {
                if (settled) return false;
                settled = true;
                if (timer) clearTimeout(timer);
                signal?.removeEventListener("abort", onAbort);
                return true;
            };
            const waiter = () => {
                if (!arm()) return;
                this.available -= 1;
                resolve(() => this.release());
            };
            const onAbort = () => {
                if (!arm()) return;
                this.waiters = this.waiters.filter((entry) => entry !== waiter);
                reject(new WalrusUploadCancelledError(label));
            };

            this.waiters.push(waiter);
            if (signal) signal.addEventListener("abort", onAbort);
            timer = setTimeout(() => {
                if (!arm()) return;
                this.waiters = this.waiters.filter((entry) => entry !== waiter);
                reject(new WalrusUploadLimitError(`timed out waiting for ${label} upload slot`));
            }, timeoutMs);
        });
    }

    snapshot(): Record<string, number> {
        return {
            capacity: this.capacity,
            available: this.available,
            queued: this.waiters.length,
        };
    }

    private release(): void {
        this.available = Math.min(this.capacity, this.available + 1);
        this.drain();
    }

    private drain(): void {
        while (this.available > 0 && this.waiters.length > 0) {
            const next = this.waiters.shift();
            if (next) next();
        }
    }
}

const walrusUploadGlobalLimiter = new AsyncSemaphore(WALRUS_UPLOAD_MAX_CONCURRENCY);
const walrusUploadWalletLimiters = new Map<number, AsyncSemaphore>();

let activeWalrusUploads = 0;
let queuedWalrusUploads = 0;

export function getUploadCounts(): { active: number; queued: number } {
    return { active: activeWalrusUploads, queued: queuedWalrusUploads };
}

function walrusUploadWalletLimiter(keyIndex: number): AsyncSemaphore {
    let limiter = walrusUploadWalletLimiters.get(keyIndex);
    if (!limiter) {
        limiter = new AsyncSemaphore(WALRUS_UPLOAD_PER_WALLET_CONCURRENCY);
        walrusUploadWalletLimiters.set(keyIndex, limiter);
    }
    return limiter;
}

export function walrusUploadLimitSnapshot(keyIndex?: number): Record<string, unknown> {
    return {
        global: walrusUploadGlobalLimiter.snapshot(),
        perWalletCapacity: WALRUS_UPLOAD_PER_WALLET_CONCURRENCY,
        wallet: typeof keyIndex === "number"
            ? walrusUploadWalletLimiter(keyIndex).snapshot()
            : undefined,
    };
}

type JobSlotLease = {
    keyIndex: number;
    inflight: number;
    finished: boolean;
    idleTimer?: ReturnType<typeof setTimeout>;
    freeSlots: () => void;
};

const jobSlotLeases = new Map<string, JobSlotLease>();

function callableRelease(free: () => void, finishJob: () => void = () => {}): UploadSlotRelease {
    const release = (() => free()) as UploadSlotRelease;
    release.finishJob = finishJob;
    return release;
}

function dropJobSlotLease(jobId: string, lease: JobSlotLease): void {
    if (lease.idleTimer) clearTimeout(lease.idleTimer);
    lease.idleTimer = undefined;
    lease.finished = true;
    lease.freeSlots();
    if (jobSlotLeases.get(jobId) === lease) jobSlotLeases.delete(jobId);
}

function leaseRelease(jobId: string, lease: JobSlotLease, signal?: AbortSignal): UploadSlotRelease {
    let once = false;
    const release = (() => {
        if (once) return;
        once = true;
        if (lease.finished && jobSlotLeases.get(jobId) !== lease) return;
        lease.inflight = Math.max(0, lease.inflight - 1);
        if (lease.inflight > 0) return;
        if (lease.finished || signal?.aborted) {
            dropJobSlotLease(jobId, lease);
            return;
        }
        lease.idleTimer = setTimeout(() => {
            if (lease.inflight === 0 && jobSlotLeases.get(jobId) === lease) {
                dropJobSlotLease(jobId, lease);
            }
        }, jobSlotIdleMs);
        lease.idleTimer.unref?.();
    }) as UploadSlotRelease;
    release.finishJob = () => {
        lease.finished = true;
        if (lease.idleTimer) clearTimeout(lease.idleTimer);
        lease.idleTimer = undefined;
        if (lease.inflight === 0) dropJobSlotLease(jobId, lease);
    };
    return release;
}

export async function acquireWalrusUploadSlots(
    keyIndex: number,
    traceId: string,
    jobId?: string | null,
    options?: UploadSlotAcquireOptions,
): Promise<UploadSlotRelease> {
    const holdForJob = Boolean(options?.holdForJob && jobId);
    if (holdForJob && jobId) {
        const existing = jobSlotLeases.get(jobId);
        if (existing && !existing.finished && existing.keyIndex === keyIndex) {
            if (existing.idleTimer) clearTimeout(existing.idleTimer);
            existing.idleTimer = undefined;
            existing.inflight += 1;
            return leaseRelease(jobId, existing, options?.signal);
        }
        if (existing) dropJobSlotLease(jobId, existing);
    }

    queuedWalrusUploads += 1;
    const startedAt = Date.now();
    let releaseWallet: (() => void) | undefined;
    let releaseGlobal: (() => void) | undefined;
    const signal = options?.signal;

    try {
        releaseWallet = await walrusUploadWalletLimiter(keyIndex).acquire(
            WALRUS_UPLOAD_ACQUIRE_TIMEOUT_MS,
            `wallet ${keyIndex}`,
            signal,
        );
        releaseGlobal = await walrusUploadGlobalLimiter.acquire(
            WALRUS_UPLOAD_ACQUIRE_TIMEOUT_MS,
            "global",
            signal,
        );
        queuedWalrusUploads = Math.max(0, queuedWalrusUploads - 1);
        activeWalrusUploads += 1;

        const acquiredAt = Date.now();
        const waitMs = acquiredAt - startedAt;
        if (waitMs >= 1_000) {
            console.warn(`[walrus/upload] [${traceId}] limiter_acquired ${JSON.stringify({
                jobId,
                keyIndex,
                waitMs,
                limits: walrusUploadLimitSnapshot(keyIndex),
            })}`);
        }

        // The underlying AsyncSemaphore release is not one-shot: a second call
        // can free capacity a successor still holds. Keep the returned callback
        // idempotent so route `finally` + error-path cleanup cannot over-release.
        let released = false;
        const freeSlots = () => {
            if (released) return;
            released = true;
            activeWalrusUploads = Math.max(0, activeWalrusUploads - 1);
            releaseGlobal?.();
            releaseWallet?.();
            console.log(`[walrus/upload] [${traceId}] limiter_released ${JSON.stringify({
                jobId,
                keyIndex,
                waitMs,
                heldMs: Date.now() - acquiredAt,
                counts: getUploadCounts(),
                limits: walrusUploadLimitSnapshot(keyIndex),
            })}`);
        };
        if (holdForJob && jobId) {
            const lease: JobSlotLease = {
                keyIndex,
                inflight: 1,
                finished: false,
                freeSlots,
            };
            jobSlotLeases.set(jobId, lease);
            return leaseRelease(jobId, lease, signal);
        }
        return callableRelease(freeSlots);
    } catch (err) {
        queuedWalrusUploads = Math.max(0, queuedWalrusUploads - 1);
        releaseGlobal?.();
        releaseWallet?.();
        console.warn(`[walrus/upload] [${traceId}] limiter_acquire_failed ${JSON.stringify({
            jobId,
            keyIndex,
            waitMs: Date.now() - startedAt,
            error: err instanceof Error ? err.message : String(err),
            counts: getUploadCounts(),
            limits: walrusUploadLimitSnapshot(keyIndex),
        })}`);
        throw err;
    }
}
