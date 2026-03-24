/**
 * GetTransactions Tool UI
 *
 * Displays user's recent Sui blockchain transactions
 */

"use client";

import { Button } from "@/package/shared/components/ui/button";
import type { GetTransactionsOutput } from "@/shared/lib/ai/tools";
import { cn } from "@/shared/lib/utils";
import { color } from "@/shared/util/color";
import { CheckCircle2, ExternalLink, XCircle } from "lucide-react";

type ToolGetTransactionsProps = {
  output: GetTransactionsOutput;
};

function formatTimestamp(timestampMs: string): string {
  const date = new Date(Number(timestampMs));
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffMins = Math.floor(diffMs / 60000);
  const diffHours = Math.floor(diffMs / 3600000);
  const diffDays = Math.floor(diffMs / 86400000);

  if (diffMins < 1) return "Just now";
  if (diffMins < 60) return `${diffMins}m ago`;
  if (diffHours < 24) return `${diffHours}h ago`;
  if (diffDays < 7) return `${diffDays}d ago`;

  return date.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: date.getFullYear() !== now.getFullYear() ? "numeric" : undefined,
  });
}

function shortenDigest(digest: string): string {
  return `${digest.slice(0, 8)}...${digest.slice(-6)}`;
}

function shortenAddress(address: string): string {
  return `${address.slice(0, 6)}...${address.slice(-4)}`;
}

export function ToolGetTransactions({ output }: ToolGetTransactionsProps) {
  const explorerUrl = "https://suiscan.xyz/mainnet/tx";

  return (
    <div className="">
      {/* <div className="flex items-center justify-between gap-2 pb-2">
        <div className="flex items-center gap-2">
          <Button variant="ghost" size="icon" className={cn("h-8 w-8 shrink-0", color.background(output.address))}>
            <Activity className="size-4" />
          </Button>
          <span className="text-sm font-medium">Recent Transactions</span>
        </div>
        <code className="truncate text-xs text-muted-foreground">{shortenAddress(output.address)}</code>
      </div> */}

      {output.transactions.length === 0 ? (
        <div className="py-4 text-center text-sm text-muted-foreground">No transactions found</div>
      ) : (
        <div className="grid grid-cols-2 gap-2">
          {output.transactions.map((tx) => {
            const isSuccess = tx.effects.status.status === "success";

            return (
              <a
                key={tx.digest}
                href={`${explorerUrl}/${tx.digest}`}
                target="_blank"
                id={tx.digest}
                rel="noopener noreferrer"
                className={cn(
                  "group/tx flex items-center gap-3 rounded-lg p-2 bg-secondary transition-colors hover:bg-accent/50",
                )}
              >
                <Button
                  variant="secondary"
                  size="icon"
                  className={cn(
                    color.background(tx.digest),
                  )}
                >
                  {isSuccess ? (
                    <CheckCircle2 />
                  ) : (
                    <XCircle />
                  )}
                </Button>
                <div className="min-w-0 flex-1">
                  <code className="block truncate text-sm font-mono">{shortenDigest(tx.digest)}</code>
                  <div className="opacity-0 group-hover/tx:opacity-100 transition-opacity flex items-center gap-4 text-xs text-muted-foreground">
                    <span>{formatTimestamp(tx.timestampMs)}</span>
                    <span>Checkpoint {tx.checkpoint}</span>
                  </div>
                </div>
                <ExternalLink className="size-3.5 shrink-0 opacity-0 transition-opacity group-hover/tx:opacity-100" />
              </a>
            );
          })}
        </div>
      )}
      {/* 
      {output.hasMore && (
        <div className="pt-2 text-center text-xs text-muted-foreground">
          Showing recent {output.transactions.length} transactions
        </div>
      )} */}
    </div>
  );
}
