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
//
// The exclusion has to cover every single percent-encoding of the path, not just
// its literal spelling: Next tests the matcher against the raw pathname and
// decodes it only afterwards, when routing, so `/api/research/%70rocess-source`
// reaches this route while slipping past a literal-only lookahead — and gets
// drained. Each character below is `c` or `%XX` in either hex case, including
// `/` as `%2F`. Decoding happens once, so double-encoding never routes here.
// Next requires matchers to be static string literals, hence spelled out.
export const config = {
  matcher: [
    "/",
    "/chat/:id",
    "/api/((?!(?:r|%72)(?:e|%65)(?:s|%73)(?:e|%65)(?:a|%61)(?:r|%72)(?:c|%63)(?:h|%68)(?:/|%2[fF])(?:p|%70)(?:r|%72)(?:o|%6[fF])(?:c|%63)(?:e|%65)(?:s|%73)(?:s|%73)(?:-|%2[dD])(?:s|%73)(?:o|%6[fF])(?:u|%75)(?:r|%72)(?:c|%63)(?:e|%65)(?:/|%2[fF]|$)).*)",
    "/login",
    "/register",
    "/((?!_next/static|_next/image|favicon.ico|sitemap.xml|robots.txt|(?:a|%61)(?:p|%70)(?:i|%69)(?:/|%2[fF])(?:r|%72)(?:e|%65)(?:s|%73)(?:e|%65)(?:a|%61)(?:r|%72)(?:c|%63)(?:h|%68)(?:/|%2[fF])(?:p|%70)(?:r|%72)(?:o|%6[fF])(?:c|%63)(?:e|%65)(?:s|%73)(?:s|%73)(?:-|%2[dD])(?:s|%73)(?:o|%6[fF])(?:u|%75)(?:r|%72)(?:c|%63)(?:e|%65)(?:/|%2[fF]|$)).*)",
  ],
};
