"use client";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { httpBatchLink } from "@trpc/client";
import { useState } from "react";
import superjson from "superjson";
import { trpc } from "./client";

// SESSION_STORAGE_KEY must match STORAGE_KEYS.sessionId in auth/constant.ts
// Both zkLogin and wallet sessions are stored under this same key as SessionData JSON
const SESSION_STORAGE_KEY = "zklogin:session:id";

function getBaseUrl() {
  if (typeof window !== "undefined") return "";
  return process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000";
}

/**
 * Extract the sessionId from sessionStorage.
 * Jotai atomWithStorage serializes SessionData as JSON, e.g.:
 *   { "sessionId": "uuid", "ephemeralKeyPair": {...}, ... }
 * We read it here and forward only the sessionId as the auth header.
 */
function getSessionId(): string | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = sessionStorage.getItem(SESSION_STORAGE_KEY);
    if (!raw) return null;
    // Jotai wraps the value in its own JSON format: parse outer first
    const outer = JSON.parse(raw);
    // The actual session data may be nested under "value" (Jotai v2 atomWithStorage)
    // or directly at the top level
    const sessionData = outer?.value ?? outer;
    return sessionData?.sessionId ?? null;
  } catch {
    return null;
  }
}

export function TRPCProvider({ children }: { children: React.ReactNode }) {
  const [queryClient] = useState(() => new QueryClient());
  const [trpcClient] = useState(() =>
    trpc.createClient({
      links: [
        httpBatchLink({
          url: `${getBaseUrl()}/api/trpc`,
          transformer: superjson,
          async headers() {
            const sessionId = getSessionId();
            if (sessionId) {
              return { "x-session-id": sessionId };
            }
            return {};
          },
        }),
      ],
    })
  );

  return (
    <trpc.Provider client={trpcClient} queryClient={queryClient}>
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    </trpc.Provider>
  );
}
