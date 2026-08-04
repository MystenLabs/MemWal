"use client";

import { useAuth } from "@/feature/auth";
import { Button } from "@/shared/components/ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/shared/components/ui/tooltip";
import { cn } from "@/shared/lib/utils";
import { trpc } from "@/shared/lib/trpc/client";
import { useSignPersonalMessage } from "@mysten/dapp-kit";
import { Copy, LogOut, Minus, Check, Shield, KeyRound, Eye, EyeOff, ExternalLink, Loader2 } from "lucide-react";
import Image from "next/image";
import { useCallback, useState } from "react";

interface UserFloatPanelProps {
  className: string;
  onClose: () => void;
}

function CopyButton({ value, label }: { value: string; label: string }) {
  const [copied, setCopied] = useState(false);

  const handleCopy = async () => {
    await navigator.clipboard.writeText(value);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button variant="secondary" size="icon-sm" onClick={handleCopy}>
          {copied ? <Check className="size-3" /> : <Copy className="size-3" />}
        </Button>
      </TooltipTrigger>
      <TooltipContent>{copied ? "Copied!" : `Copy ${label}`}</TooltipContent>
    </Tooltip>
  );
}

function truncateAddress(addr: string): string {
  if (addr.length <= 16) return addr;
  return `${addr.slice(0, 8)}...${addr.slice(-6)}`;
}

