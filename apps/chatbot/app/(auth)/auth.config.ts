import type { NextAuthConfig } from "next-auth";

export const authConfig = {
  // Railway / Docker set HOSTNAME=0.0.0.0; trust the incoming Host header.
  trustHost: true,
  pages: {
    signIn: "/login",
    newUser: "/",
  },
  providers: [
    // added later in auth.ts since it requires bcrypt which is only compatible with Node.js
    // while this file is also used in non-Node.js environments
  ],
  callbacks: {},
} satisfies NextAuthConfig;
