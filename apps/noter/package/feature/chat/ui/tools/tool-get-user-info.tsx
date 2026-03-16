/**
 * GetUserInfo Tool UI
 *
 * Displays user information retrieved by the AI
 */

"use client";

import { User, Mail, Wallet, Calendar, Shield, Clock } from "lucide-react";
import { Avatar, AvatarFallback, AvatarImage } from "@/shared/components/ui/avatar";
import type { GetUserInfoOutput } from "@/shared/lib/ai/tools";

type ToolGetUserInfoProps = {
  output: GetUserInfoOutput;
};

export function ToolGetUserInfo({ output }: ToolGetUserInfoProps) {
  const initials = output.name
    ?.split(" ")
    .map((n) => n[0])
    .join("")
    .toUpperCase()
    .slice(0, 2) || "U";

  return (
    <div className="rounded-lg border bg-muted/30 p-4 space-y-3">
      <div className="flex items-center gap-2">
        <User className="h-4 w-4 text-muted-foreground" />
        <span className="font-medium text-sm">User Information</span>
      </div>

      <div className="flex items-start gap-3">
        <Avatar className="h-12 w-12">
          <AvatarImage src={output.avatar || undefined} alt={output.name || "User"} />
          <AvatarFallback>{initials}</AvatarFallback>
        </Avatar>

        <div className="flex-1 space-y-2 min-w-0">
          <div>
            <p className="font-medium text-base">{output.name || "Anonymous"}</p>
            {output.email && (
              <div className="flex items-center gap-1.5 text-xs text-muted-foreground mt-0.5">
                <Mail className="h-3 w-3" />
                <span className="truncate">{output.email}</span>
              </div>
            )}
          </div>

          <div className="space-y-1.5">
            <div className="flex items-center gap-1.5 text-xs">
              <Wallet className="h-3 w-3 text-muted-foreground" />
              <span className="text-muted-foreground">Sui Address:</span>
              <code className="text-[10px] bg-muted px-1.5 py-0.5 rounded">
                {output.suiAddress.slice(0, 8)}...{output.suiAddress.slice(-6)}
              </code>
            </div>

            <div className="flex items-center gap-1.5 text-xs">
              <Shield className="h-3 w-3 text-muted-foreground" />
              <span className="text-muted-foreground">Auth:</span>
              <span className="font-medium">
                {output.authMethod === "zklogin"
                  ? `zkLogin (${output.provider || "unknown"})`
                  : `Wallet (${output.walletType || "unknown"})`
                }
              </span>
            </div>

            <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <Calendar className="h-3 w-3" />
              <span>Member since {output.memberSince}</span>
            </div>

            {output.lastSeenAt && (
              <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                <Clock className="h-3 w-3" />
                <span>Last active {output.lastSeenAt}</span>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
