import { NextResponse } from "next/server";
import { getToken } from "next-auth/jwt";
import { signIn } from "@/app/(auth)/auth";
import { isDevelopmentEnvironment } from "@/lib/constants";

/**
 * Validate a redirect target before forwarding to auth.
 * Allows only:
 *   - Relative paths beginning with "/" (but not "//", which is protocol-relative)
 *   - Absolute URLs whose origin matches the request origin (same-origin)
 * Anything else (external hosts, javascript:, data:, //evil.com) falls back to "/".
 */
function isSafeRedirectUrl(redirectUrl: string, requestUrl: string): boolean {
  // Relative path — safe as long as it isn't protocol-relative ("//host/...")
  if (redirectUrl.startsWith("/") && !redirectUrl.startsWith("//")) {
    return true;
  }
  // Absolute URL — must share the same origin as the request
  try {
    const redirectOrigin = new URL(redirectUrl).origin;
    const requestOrigin = new URL(requestUrl).origin;
    return redirectOrigin === requestOrigin;
  } catch {
    // Unparseable URL (e.g. "javascript:alert(1)") — reject
    return false;
  }
}

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const rawRedirectUrl = searchParams.get("redirectUrl") || "/";

  // Reject cross-origin or protocol-relative redirect targets
  const redirectUrl = isSafeRedirectUrl(rawRedirectUrl, request.url)
    ? rawRedirectUrl
    : "/";

  const token = await getToken({
    req: request,
    secret: process.env.AUTH_SECRET,
    secureCookie: !isDevelopmentEnvironment,
  });

  if (token) {
    return NextResponse.redirect(new URL("/", request.url));
  }

  return signIn("guest", { redirect: true, redirectTo: redirectUrl });
}
