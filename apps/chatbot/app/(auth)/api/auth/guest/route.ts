import { NextResponse } from "next/server";
import { signIn } from "@/app/(auth)/auth";
import { isSafeRedirectUrl, publicRequestUrl } from "@/lib/public-request-url";
import {
  checkGuestAuthRateLimit,
  GUEST_AUTH_RATE_LIMIT_TTL_SECONDS,
  GuestAuthRateLimitError,
  guestAuthLimitFromError,
} from "@/lib/ratelimit";
import { getSessionToken } from "@/lib/session-token";

function guestAuthLimitResponse(error: GuestAuthRateLimitError) {
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

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const rawRedirectUrl = searchParams.get("redirectUrl") || "/";
  const publicUrl = publicRequestUrl(request);

  // Reject cross-origin, bind-address, or protocol-relative redirect targets
  const redirectUrl = isSafeRedirectUrl(rawRedirectUrl, request)
    ? rawRedirectUrl
    : "/";

  const token = await getSessionToken(request);

  if (token) {
    return NextResponse.redirect(new URL("/", publicUrl));
  }

  try {
    // Peek only: signIn("guest") runs authorize() in-process, which consumes.
    await checkGuestAuthRateLimit(request, { consume: false });
  } catch (error) {
    const limited = guestAuthLimitFromError(error);
    if (limited) {
      return guestAuthLimitResponse(limited);
    }
    throw error;
  }

  try {
    return await signIn("guest", { redirect: true, redirectTo: redirectUrl });
  } catch (error) {
    const limited = guestAuthLimitFromError(error);
    if (limited) {
      return guestAuthLimitResponse(limited);
    }
    throw error;
  }
}
