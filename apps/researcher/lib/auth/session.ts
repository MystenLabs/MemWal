import "server-only";

import { SignJWT, jwtVerify } from "jose";
import { cookies } from "next/headers";

const COOKIE_NAME = "session";
const secret = new TextEncoder().encode(process.env.AUTH_SECRET);

export async function getSession(): Promise<{
  user: { id: string; publicKey: string };
} | null> {
  const cookieStore = await cookies();
  const token = cookieStore.get(COOKIE_NAME)?.value;
  if (!token) return null;
  try {
    const { payload } = await jwtVerify(token, secret);
    return {
      user: {
        id: payload.userId as string,
        publicKey: payload.publicKey as string,
      },
    };
  } catch {
    return null;
  }
}

export async function createSession(
  userId: string,
  publicKey: string
): Promise<void> {
  const token = await new SignJWT({ userId, publicKey })
    .setProtectedHeader({ alg: "HS256" })
    .setExpirationTime("30d")
    .sign(secret);
  const cookieStore = await cookies();
  cookieStore.set(COOKIE_NAME, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    maxAge: 30 * 24 * 60 * 60,
  });
}

export async function clearSession(): Promise<void> {
  const cookieStore = await cookies();
  cookieStore.delete(COOKIE_NAME);
}
