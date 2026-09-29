import { NextResponse } from "next/server";
import { signIn } from "@/app/(auth)/auth";
import { publicRequestUrl, safeRedirectPath } from "@/lib/public-request-url";
import { getSessionToken } from "@/lib/session-token";

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

  return signIn("guest", { redirect: true, redirectTo: redirectUrl });
}
