/** Reject cross-origin state-changing browser requests. */
export function isSameOriginRequest(request: Request): boolean {
  const originHeader = request.headers.get("origin");
  const host = request.headers.get("host");
  if (!originHeader || !host) {
    return false;
  }

  try {
    const origin = new URL(originHeader);
    if (origin.host !== host) {
      return false;
    }

    // Production requests must originate from HTTPS. Keep HTTP available only
    // for local development; forwarded headers are intentionally ignored here
    // because they are client-spoofable without a trusted-proxy boundary.
    return (
      origin.protocol === "https:" ||
      (origin.protocol === "http:" &&
        (origin.hostname === "localhost" ||
          origin.hostname === "127.0.0.1" ||
          origin.hostname === "[::1]"))
    );
  } catch {
    return false;
  }
}
