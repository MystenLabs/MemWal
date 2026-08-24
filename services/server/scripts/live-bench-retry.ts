/**
 * Retry classification for the live memory-API latency bench.
 *
 * The bench hits the public relayer through Cloudflare. A burst of HTML
 * error/challenge pages (status 403/5xx/429, body starts with <!DOCTYPE html>)
 * is an edge flap, not a failed recall. Auth 401/403 JSON and 4xx contract
 * errors stay fatal.
 */

export const LIVE_BENCH_MAX_ATTEMPTS = 4;
export const LIVE_BENCH_RETRY_BASE_MS = 400;

const RETRYABLE_HTTP_STATUS = new Set([
  408, 429, 500, 502, 503, 504, 520, 521, 522, 523, 524, 525, 526, 527,
]);

export function isCloudflareHtmlBody(body: string): boolean {
  const head = body.slice(0, 400).toLowerCase();
  return (
    head.includes("<!doctype html") ||
    head.includes("<html") ||
    head.includes("cloudflare")
  );
}

export function isRetryableLiveBenchFailure(opts: {
  statusCode?: number;
  contentType?: string | null;
  error?: string;
}): boolean {
  const contentType = (opts.contentType ?? "").toLowerCase();
  const error = opts.error ?? "";

  if (contentType.includes("text/html") || isCloudflareHtmlBody(error)) {
    return true;
  }
  if (opts.statusCode !== undefined && RETRYABLE_HTTP_STATUS.has(opts.statusCode)) {
    return true;
  }
  if (opts.statusCode === undefined && error) {
    const msg = error.toLowerCase();
    return (
      msg.includes("fetch") ||
      msg.includes("network") ||
      msg.includes("econnreset") ||
      msg.includes("etimedout") ||
      msg.includes("socket") ||
      msg.includes("unexpected token") ||
      msg.includes("not valid json")
    );
  }
  return false;
}

export function liveBenchRetryDelayMs(attempt: number): number {
  return LIVE_BENCH_RETRY_BASE_MS * 2 ** Math.max(0, attempt - 1);
}
