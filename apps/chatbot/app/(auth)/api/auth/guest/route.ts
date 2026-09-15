import { NextResponse } from "next/server";
import { signIn } from "@/app/(auth)/auth";
import { isSafeRedirectUrl, publicRequestUrl } from "@/lib/public-request-url";
import { getSessionToken } from "@/lib/session-token";

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

  return signIn("guest", { redirect: true, redirectTo: redirectUrl });
}
