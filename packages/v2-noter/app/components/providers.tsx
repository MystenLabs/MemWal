"use client";

/**
 * Client-side Providers
 *
 * Wraps the app with all client-side context providers:
 * - React Query (for tRPC & data fetching)
 * - Theme Provider (dark mode)
 * - Tooltip Provider (UI)
 * - TRPC Provider (API)
 */

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ThemeProvider } from "next-themes";
import { TooltipProvider } from "@/shared/components/ui/tooltip";
import { TRPCProvider } from "@/shared/lib/trpc/provider";

const queryClient = new QueryClient();

export function Providers({ children }: { children: React.ReactNode }) {
  return (
    <QueryClientProvider client={queryClient}>
      <ThemeProvider attribute="class" defaultTheme="system" enableSystem>
        <TooltipProvider>
          <TRPCProvider>{children}</TRPCProvider>
        </TooltipProvider>
      </ThemeProvider>
    </QueryClientProvider>
  );
}
