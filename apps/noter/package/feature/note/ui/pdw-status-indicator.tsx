"use client";

/**
 * Walrus Memory Status Indicator Component
 *
 * Shows the current status of the Walrus Memory connection.
 * V2 uses server-side Ed25519 key — no wallet connection needed.
 *
 * States:
 * - Checking: Checking Walrus Memory server health
 * - Connected: Walrus Memory server reachable and configured
 * - Unavailable: Walrus Memory not configured or server unreachable
 */

import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/shared/components/ui/tooltip";
import {
  CheckCircle2,
  Loader2,
  XCircle,
} from "lucide-react";
import { useMemWalStatus } from "../hook/use-pdw-client";

export function PDWStatusIndicator() {
  const { isConfigured } = useMemWalStatus();

  if (isConfigured === false) {
    return (
      <TooltipProvider>
        <Tooltip>
          <TooltipTrigger asChild>
            <div className="flex items-center gap-2 px-3 py-1.5 rounded-md bg-yellow-50 dark:bg-yellow-900/20 border border-yellow-200 dark:border-yellow-800">
              <XCircle className="h-4 w-4 text-yellow-600 dark:text-yellow-400" />
              <span className="text-xs font-medium text-yellow-700 dark:text-yellow-300">
                Memory Off
              </span>
            </div>
          </TooltipTrigger>
          <TooltipContent>
            <p className="text-xs">Walrus Memory not configured (MEMWAL_PRIVATE_KEY not set)</p>
          </TooltipContent>
        </Tooltip>
      </TooltipProvider>
    );
  }

  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>
          <div className="flex items-center gap-2 px-3 py-1.5 rounded-md bg-green-50 dark:bg-green-900/20 border border-green-200 dark:border-green-800">
            <CheckCircle2 className="h-4 w-4 text-green-600 dark:text-green-400" />
            <span className="text-xs font-medium text-green-700 dark:text-green-300">
              Memory On
            </span>
          </div>
        </TooltipTrigger>
        <TooltipContent>
          <p className="text-xs">Walrus Memory connected — memories auto-saved</p>
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}
