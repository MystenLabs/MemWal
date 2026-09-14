const MIN_POLL_MS = 100;
const MAX_BACKOFF_MS = 3000;

/**
 * Delay before a remember-job poll.
 *
 * Attempt 0 is immediate. Later polls grow 1.5x from `baseMs` (floor 100ms)
 * to 3s, or stay at `baseMs` if the caller set it higher. Each poll costs 1
 * of the relayer's 30/min per-delegate-key budget, so a flat short interval
 * rate-limits the caller's own writes.
 */
export function pollingDelayMs(baseMs: number, attempt: number): number {
    if (attempt === 0) return 0;
    const base = Math.max(MIN_POLL_MS, baseMs);
    const ceiling = Math.max(MAX_BACKOFF_MS, base);
    const capped = Math.min(ceiling, base * 1.5 ** Math.min(attempt - 1, 6));
    const jitter = 0.75 + Math.random() * 0.5;
    return Math.floor(capped * jitter);
}
