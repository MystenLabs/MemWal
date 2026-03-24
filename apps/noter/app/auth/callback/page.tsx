/**
 * OAUTH CALLBACK PAGE
 * Handles OAuth redirect and completes zkLogin authentication
 */

"use client";

import { Suspense, useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { useAuth } from "@/feature/auth";
import { Loader2, AlertCircle } from "lucide-react";
import { Alert, AlertDescription } from "@/shared/components/ui/alert";

function AuthCallbackContent() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { completeLogin } = useAuth();
  const [error, setError] = useState<string | null>(null);
  const [isComplete, setIsComplete] = useState(false);
  const [hasRun, setHasRun] = useState(false);

  useEffect(() => {
    // Prevent infinite loop
    if (hasRun) return;

    const handleCallback = async () => {
      setHasRun(true);

      try {
        // Extract JWT from hash fragment (OpenID Connect response_type=id_token)
        const hash = window.location.hash.substring(1);
        const params = new URLSearchParams(hash);
        const idToken = params.get("id_token");
        const state = params.get("state"); // This is our sessionId

        if (!idToken) {
          throw new Error("No ID token received from OAuth provider");
        }

        if (!state) {
          throw new Error("No session ID in OAuth callback");
        }

        // Complete the login flow
        const result = await completeLogin(idToken, state);
        setIsComplete(true);

        // Give React time to flush state updates to storage
        await new Promise(resolve => setTimeout(resolve, 200));

        // Redirect to home page
        router.push("/");
      } catch (err) {
        setError(err instanceof Error ? err.message : "Authentication failed");
      }
    };

    handleCallback();
  }, [completeLogin, router]);

  if (error) {
    return (
      <div className="flex h-screen items-center justify-center p-4">
        <div className="w-full max-w-md">
          <Alert variant="destructive">
            <AlertCircle className="h-4 w-4" />
            <AlertDescription>
              {error}
            </AlertDescription>
          </Alert>
          <button
            onClick={() => router.push("/")}
            className="mt-4 w-full rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90"
          >
            Return Home
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-screen flex-col items-center justify-center gap-4">
      <Loader2 className="h-12 w-12 animate-spin text-primary" />
      <div className="text-center">
        <h2 className="text-xl font-semibold">Completing authentication...</h2>
        <p className="mt-2 text-sm text-muted-foreground">
          Generating zero-knowledge proof
        </p>
      </div>
    </div>
  );
}

export default function AuthCallbackPage() {
  return (
    <Suspense fallback={
      <div className="flex h-screen flex-col items-center justify-center gap-4">
        <Loader2 className="h-12 w-12 animate-spin text-primary" />
        <div className="text-center">
          <h2 className="text-xl font-semibold">Loading...</h2>
        </div>
      </div>
    }>
      <AuthCallbackContent />
    </Suspense>
  );
}
