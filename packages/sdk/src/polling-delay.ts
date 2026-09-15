const MIN_POLL_MS = 100;
const MAX_BACKOFF_MS = 3000;

/** Attempt 0 is immediate. Later polls grow 1.5x toward 3s so status GETs stay under the 30/min quota. */
export function pollingDelayMs(baseMs: number, attempt: number): number {
    if (attempt === 0) return 0;
    const base = Math.max(MIN_POLL_MS, baseMs);
    const ceiling = Math.max(MAX_BACKOFF_MS, base);
    const capped = Math.min(ceiling, base * 1.5 ** Math.min(attempt - 1, 6));
    const jitter = 0.75 + Math.random() * 0.5;
    return Math.floor(capped * jitter);
}
