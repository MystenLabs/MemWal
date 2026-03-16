"use client";

/**
 * MemWal Status Indicator Component
 *
 * Shows the current status of MemWal connection.
 * V2 uses server-side Ed25519 key — no wallet connection needed.
 *
 * States:
 * - Checking: Checking MemWal server health
 * - Connected: MemWal server reachable and configured
 * - Unavailable: MemWal not configured or server unreachable
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
            <p className="text-xs">MemWal not configured (MEMWAL_KEY not set)</p>
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
              MemWal On
            </span>
          </div>
        </TooltipTrigger>
        <TooltipContent>
          <p className="text-xs">MemWal connected — memories auto-saved</p>
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}