export function UserFloatPanel({ className, onClose }: UserFloatPanelProps) {
  const { user, suiAddress, logout } = useAuth();
  const [showKey, setShowKey] = useState(false);
  const [delegateKey, setDelegateKey] = useState<string | null>(null);
  const [keyError, setKeyError] = useState("");

  const { mutateAsync: signPersonalMessage } = useSignPersonalMessage();
  const { mutateAsync: issueChallenge } =
    trpc.auth.issueEnokiChallenge.useMutation();
  const exportKeyMutation = trpc.auth.exportDelegateKey.useMutation();

  const handleLogout = async () => {
    await logout();
    onClose();
    window.location.href = "/";
  };

  /**
   * Fetch the delegate private key on explicit user action. Requires a fresh
   * ownership challenge signed for the user's own address; the key is never
   * part of the session DTO and is only revealed through this guarded path.
   */
  const handleRevealKey = useCallback(async () => {
    // Already fetched — just toggle visibility.
    if (delegateKey) {
      setShowKey((v) => !v);
      return;
    }
    if (!suiAddress) return;

    setKeyError("");
    try {
      const { challengeId, message } = await issueChallenge({
        suiAddress,
      });
      const { signature } = await signPersonalMessage({
        message: new TextEncoder().encode(message),
      });
      const result = await exportKeyMutation.mutateAsync({
        suiAddress,
        challengeId,
        signature,
      });
      setDelegateKey(result.delegatePrivateKey);
      setShowKey(true);
    } catch (err) {
      setKeyError(
        err instanceof Error ? err.message : "Unable to reveal key.",
      );
    }
  }, [
    delegateKey,
    suiAddress,
    issueChallenge,
    signPersonalMessage,
    exportKeyMutation,
  ]);

  const authMethod = user?.authMethod === "enoki" ? "Google" : user?.authMethod === "wallet" ? "Wallet" : "Key";

  return (
    <div className={cn(className, "w-full max-w-sm")}>
      {/* Header */}
      <div className="flex items-center justify-between p-1 shrink-0">
        <Button
          variant="secondary"
          size="sm"
          className="h-7 px-2 font-medium pointer-events-none"
        >
          Profile
        </Button>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button variant="ghost" size="icon-sm" onClick={onClose}>
              <Minus className="size-4" />
            </Button>
          </TooltipTrigger>
          <TooltipContent>Minimize</TooltipContent>
        </Tooltip>
      </div>

      <div className="p-1 space-y-1">
        {user && (
          <>
            {/* User info */}
            <div className="flex items-center gap-1">
              {user.avatar && (
                <Image
                  src={user.avatar}
                  alt={user.name || "User"}
                  width={56}
                  height={56}
                />
              )}
              <div className="flex-1 min-w-0 bg-secondary p-2">
                <p className="text-sm font-medium truncate">{user.name || "User"}</p>
                <p className="text-xs text-muted-foreground">Signed in with {authMethod}</p>
              </div>
            </div>

            {/* Walrus Memory Account Info */}
            <div className="space-y-0.5">
              <div className="flex items-center gap-1 px-1 py-0.5">
                <Shield className="size-3 text-muted-foreground" />
                <span className="text-xs font-medium">Walrus Memory Account</span>
              </div>

              {/* Sui Address */}
              {suiAddress && (
                <div className="flex items-center gap-1">
                  <div className="flex-1 min-w-0 bg-secondary px-2 py-2">
                    <p className="text-[10px] text-muted-foreground">Sui Address</p>
                    <code className="text-xs truncate block">{truncateAddress(suiAddress)}</code>
                  </div>
                  <CopyButton value={suiAddress} label="address" />
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button
                        variant="secondary"
                        size="icon-sm"
                        onClick={() => window.open(`https://suiscan.xyz/testnet/account/${suiAddress}`, "_blank")}
                      >
                        <ExternalLink className="size-3" />
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent>View on Suiscan</TooltipContent>
                  </Tooltip>
                </div>
              )}

              {/* Account ID */}
              {user.delegateAccountId && (
                <div className="flex items-center gap-1">
                  <div className="flex-1 min-w-0 bg-secondary px-2 py-2">
                    <p className="text-[10px] text-muted-foreground">Account ID</p>
                    <code className="text-xs truncate block">{truncateAddress(user.delegateAccountId)}</code>
                  </div>
                  <CopyButton value={user.delegateAccountId} label="account ID" />
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button
                        variant="secondary"
                        size="icon-sm"
                        onClick={() => window.open(`https://suiscan.xyz/testnet/object/${user.delegateAccountId}`, "_blank")}
                      >
                        <ExternalLink className="size-3" />
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent>View on Suiscan</TooltipContent>
                  </Tooltip>
                </div>
              )}
            </div>

            {/* Delegate Key Export — fetched on demand via a guarded, ownership-verified path */}
            {user.delegateAccountId && (
              <div className="space-y-1">
                <div className="flex items-center gap-1 px-1 py-0.5">
                  <KeyRound className="size-3 text-muted-foreground" />
                  <span className="text-xs font-medium">Delegate Key</span>
                </div>

                {showKey && delegateKey && (
                  <div className="bg-secondary p-2">
                    <code className="text-[10px] break-all leading-relaxed block font-mono">
                      {delegateKey}
                    </code>
                    <div className="flex justify-end mt-1">
                      <CopyButton value={delegateKey} label="key" />
                    </div>
                  </div>
                )}

                {keyError && (
                  <p className="text-[10px] text-destructive px-1">{keyError}</p>
                )}

                <Button
                  variant="secondary"
                  size="sm"
                  className="w-full"
                  disabled={exportKeyMutation.isPending}
                  onClick={handleRevealKey}
                >
                  {exportKeyMutation.isPending ? (
                    <><Loader2 className="size-3 mr-1.5 animate-spin" /> Verifying...</>
                  ) : showKey ? (
                    <><EyeOff className="size-3 mr-1.5" /> Hide Key</>
                  ) : (
                    <><Eye className="size-3 mr-1.5" /> Reveal Key</>
                  )}
                </Button>
              </div>
            )}

            {/* Logout */}
            <Button
              size="sm"
              variant="secondary"
              className="w-full mt-0.5"
              onClick={handleLogout}
            >
              <LogOut className="size-4 mr-2" />
              Logout
            </Button>
          </>
        )}
      </div>
    </div>
  );
}
