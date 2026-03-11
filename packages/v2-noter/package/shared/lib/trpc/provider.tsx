"use client";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { httpBatchLink } from "@trpc/client";
import { useState } from "react";
import superjson from "superjson";
import { trpc } from "./client";

function getBaseUrl() {
  if (typeof window !== "undefined") return "";
  return process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000";
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
            // Read sessionId from sessionStorage on EVERY request
            // The storage key contains the entire SessionData object
            if (typeof window !== "undefined") {
              // Debug: List all sessionStorage keys
              const sessionDataStr = sessionStorage.getItem("zklogin:session:id");
              if (sessionDataStr) {
                try {
                  const sessionData = JSON.parse(sessionDataStr);                  // Extract the sessionId field from the SessionData object
                  if (sessionData?.sessionId) {                    return {
                      "x-session-id": sessionData.sessionId,
                    };
                  } else {                  }
                } catch (error) {
                  console.error("[tRPC Client] ❌ Failed to parse session data:", error);
                }
              } else {              }
            }            return {};
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
