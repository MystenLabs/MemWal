/**
 * USE AUTH HOOK
 * Main hook for authentication operations (Enoki + delegate key)
 */

"use client";

import { useCallback, useEffect } from "react";
import { useDisconnectWallet } from "@mysten/dapp-kit";
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

  // Wallet disconnect (clears dapp-kit autoConnect state)
  const { mutateAsync: disconnectWallet } = useDisconnectWallet();

  const utils = trpc.useUtils();

  // tRPC mutations
  const connectEnokiMutation = trpc.auth.connectEnoki.useMutation();
  const connectDelegateKeyMutation = trpc.auth.connectDelegateKey.useMutation();
  const logoutMutation = trpc.auth.logout.useMutation();

  // Session validation query. It takes no input: the server reads the session id
  // from the x-session-id header that TRPCProvider attaches, so the cache key no
  // longer varies per session and every session change has to reset it — see
  // resetSessionQuery below.
  const sessionQuery = trpc.auth.getSession.useQuery(undefined, {
    enabled: !!session?.sessionId,
    retry: false,
    refetchOnWindowFocus: false,
    refetchOnMount: true,
  });

  /**
   * Drop the cached session lookup so a result fetched for one session is never
   * read as the answer for the next one. Without this a cached null (a session
   * that had expired) would make the effect below clear the session that was
   * just established.
   */
  const resetSessionQuery = useCallback(
    () => utils.auth.getSession.reset(),
    [utils]
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
    async (params: {
      suiAddress: string;
      challengeId: string;
      signature: string;
      privateKey?: string;
      accountId?: string;
    }) => {
      try {
        const result = await connectEnokiMutation.mutateAsync(params);

        if ("needsSetup" in result && result.needsSetup) {
          return result;
        }

        if (result.sessionData) {
          setSession(result.sessionData);
          await resetSessionQuery();
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
        console.error("Enoki connection failed:", error);
        throw error;
      }
    },
    [connectEnokiMutation, setSession, setAuthenticated, resetSessionQuery]
  );

  /** Connect with delegate key (manual key + account ID). */
  const connectDelegateKey = useCallback(
    async (params: { privateKey: string; accountId: string }) => {
      try {
        const result = await connectDelegateKeyMutation.mutateAsync(params);

        setSession(result.sessionData);
        await resetSessionQuery();

        setAuthenticated({
          isAuthenticated: true,
          user: result.user,
          suiAddress: result.user.suiAddress,
          provider: null,
        });

        return result;
      } catch (error) {
        console.error("Delegate key connection failed:", error);
        throw error;
      }
    },
    [
      connectDelegateKeyMutation,
      setSession,
      setAuthenticated,
      resetSessionQuery,
    ]
  );

  /** Logout — clear session, auth state, and disconnect wallet (prevents autoConnect). */
  const logout = useCallback(async () => {
    try {
      if (session?.sessionId) {
        // No argument: the server ends the session behind the request header.
        await logoutMutation.mutateAsync();
      }
    } catch (error) {
      console.error("Logout failed:", error);
    }
    // Always disconnect wallet and clear auth, even if tRPC logout fails
    try {
      await disconnectWallet();
    } catch {
      // Wallet may already be disconnected
    }
    clearAuth();
    await resetSessionQuery();
  }, [
    session,
    logoutMutation,
    disconnectWallet,
    clearAuth,
    resetSessionQuery,
  ]);

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
