/**
 * AUTH GUARD COMPONENT
 * Protects routes that require authentication
 */

"use client";

import { Loader2 } from "lucide-react";
import { redirect, useRouter } from "next/navigation";
import { useEffect } from "react";
import type { AuthGuardProps } from "../domain/type";
import { useAuth } from "../hook/use-auth";

export function AuthGuard({ children, fallback, redirectTo }: AuthGuardProps) {
  const { isAuthenticated, isLoading } = useAuth();
  const router = useRouter();

  useEffect(() => {
    if (!isLoading && !isAuthenticated && redirectTo) {
      router.push(redirectTo);
    }
  }, [isAuthenticated, isLoading, redirectTo, router]);

  if (isLoading) {
    return (
      <div className="flex h-screen items-center justify-center">
        <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (!isAuthenticated) {
    if (fallback) {
      return <>{fallback}</>;
    }

    redirect("/");
  }

  return <>{children}</>;
}
