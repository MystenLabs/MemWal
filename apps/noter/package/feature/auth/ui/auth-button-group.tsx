/**
 * AUTH BUTTON GROUP
 * Sign in with Google (Enoki) + collapsible delegate key login
 */

"use client";

import { Button } from "@/shared/components/ui/button";
import { Input } from "@/shared/components/ui/input";
import { ChevronDown, KeyRound, Loader2, ArrowRight, Eye, EyeOff } from "lucide-react";
import { useState } from "react";
import { useAuth } from "../hook/use-auth";
import { EnokiLoginCard } from "@/app/components/enoki-login-card";

export function AuthButtonGroup() {
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [privateKey, setPrivateKey] = useState("");
  const [accountId, setAccountId] = useState("");
  const [showKey, setShowKey] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { connectDelegateKey, isLoginPending } = useAuth();

  const handleDelegateKeySubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const trimmedKey = privateKey.trim();
    const trimmedAccountId = accountId.trim();

    if (!trimmedKey || !trimmedAccountId) {
      setError("Both fields are required.");
      return;
    }

    setError(null);
    try {
      await connectDelegateKey({
        privateKey: trimmedKey,
        accountId: trimmedAccountId,
      });
      window.location.href = "/note";
    } catch (err) {
      setError(err instanceof Error ? err.message : "Authentication failed");
    }
  };

  return (
    <div className="flex flex-col gap-3 w-full max-w-sm mx-auto">
      {/* Google Sign-in (Enoki) */}
      <EnokiLoginCard />

      {/* Divider */}
      <div className="flex items-center gap-3">
        <div className="h-px flex-1 bg-border" />
        <span className="text-muted-foreground text-xs">or</span>
        <div className="h-px flex-1 bg-border" />
      </div>

      {/* Advanced: Delegate key login */}
      <div className="border bg-card">
        <button
          className="flex w-full items-center justify-between px-4 py-3 text-left text-muted-foreground text-sm transition-colors hover:text-foreground"
          onClick={() => setShowAdvanced(!showAdvanced)}
          type="button"
        >
          <span className="flex items-center gap-2">
            <KeyRound className="h-3.5 w-3.5" />
            Sign in with delegate key
          </span>
          <ChevronDown
            className={`h-4 w-4 transition-transform duration-200 ${showAdvanced ? "rotate-180" : ""}`}
          />
        </button>

        {showAdvanced && (
          <form
            className="border-t px-4 pb-4 pt-3 flex flex-col gap-3"
            onSubmit={handleDelegateKeySubmit}
          >
            <Input
              className="font-mono text-sm"
              onChange={(e) => setAccountId(e.target.value)}
              placeholder="Account ID (0x...)"
              required
              value={accountId}
            />
            <div className="relative">
              <Input
                className="pr-10 font-mono text-sm"
                onChange={(e) => setPrivateKey(e.target.value)}
                placeholder="Private key (64 hex)"
                required
                type={showKey ? "text" : "password"}
                value={privateKey}
              />
              <button
                className="absolute top-1/2 right-3 -translate-y-1/2 text-muted-foreground transition-colors hover:text-foreground"
                onClick={() => setShowKey(!showKey)}
                tabIndex={-1}
                type="button"
              >
                {showKey ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
              </button>
            </div>
            <Button
              className="w-full"
              disabled={isLoginPending || !privateKey.trim() || !accountId.trim()}
              type="submit"
            >
              {isLoginPending ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  Authenticating...
                </>
              ) : (
                <>
                  Sign In
                  <ArrowRight className="ml-2 h-4 w-4" />
                </>
              )}
            </Button>
          </form>
        )}
      </div>

      {error && <p className="text-xs text-destructive text-center">{error}</p>}
    </div>
  );
}
