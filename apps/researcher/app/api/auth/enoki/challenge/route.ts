import { issueEnokiChallenge } from "@/lib/auth/enoki-challenge";
import { isSameOriginRequest } from "@/lib/auth/request-security";
import {
  AuthRateLimitError,
  checkAuthRateLimit,
} from "@/lib/ratelimit";
import { SharedRedisUnavailableError } from "@/lib/shared-redis";

const SUI_ADDRESS_REGEX = /^0x[0-9a-f]{64}$/i;

export async function POST(request: Request) {
  if (!isSameOriginRequest(request)) {
    return Response.json({ error: "Invalid request origin" }, { status: 403 });
  }

  try {
    await checkAuthRateLimit(request, "challenge");

    const { suiAddress } = await request.json();
    if (typeof suiAddress !== "string" || !SUI_ADDRESS_REGEX.test(suiAddress)) {
      return Response.json({ error: "Invalid Sui address" }, { status: 400 });
    }

    const message = await issueEnokiChallenge(suiAddress);
    return Response.json({ message });
  } catch (error) {
    if (error instanceof AuthRateLimitError) {
      return Response.json(
        {
          error:
            error.status === 429
              ? "Too many authentication requests"
              : "Authentication service temporarily unavailable",
        },
        {
          headers: { "Retry-After": error.status === 429 ? "60" : "5" },
          status: error.status,
        },
      );
    }
    if (error instanceof SharedRedisUnavailableError) {
      return Response.json(
        { error: "Authentication service temporarily unavailable" },
        { headers: { "Retry-After": "5" }, status: 503 },
      );
    }
    console.error("[auth:enoki:challenge] Error:", error);
    return Response.json({ error: "Unable to create challenge" }, { status: 500 });
  }
}
