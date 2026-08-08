export type EnokiRetryPolicy = {
    maxAttempts: number;
    baseDelayMs: number;
    maxDelayMs: number;
};

export type EnokiRetryInput = EnokiRetryPolicy & {
    attempt: number;
    status?: number;
    body?: string;
    retryAfter?: string | null;
    transportError?: boolean;
};

export function isTransientEnokiStatus(status: number): boolean {
    return status === 429 || (status >= 500 && status <= 599);
}

export function parseRetryAfterMs(value: string | null | undefined, nowMs = Date.now()): number | null {
    if (!value) return null;
    const trimmed = value.trim();
    if (!trimmed) return null;

    const seconds = Number(trimmed);
    if (Number.isFinite(seconds) && seconds >= 0) {
        return Math.round(seconds * 1000);
    }

    const dateMs = Date.parse(trimmed);
    if (Number.isFinite(dateMs)) {
        return Math.max(0, dateMs - nowMs);
    }

    return null;
}

export function parseTryAgainBodyDelayMs(body: string | undefined): number | null {
    if (!body) return null;
    const match = body.match(/try again in\s+(\d+(?:\.\d+)?)\s*(seconds?|s|minutes?|m)\b/i);
    if (!match) return null;

    const amount = Number(match[1]);
    if (!Number.isFinite(amount) || amount < 0) return null;

    const unit = match[2].toLowerCase();
    const multiplier = unit.startsWith("m") ? 60_000 : 1000;
    return Math.round(amount * multiplier);
}

export function isSponsoredTransactionInvalidatedMessage(message: string | undefined): boolean {
    if (!message) return false;
    return /sponsored transaction has expired/i.test(message)
        || /"code"\s*:\s*"expired"/i.test(message)
        || /sponsored transaction not found/i.test(message)
        || /"code"\s*:\s*"not_found"/i.test(message);
}

export function getEnokiRetryDelayMs(input: EnokiRetryInput): number | null {
    if (input.attempt >= input.maxAttempts) return null;

    const retryable = input.transportError
        || (typeof input.status === "number" && isTransientEnokiStatus(input.status));
    if (!retryable) return null;

    const hintedDelayMs = parseRetryAfterMs(input.retryAfter)
        ?? parseTryAgainBodyDelayMs(input.body);
    const fallbackDelayMs = input.baseDelayMs * 2 ** Math.max(0, input.attempt - 1);
    const rawDelayMs = hintedDelayMs ?? fallbackDelayMs;

    return Math.max(0, Math.min(input.maxDelayMs, rawDelayMs));
}
