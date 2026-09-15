const BIND_HOSTNAMES = new Set(["0.0.0.0", "::", "[::]"]);

function isBindHostname(hostname: string): boolean {
  return BIND_HOSTNAMES.has(hostname.toLowerCase());
}

function firstHeader(headers: Headers, name: string): string | null {
  return headers.get(name)?.split(",")[0]?.trim() || null;
}

function usablePublicHost(host: string | null): string | null {
  if (!host) {
    return null;
  }
  try {
    const hostname = new URL(`http://${host}`).hostname;
    return hostname && !isBindHostname(hostname) ? host : null;
  } catch {
    return null;
  }
}

export function publicRequestUrl(request: Request): URL {
  const url = new URL(request.url);
  const forwardedHost = usablePublicHost(
    firstHeader(request.headers, "x-forwarded-host")
  );
  const publicHost =
    forwardedHost ??
    (isBindHostname(url.hostname)
      ? usablePublicHost(firstHeader(request.headers, "host"))
      : null);

  if (!publicHost) {
    return url;
  }

  const proto = firstHeader(request.headers, "x-forwarded-proto")?.toLowerCase();
  const protocol =
    proto === "http" || proto === "https"
      ? proto
      : url.protocol.replace(/:$/, "");

  // Reconstruct; assigning URL.host keeps :3000 from the bind address.
  try {
    return new URL(`${protocol}://${publicHost}${url.pathname}${url.search}`);
  } catch {
    return url;
  }
}

export function guestReturnPath(request: Request): string {
  const url = new URL(request.url);
  const path = `${url.pathname}${url.search}`;
  return path.startsWith("/") && !path.startsWith("//") ? path : "/";
}

export function isSafeRedirectUrl(
  redirectUrl: string,
  request: Request
): boolean {
  if (redirectUrl.startsWith("/") && !redirectUrl.startsWith("//")) {
    return true;
  }

  try {
    const redirect = new URL(redirectUrl);
    const publicUrl = publicRequestUrl(request);
    if (
      isBindHostname(redirect.hostname) ||
      isBindHostname(publicUrl.hostname)
    ) {
      return false;
    }
    return redirect.origin === publicUrl.origin;
  } catch {
    return false;
  }
}
