const MIN_AUTH_SECRET_LENGTH = 32;

/**
 * Reads and validates AUTH_SECRET. NextAuth silently accepts any string
 * (including a short placeholder), which weakly signs session/guest JWTs
 * instead of failing — mirrors the guard in apps/researcher/lib/auth/enoki-challenge.ts.
 */
export function getAuthSecret(): string {
  const value = process.env.AUTH_SECRET;
  if (!value || value.length < MIN_AUTH_SECRET_LENGTH) {
    throw new Error(
      `AUTH_SECRET must contain at least ${MIN_AUTH_SECRET_LENGTH} characters`
    );
  }
  return value;
}
