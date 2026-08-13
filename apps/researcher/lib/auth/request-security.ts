/**
 * Reject cross-origin state-changing browser requests.
 *
 * Compares the `Origin` header's host against `Host`/`X-Forwarded-Host`
 * rather than `request.url`'s parsed origin. Behind a TLS-terminating proxy
 * (Railway) `request.url` reflects whatever internal host the app's server
 * constructed its request object from, which does not reliably match the
 * public origin the browser sent — that mismatch made this check reject
 * every same-origin request in production, including ones with a perfectly
 * matching `Origin` header. `Host`/`X-Forwarded-Host` are the two headers a
 * proxy is expected to forward, so they hold regardless of deployment
 * topology; this is the standard OWASP CSRF "verify Origin against Host"
 * pattern.
 */
export function isSameOriginRequest(request: Request): boolean {
  const origin = request.headers.get("origin");
  if (!origin) {
    return false;
  }

  const host =
    request.headers.get("x-forwarded-host") ?? request.headers.get("host");
  if (!host) {
    return false;
  }

  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}
