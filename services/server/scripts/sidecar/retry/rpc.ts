/**
 * Generic retry wrapper for Sui RPC calls that hit rate limits or
 * transient availability errors.
 */

export function isRetryableRpcError(err: any): boolean {
    const msg = String(err?.message || err).toLowerCase();
    return msg.includes("429")
        || msg.includes("503")
        || msg.includes("rate")
        || msg.includes("too many")
        || msg.includes("timeout")
        || msg.includes("temporarily unavailable");
}

/**
 * Retry `fn` with exponential backoff + jitter on retryable RPC errors.
 * `label` is included verbatim in the retry warn log — callers prefix it
 * with their log scope (e.g. "[query-blobs] queryTransactionBlocks").
 */
export async function withRpcRetry<T>(
    label: string,
    fn: () => Promise<T>,
    maxRetries = 4,
): Promise<T> {
    let lastErr: any;
    for (let attempt = 0; attempt < maxRetries; attempt++) {
        try {
            return await fn();
        } catch (err: any) {
            lastErr = err;
            if (!isRetryableRpcError(err) || attempt === maxRetries - 1) throw err;
            const baseDelayMs = 1_000 * Math.pow(2, attempt);
            const jitterMs = Math.floor(Math.random() * Math.floor(baseDelayMs * 0.4));
            const delayMs = Math.min(15_000, baseDelayMs + jitterMs);
            console.warn(`${label} retrying in ${delayMs}ms (attempt ${attempt + 1}/${maxRetries})`);
            await new Promise(r => setTimeout(r, delayMs));
        }
    }
    throw lastErr;
}
