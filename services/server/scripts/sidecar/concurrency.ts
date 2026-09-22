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

export class AsyncSemaphore {
    private available: number;
    private waiters: Array<() => void> = [];

    constructor(private readonly capacity: number) {
        this.available = capacity;
    }

    acquire(timeoutMs: number, label: string): Promise<() => void> {
        if (this.available > 0) {
            this.available -= 1;
            return Promise.resolve(() => this.release());
        }

        return new Promise((resolve, reject) => {
            let settled = false;
            let timer: ReturnType<typeof setTimeout> | undefined;
            const waiter = () => {
                if (settled) return;
                settled = true;
                if (timer) clearTimeout(timer);
                this.available -= 1;
                resolve(() => this.release());
            };

            this.waiters.push(waiter);
            timer = setTimeout(() => {
                if (settled) return;
                settled = true;
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

export async function acquireWalrusUploadSlots(
    keyIndex: number,
    traceId: string,
    jobId?: string | null,
): Promise<() => void> {
    queuedWalrusUploads += 1;
    const startedAt = Date.now();
    let releaseWallet: (() => void) | undefined;
    let releaseGlobal: (() => void) | undefined;

    try {
        releaseWallet = await walrusUploadWalletLimiter(keyIndex).acquire(
            WALRUS_UPLOAD_ACQUIRE_TIMEOUT_MS,
            `wallet ${keyIndex}`,
        );
        releaseGlobal = await walrusUploadGlobalLimiter.acquire(
            WALRUS_UPLOAD_ACQUIRE_TIMEOUT_MS,
            "global",
        );
        queuedWalrusUploads = Math.max(0, queuedWalrusUploads - 1);
        activeWalrusUploads += 1;

        const waitMs = Date.now() - startedAt;
        if (waitMs >= 1_000) {
            console.warn(`[walrus/upload] [${traceId}] limiter_acquired ${JSON.stringify({
                jobId,
                keyIndex,
                waitMs,
                limits: walrusUploadLimitSnapshot(keyIndex),
            })}`);
        }

        return () => {
            activeWalrusUploads = Math.max(0, activeWalrusUploads - 1);
            releaseGlobal?.();
            releaseWallet?.();
        };
    } catch (err) {
        queuedWalrusUploads = Math.max(0, queuedWalrusUploads - 1);
        releaseGlobal?.();
        releaseWallet?.();
        throw err;
    }
}
