import "server-only";

import { jwtVerify } from "jose";
import { cookies } from "next/headers";
import { getUserById } from "@/lib/db/queries";
import { getAuthSecretKey } from "@/lib/auth/auth-secret";
import {
  SESSION_MAX_AGE_SECONDS,
  signSessionIdentity,
} from "@/lib/auth/session-token";

const COOKIE_NAME = "session";

type SessionUser = {
  id: string;
  publicKey: string;
  privateKey: string;
  accountId: string;
};

/**
 * Verify the identity-only JWT, then load reusable credentials from the
 * server-side user row. Delegate private keys are never encoded in cookies.
 */
export async function getSession(): Promise<{ user: SessionUser } | null> {
  const cookieStore = await cookies();
  const token = cookieStore.get(COOKIE_NAME)?.value;
  if (!token) return null;

  try {
    const { payload } = await jwtVerify(token, getAuthSecretKey());
    if (typeof payload.userId !== "string") return null;

    const user = await getUserById(payload.userId);
    if (!user || !user.publicKey) return null;

    return {
      user: {
        id: user.id,
        publicKey: user.publicKey,
        privateKey: user.delegatePrivateKey ?? "",
        accountId: user.accountId ?? "",
      },
    };
  } catch {
    return null;
  }
}

/** Create a short-lived identity session; credentials remain server-side. */
export async function createSession(
  userId: string,
  publicKey: string,
  accountId: string
): Promise<void> {
  const token = await signSessionIdentity(
    { userId, publicKey, accountId },
    getAuthSecretKey()
  );
  const cookieStore = await cookies();
  cookieStore.set(COOKIE_NAME, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    maxAge: SESSION_MAX_AGE_SECONDS,
  });
}

export async function clearSession(): Promise<void> {
  const cookieStore = await cookies();
  cookieStore.delete(COOKIE_NAME);
}
