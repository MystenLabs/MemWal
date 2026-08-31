import { NextResponse } from "next/server";
import { signIn } from "@/app/(auth)/auth";
import { publicRequestUrl, safeRedirectPath } from "@/lib/public-request-url";
import { getSessionToken } from "@/lib/session-token";
import {
  checkGuestAuthRateLimit,
  GUEST_AUTH_RATE_LIMIT_TTL_SECONDS,
  GuestAuthRateLimitError,
} from "@/lib/ratelimit";

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const rawRedirectUrl = searchParams.get("redirectUrl") || "/";
  const publicUrl = publicRequestUrl(request);

  // Forward the normalized same-origin path only — never the raw string.
  const redirectUrl = safeRedirectPath(rawRedirectUrl, request) ?? "/";

  const token = await getSessionToken(request);

  if (token) {
    return NextResponse.redirect(new URL("/", publicUrl));
  }

  try {
    await checkGuestAuthRateLimit(request);
  } catch (error) {
    if (error instanceof GuestAuthRateLimitError) {
      return NextResponse.json(
        { error: error.message },
        {
          status: error.status,
          headers: {
            "Retry-After":
              error.status === 429
                ? String(GUEST_AUTH_RATE_LIMIT_TTL_SECONDS)
                : "5",
          },
        }
      );
    }
    throw error;
  }

  return signIn("guest", { redirect: true, redirectTo: redirectUrl });
}
