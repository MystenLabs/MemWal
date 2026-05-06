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

import { ThemeProvider } from "next-themes";
import { TooltipProvider } from "@/shared/components/ui/tooltip";
import { TRPCProvider } from "@/shared/lib/trpc/provider";
import { SuiProviders } from "@/app/components/sui-providers";

export function Providers({ children }: { children: React.ReactNode }) {
  return (
    <TRPCProvider>
      <SuiProviders>
        <ThemeProvider attribute="class" defaultTheme="system" enableSystem>
          <TooltipProvider>{children}</TooltipProvider>
        </ThemeProvider>
      </SuiProviders>
    </TRPCProvider>
  );
}
