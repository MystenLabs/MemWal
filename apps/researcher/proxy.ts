import { type NextRequest, NextResponse } from "next/server";
import { jwtVerify } from "jose";
import { getAuthSecretKey } from "@/lib/auth/auth-secret";
import { isTestEnvironment } from "@/lib/constants";

export async function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;

  if (pathname.startsWith("/ping")) {
    // Advertises whether this process runs the mock seams. Playwright reuses an
    // already-running dev server locally, so its global setup reads this header
    // to refuse one that would reach OpenRouter, Sui or the Walrus relayer.
    return new Response("pong", {
      status: 200,
      headers: { "x-researcher-test-mode": isTestEnvironment ? "1" : "0" },
    });
  }

  if (pathname.startsWith("/api/auth")) {
    return NextResponse.next();
  }

  // Read the secret whether or not a cookie came with the request. Deferring it
  // until a token shows up would let a deployment with no AUTH_SECRET serve the
  // login page as if nothing were wrong.
  const secret = getAuthSecretKey();
  const token = request.cookies.get("session")?.value;
  let isAuthenticated = false;

  if (token) {
    try {
      await jwtVerify(token, secret);
      isAuthenticated = true;
    } catch {
      // invalid or expired token
    }
  }

  if (!isAuthenticated) {
    if (pathname === "/login") {
      return NextResponse.next();
    }
    return NextResponse.redirect(new URL("/login", request.url));
  }

  if (pathname === "/login" || pathname === "/register") {
    return NextResponse.redirect(new URL("/", request.url));
  }

  return NextResponse.next();
}

export const config = {
  matcher: [
    "/",
    "/chat/:id",
    "/api/:path*",
    "/login",
    "/register",
    "/((?!_next/static|_next/image|favicon.ico|sitemap.xml|robots.txt).*)",
  ],
};
