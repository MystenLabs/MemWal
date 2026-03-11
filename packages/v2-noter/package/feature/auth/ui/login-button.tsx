/**
 * LOGIN BUTTON COMPONENT
 * Triggers OAuth zkLogin flow
 */

"use client";

import { Button } from "@/shared/components/ui/button";
import { Loader2 } from "lucide-react";
import type { LoginButtonProps } from "../domain/type";
import { useAuth } from "../hook/use-auth";

export function LoginButton({
  provider,
  onSuccess,
  onError,
  className,
}: LoginButtonProps) {
  const { login, isLoginPending } = useAuth();

  const handleLogin = async () => {
    try {
      await login(provider);
      onSuccess?.({} as any); // Will redirect, so this won't be called
    } catch (error) {
      onError?.(error instanceof Error ? error : new Error("Login failed"));
    }
  };

  const providerNames = {
    google: "Google",
    facebook: "Facebook",
    twitch: "Twitch",
  } as const;

  return (
    <Button
      onClick={handleLogin}
      disabled={isLoginPending}
      className={className}
    >
      {isLoginPending ? (
        <>
          <Loader2 className="mr-2 h-4 w-4 animate-spin" />
          Connecting...
        </>
      ) : (
        <>Continue with {providerNames[provider]}</>
      )}
    </Button>
  );
}
