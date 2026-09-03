import { getToken } from "next-auth/jwt";
import { isDevelopmentEnvironment } from "@/lib/constants";

/**
 * Read the Auth.js session JWT. A malformed `Authorization: Bearer` value
 * (`%%`, lone `%`, …) makes `getToken` throw `URIError` from
 * `decodeURIComponent` *before* its inner decode try/catch — that was HTTP 500
 * on proxy and `/api/auth/guest`. Treat it as no session.
 */
export async function getSessionToken(request: Request) {
  try {
    return await getToken({
      req: request,
      secret: process.env.AUTH_SECRET,
      secureCookie: !isDevelopmentEnvironment,
    });
  } catch (error) {
    if (error instanceof URIError) {
      return null;
    }
    throw error;
  }
}
