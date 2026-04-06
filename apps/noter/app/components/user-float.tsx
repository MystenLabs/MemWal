"use client";

import { useAuth } from "@/feature/auth";
import { Button } from "@/shared/components/ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/shared/components/ui/tooltip";
import { cn } from "@/shared/lib/utils";
import { Copy, LogOut, Minus, Key, Check, X } from "lucide-react";
import Image from "next/image";
import { useState, useEffect } from "react";

interface UserFloatPanelProps {
  className: string;
  onClose: () => void;
}

export function UserFloatPanel({ className, onClose }: UserFloatPanelProps) {
  const { user, suiAddress, logout } = useAuth();
  const [copied, setCopied] = useState(false);
  const [memwalKey, setMemwalKey] = useState("");
  const [memwalAccountId, setMemwalAccountId] = useState("");
  const [memwalStatus, setMemwalStatus] = useState<"idle" | "checking" | "connected" | "error">("idle");

  // Always check MemWal status on mount (key may come from .env or localStorage)
  useEffect(() => {
    const savedKey = localStorage.getItem("memwal_key");
    if (savedKey) {
      setMemwalKey(savedKey);
    }
    const savedAccountId = localStorage.getItem("memwal_account_id");
    if (savedAccountId) {
      setMemwalAccountId(savedAccountId);
    }
    // Always check health — server may have key from .env
    checkMemwalConnection();
  }, []);

  const checkMemwalConnection = async () => {
    setMemwalStatus("checking");
    try {
      const res = await fetch("/api/memory/health");
      const data = await res.json().catch(() => ({}));
      setMemwalStatus(res.ok && data.status === "ok" ? "connected" : "error");
    } catch {
      setMemwalStatus("error");
    }
  };

  const handleSaveKey = async () => {
    if (!memwalKey.trim()) return;
    localStorage.setItem("memwal_key", memwalKey.trim());
    if (memwalAccountId.trim()) {
      localStorage.setItem("memwal_account_id", memwalAccountId.trim());
    }

    // Save key to server-side via API
    try {
      const res = await fetch("/api/memory/set-key", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ key: memwalKey.trim(), accountId: memwalAccountId.trim() || undefined }),
      });
      if (res.ok) {
        setMemwalStatus("connected");
      } else {
        setMemwalStatus("error");
      }
    } catch {
      setMemwalStatus("error");
    }
  };

  const handleClearKey = () => {
    setMemwalKey("");
    setMemwalAccountId("");
    localStorage.removeItem("memwal_key");
    localStorage.removeItem("memwal_account_id");
    setMemwalStatus("idle");
    fetch("/api/memory/set-key", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ key: "", accountId: "" }),
    });
  };

  const copyAddress = () => {
    if (suiAddress) {
      navigator.clipboard.writeText(suiAddress);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  };

  const handleLogout = async () => {
    await logout();
    onClose();
    window.location.href = "/";
  };

  return (
    <div className={cn(className, "w-full max-w-sm")}>
      <div className="flex items-center justify-between p-1 shrink-0">
        <Button
          variant="secondary"
          size="sm"
          className="h-7 px-2 font-medium pointer-events-none"
        >
          Profile
        </Button>
        <div className="flex items-center">
          <Tooltip>
            <TooltipTrigger asChild>
              <Button variant="ghost" size="icon-sm" onClick={onClose}>
                <Minus className="size-4" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>Minimize</TooltipContent>
          </Tooltip>
        </div>
      </div>

      <div className="p-1 space-y-1">
        {user && (
          <>
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
                <p className="text-sm font-medium truncate">{user.name}</p>
                <p className="text-xs text-muted-foreground truncate">{user.email}</p>
              </div>
            </div>

            {suiAddress && (
              <div className="space-y-1">
                <div className="flex items-center gap-1.5">
                  <code className="flex-1 text-xs bg-secondary px-2 py-2.5 rounded truncate">
                    {suiAddress.slice(0, 8)}...{suiAddress.slice(-6)}
                  </code>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button
                        variant="secondary"
                        size="icon"
                        onClick={copyAddress}
                      >
                        <Copy className="size-3" />
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent>{copied ? "Copied!" : "Copy address"}</TooltipContent>
                  </Tooltip>
                </div>
              </div>
            )}

            {/* MemWal Key Section */}
            <div className="space-y-1.5 pt-1">
              <div className="flex items-center gap-1.5">
                <Key className="size-3.5 text-muted-foreground" />
                <span className="text-xs font-medium">MemWal Key</span>
                {memwalStatus === "connected" && (
                  <span className="ml-auto flex items-center gap-1 text-xs text-green-600 dark:text-green-400">
                    <Check className="size-3" />
                    On
                  </span>
                )}
                {memwalStatus === "error" && (
                  <span className="ml-auto flex items-center gap-1 text-xs text-red-500">
                    <X className="size-3" />
                    Error
                  </span>
                )}
              </div>
              <div className="flex items-center gap-1">
                <input
                  type="password"
                  placeholder="Ed25519 private key (hex)"
                  value={memwalKey}
                  onChange={(e) => setMemwalKey(e.target.value)}
                  className="flex-1 text-xs bg-secondary px-2 py-2 rounded border border-border outline-none focus:ring-1 focus:ring-ring font-mono"
                />
              </div>
              <div className="flex items-center gap-1">
                <input
                  type="text"
                  placeholder="Account ID (0x...)"
                  value={memwalAccountId}
                  onChange={(e) => setMemwalAccountId(e.target.value)}
                  className="flex-1 text-xs bg-secondary px-2 py-2 rounded border border-border outline-none focus:ring-1 focus:ring-ring font-mono"
                />
                {(memwalKey || memwalAccountId) ? (
                  <div className="flex gap-0.5">
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <Button variant="secondary" size="icon-sm" onClick={handleSaveKey}>
                          <Check className="size-3" />
                        </Button>
                      </TooltipTrigger>
                      <TooltipContent>Save key</TooltipContent>
                    </Tooltip>
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <Button variant="ghost" size="icon-sm" onClick={handleClearKey}>
                          <X className="size-3" />
                        </Button>
                      </TooltipTrigger>
                      <TooltipContent>Clear key</TooltipContent>
                    </Tooltip>
                  </div>
                ) : null}
              </div>
            </div>

            <Button
              size="sm"
              variant={'secondary'}
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
