// One rule for AUTH_SECRET across the app. session.ts and proxy.ts used to read
// the variable raw, which had two silent failure modes:
//
//   - unset: `new TextEncoder().encode(undefined)` returns zero bytes, and jose
//     signs and verifies HS256 with an empty key without complaining. The app
//     then hands out and accepts cookies signed with a key every attacker
//     already has, so forging a session for any user id takes no secret at all.
//   - too short: a placeholder is brute-forceable offline from one captured
//     cookie.
//
// enoki-challenge.ts already refused anything under 32 characters for the same
// variable, so the session path was the odd one out.

const MIN_AUTH_SECRET_LENGTH = 32;

/**
 * The validated AUTH_SECRET. Reading is deliberately lazy: validating at module
 * scope would run during `next build`, where the Dockerfile supplies a short
 * build-time placeholder, and fail the image build rather than a request.
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

/** The validated secret as a signing key, for jose. */
export function getAuthSecretKey(): Uint8Array {
  return new TextEncoder().encode(getAuthSecret());
}
