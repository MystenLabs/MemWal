"use client";

import {
  KeyRound,
  Eye,
  EyeOff,
  ArrowRight,
  Loader2,
  Lock,
  ChevronDown,
  Sparkles,
} from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { toast } from "@/components/toast";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { EnokiLoginCard } from "@/components/enoki-login-card";

export default function Page() {
  const router = useRouter();
  const [privateKey, setPrivateKey] = useState("");
  const [accountId, setAccountId] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [showKey, setShowKey] = useState(false);
  const [showAdvanced, setShowAdvanced] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    const trimmed = privateKey.trim();
    const trimmedAccountId = accountId.trim();
    if (!trimmedAccountId) {
      toast({ type: "error", description: "Please enter your account ID." });
      return;
    }
    if (!trimmed) {
      toast({ type: "error", description: "Please enter your private key." });
      return;
    }

    setIsLoading(true);

    try {
      const res = await fetch("/api/auth/key", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          privateKey: trimmed,
          accountId: trimmedAccountId,
        }),
      });

      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || "Authentication failed");
      }

      router.push("/");
      router.refresh();
    } catch (error) {
      toast({
        type: "error",
        description:
          error instanceof Error ? error.message : "Invalid private key",
      });
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div className="relative flex h-dvh w-screen items-center justify-center overflow-hidden bg-background">
      {/* Background decoration */}
      <div className="pointer-events-none absolute inset-0 overflow-hidden">
        <div className="absolute -top-[40%] left-1/2 h-[80%] w-[80%] -translate-x-1/2 rounded-full bg-gradient-to-b from-primary/[0.04] to-transparent blur-3xl dark:from-primary/[0.06]" />
        <div className="absolute -bottom-[20%] left-1/2 h-[60%] w-[60%] -translate-x-1/2 rounded-full bg-gradient-to-t from-primary/[0.03] to-transparent blur-3xl dark:from-primary/[0.04]" />
      </div>

      <div className="relative z-10 w-full max-w-[400px] px-6">
        {/* Logo / Brand */}
        <div className="mb-8 flex flex-col items-center gap-3">
          <div className="flex size-14 items-center justify-center rounded-2xl border bg-card shadow-sm">
            <Sparkles className="size-6 text-foreground" strokeWidth={1.5} />
          </div>
          <div className="flex flex-col items-center gap-1">
            <h1 className="font-semibold text-2xl tracking-tight">
              Researcher
            </h1>
            <p className="text-center text-muted-foreground text-sm leading-relaxed">
              AI-powered research with long-term memory
            </p>
          </div>
        </div>

        {/* Google Sign-in (Enoki) */}
        <EnokiLoginCard />

        {/* Divider */}
        <div className="my-5 flex items-center gap-3">
          <div className="h-px flex-1 bg-border" />
          <span className="text-muted-foreground text-xs">or</span>
          <div className="h-px flex-1 bg-border" />
        </div>

        {/* Advanced: Key login */}
        <div className="rounded-xl border bg-card shadow-sm">
          <button
            className="flex w-full items-center justify-between px-5 py-3.5 text-left text-muted-foreground text-sm transition-colors hover:text-foreground"
            onClick={() => setShowAdvanced(!showAdvanced)}
            type="button"
          >
            <span className="flex items-center gap-2">
              <KeyRound className="size-3.5" />
              Sign in with delegate key
            </span>
            <ChevronDown
              className={`size-4 transition-transform duration-200 ${showAdvanced ? "rotate-180" : ""}`}
            />
          </button>

          {showAdvanced && (
            <div className="border-t px-5 pb-5 pt-4">
              <form className="flex flex-col gap-3.5" onSubmit={handleSubmit}>
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="accountId" className="text-xs">
                    Account ID
                  </Label>
                  <Input
                    className="font-mono text-sm"
                    id="accountId"
                    onChange={(e) => setAccountId(e.target.value)}
                    placeholder="0x..."
                    required
                    value={accountId}
                  />
                </div>

                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="privateKey" className="text-xs">
                    Private Key
                  </Label>
                  <div className="relative">
                    <Input
                      className="pr-10 font-mono text-sm"
                      id="privateKey"
                      onChange={(e) => setPrivateKey(e.target.value)}
                      placeholder="64-character hex"
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
                      {showKey ? (
                        <EyeOff className="size-3.5" />
                      ) : (
                        <Eye className="size-3.5" />
                      )}
                    </button>
                  </div>
                </div>

                <Button
                  className="w-full"
                  disabled={
                    isLoading || !privateKey.trim() || !accountId.trim()
                  }
                  size="default"
                  type="submit"
                >
                  {isLoading ? (
                    <>
                      <Loader2 className="size-4 animate-spin" />
                      Authenticating...
                    </>
                  ) : (
                    <>
                      Sign In
                      <ArrowRight className="size-4" />
                    </>
                  )}
                </Button>
              </form>
            </div>
          )}
        </div>

        {/* Footer note */}
        <div className="mt-5 flex items-center justify-center gap-1.5 text-muted-foreground text-xs">
          <Lock className="size-3" />
          <span>Encrypted session — your keys never leave the server</span>
        </div>
      </div>
    </div>
  );
}
