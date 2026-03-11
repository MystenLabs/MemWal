/**
 * GetBalances Tool UI
 *
 * Displays user's Sui blockchain token balances
 */

"use client";

import { Coins, Wallet } from "lucide-react";
import type { GetBalancesOutput } from "@/shared/lib/ai/tools";

type ToolGetBalancesProps = {
  output: GetBalancesOutput;
};

function formatBalance(balance: string, coinType: string): string {
  // SUI has 9 decimals, most tokens have 6-9
  const decimals = coinType.includes("::sui::SUI") ? 9 : 9;
  const value = Number(balance) / Math.pow(10, decimals);

  return value.toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 6,
  });
}

function getCoinName(coinType: string): string {
  // Extract coin name from type
  // Example: "0x2::sui::SUI" -> "SUI"
  const parts = coinType.split("::");
  return parts[parts.length - 1] || "Unknown";
}

function shortenAddress(address: string): string {
  return `${address.slice(0, 6)}...${address.slice(-4)}`;
}

export function ToolGetBalances({ output }: ToolGetBalancesProps) {
  const hasSUI = output.balances.some(b => b.coinType.includes("::sui::SUI"));
  const suiBalance = output.balances.find(b => b.coinType.includes("::sui::SUI"));
  const otherBalances = output.balances.filter(b => !b.coinType.includes("::sui::SUI"));

  return (
    <div className="rounded-lg border bg-muted/30 p-4 space-y-3">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Wallet className="h-4 w-4 text-muted-foreground" />
          <span className="font-medium text-sm">Token Balances</span>
        </div>
        <code className="text-xs text-muted-foreground">
          {shortenAddress(output.address)}
        </code>
      </div>

      {output.balances.length === 0 ? (
        <div className="text-sm text-muted-foreground py-4 text-center">
          No tokens found
        </div>
      ) : (
        <div className="space-y-2">
          {/* SUI Balance (primary) */}
          {suiBalance && (
            <div className="flex items-center justify-between p-3 rounded-lg bg-primary/5 border border-primary/20">
              <div className="flex items-center gap-2">
                <Coins className="h-4 w-4 text-primary" />
                <span className="font-medium">SUI</span>
              </div>
              <div className="text-right">
                <div className="font-mono font-medium">
                  {formatBalance(suiBalance.totalBalance, suiBalance.coinType)}
                </div>
                <div className="text-xs text-muted-foreground">
                  {suiBalance.coinObjectCount} {suiBalance.coinObjectCount === 1 ? 'coin' : 'coins'}
                </div>
              </div>
            </div>
          )}

          {/* Other Tokens */}
          {otherBalances.length > 0 && (
            <div className="space-y-1.5">
              {otherBalances.map((balance, idx) => (
                <div
                  key={idx}
                  className="flex items-center justify-between p-2 rounded bg-muted/50"
                >
                  <div className="flex items-center gap-2">
                    <Coins className="h-3.5 w-3.5 text-muted-foreground" />
                    <span className="text-sm font-medium">
                      {getCoinName(balance.coinType)}
                    </span>
                  </div>
                  <div className="text-right">
                    <div className="font-mono text-sm">
                      {formatBalance(balance.totalBalance, balance.coinType)}
                    </div>
                    <div className="text-xs text-muted-foreground">
                      {balance.coinObjectCount} {balance.coinObjectCount === 1 ? 'coin' : 'coins'}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {!hasSUI && output.balances.length === 0 && (
        <div className="text-xs text-muted-foreground mt-2 p-2 bg-muted rounded">
          💡 Tip: You need SUI tokens to pay for gas fees on the Sui blockchain
        </div>
      )}
    </div>
  );
}
