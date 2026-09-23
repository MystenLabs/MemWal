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

// POST /api/research/process-source is deliberately NOT matched (WALM-683).
// For every request the proxy sees, Next clones the body and drains it to EOF
// before the route runs — even when the proxy itself returns early — and hands
// the route a copy truncated at proxyClientMaxBodySize. That made an upload
// budget unenforceable: the bytes were already read, and an in-budget PDF over
// 10MB arrived cut short. The route authenticates with getSession(), which runs
// the same jwtVerify plus a user lookup, the way /api/auth/* already does.
export const config = {
  matcher: [
    "/",
    "/chat/:id",
    "/api/((?!research/process-source(?:/|$)).*)",
    "/login",
    "/register",
    "/((?!_next/static|_next/image|favicon.ico|sitemap.xml|robots.txt|api/research/process-source(?:/|$)).*)",
  ],
};
