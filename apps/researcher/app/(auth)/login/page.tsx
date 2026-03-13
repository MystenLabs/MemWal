"use client";

import { KeyRound, Eye, EyeOff, ArrowRight, Loader2, Lock } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { toast } from "@/components/toast";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

export default function Page() {
  const router = useRouter();
  const [privateKey, setPrivateKey] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [showKey, setShowKey] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    const trimmed = privateKey.trim();
    if (!trimmed) {
      toast({ type: "error", description: "Please enter your private key." });
      return;
    }

    setIsLoading(true);

    try {
      const res = await fetch("/api/auth/key", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ privateKey: trimmed }),
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
            <KeyRound className="size-6 text-foreground" strokeWidth={1.5} />
          </div>
          <div className="flex flex-col items-center gap-1">
            <h1 className="font-semibold text-2xl tracking-tight">
              Researcher
            </h1>
            <p className="text-muted-foreground text-sm">
              Sign in with your ed25519 key
            </p>
          </div>
        </div>

        {/* Card */}
        <div className="rounded-xl border bg-card p-6 shadow-sm">
          <form className="flex flex-col gap-4" onSubmit={handleSubmit}>
            <div className="flex flex-col gap-2">
              <Label htmlFor="privateKey">Private Key</Label>
              <div className="relative">
                <Input
                  autoFocus
                  className="pr-10 font-mono text-sm"
                  id="privateKey"
                  onChange={(e) => setPrivateKey(e.target.value)}
                  placeholder="Enter your private key"
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
                    <EyeOff className="size-4" />
                  ) : (
                    <Eye className="size-4" />
                  )}
                </button>
              </div>
            </div>

            <Button
              className="w-full"
              disabled={isLoading || !privateKey.trim()}
              size="lg"
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

        {/* Footer note */}
        <div className="mt-4 flex items-center justify-center gap-1.5 text-muted-foreground text-xs">
          <Lock className="size-3" />
          <span>Encrypted session cookie</span>
        </div>
      </div>
    </div>
  );
}
