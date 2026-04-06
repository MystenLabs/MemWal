/**
 * USE AUTH HOOK
 * Main hook for authentication operations (Enoki + delegate key)
 */

"use client";

import { useCallback, useEffect } from "react";
import { useAtom, useSetAtom } from "jotai";
import {
  authAtom,
  sessionAtom,
  setAuthenticatedAtom,
  clearAuthAtom,
  setLoadingAtom,
} from "../state/atom";
import { trpc } from "@/shared/lib/trpc/client";

export function useAuth() {
  const [auth, setAuth] = useAtom(authAtom);
  const [session, setSession] = useAtom(sessionAtom);
  const setAuthenticated = useSetAtom(setAuthenticatedAtom);
  const clearAuth = useSetAtom(clearAuthAtom);
  const setLoading = useSetAtom(setLoadingAtom);

  // tRPC mutations
  const connectEnokiMutation = trpc.auth.connectEnoki.useMutation();
  const connectDelegateKeyMutation = trpc.auth.connectDelegateKey.useMutation();
  const logoutMutation = trpc.auth.logout.useMutation();

  // Session validation query
  const sessionQuery = trpc.auth.getSession.useQuery(
    { sessionId: session?.sessionId || "" },
    {
      enabled: !!session?.sessionId,
      retry: false,
      refetchOnWindowFocus: false,
      refetchOnMount: true,
    }
  );

  /** Initialize authentication from persisted session. */
  useEffect(() => {
    if (session && !auth.isAuthenticated && sessionQuery.data) {
      setAuthenticated({
        isAuthenticated: true,
        user: sessionQuery.data.user,
        suiAddress: sessionQuery.data.suiAddress,
        provider: null,
      });
    } else if (session && sessionQuery.data === null && !sessionQuery.isLoading) {
      // Stale session — clear it
      setSession(null);
      setLoading(false);
    } else if (sessionQuery.isError || (!session && !auth.isAuthenticated)) {
      setLoading(false);
    }
  }, [session, sessionQuery.data, sessionQuery.isError, sessionQuery.isLoading, auth.isAuthenticated, setAuthenticated, setLoading, setSession]);

  /** Connect with Enoki zkLogin (two-phase: check returning user, then register). */
  const connectEnoki = useCallback(
    async (params: { suiAddress: string; privateKey?: string; accountId?: string }) => {
      try {
        setLoading(true);
        const result = await connectEnokiMutation.mutateAsync(params);

        if ("needsSetup" in result && result.needsSetup) {
          setLoading(false);
          return result;
        }

        if (result.sessionData) {
          setSession(result.sessionData);
        }

        if (result.user) {
          setAuthenticated({
            isAuthenticated: true,
            user: result.user,
            suiAddress: result.user.suiAddress,
            provider: null,
          });
        }

        return result;
      } catch (error) {
        setLoading(false);
        console.error("Enoki connection failed:", error);
        throw error;
      }
    },
    [connectEnokiMutation, setSession, setAuthenticated, setLoading]
  );

  /** Connect with delegate key (manual key + account ID). */
  const connectDelegateKey = useCallback(
    async (params: { privateKey: string; accountId: string }) => {
      try {
        setLoading(true);
        const result = await connectDelegateKeyMutation.mutateAsync(params);

        setSession(result.sessionData);

        setAuthenticated({
          isAuthenticated: true,
          user: result.user,
          suiAddress: result.user.suiAddress,
          provider: null,
        });

        return result;
      } catch (error) {
        setLoading(false);
        console.error("Delegate key connection failed:", error);
        throw error;
      }
    },
    [connectDelegateKeyMutation, setSession, setAuthenticated, setLoading]
  );

  /** Logout — clear session and auth state. */
  const logout = useCallback(async () => {
    try {
      if (session?.sessionId) {
        await logoutMutation.mutateAsync({ sessionId: session.sessionId });
      }
      clearAuth();
    } catch (error) {
      console.error("Logout failed:", error);
      clearAuth();
    }
  }, [session, logoutMutation, clearAuth]);

  return {
    ...auth,
    session,
    connectEnoki,
    connectDelegateKey,
    logout,
    isLoginPending: connectEnokiMutation.isPending || connectDelegateKeyMutation.isPending,
    isLogoutPending: logoutMutation.isPending,
  };
}
