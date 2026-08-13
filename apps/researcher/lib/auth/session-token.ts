import { SignJWT } from "jose";

export const SESSION_MAX_AGE_SECONDS = 24 * 60 * 60;

export type SessionIdentity = {
  userId: string;
  publicKey: string;
  accountId: string;
};

/** Sign identity-only claims. Reusable credentials must never be added here. */
export async function signSessionIdentity(
  identity: SessionIdentity,
  secret: Uint8Array
): Promise<string> {
  return new SignJWT(identity)
    .setProtectedHeader({ alg: "HS256" })
    .setExpirationTime(`${SESSION_MAX_AGE_SECONDS}s`)
    .sign(secret);
}
