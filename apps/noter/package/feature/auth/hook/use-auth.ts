/**
 * USE AUTH HOOK
 * Main hook for authentication operations
 */

"use client";

import { useCallback, useEffect } from "react";
import { useAtom, useSetAtom, useAtomValue } from "jotai";
import {
  authAtom,
  sessionAtom,
  setAuthenticatedAtom,
  clearAuthAtom,
  setLoadingAtom,
} from "../state/atom";
import { trpc } from "@/shared/lib/trpc/client";
import type { OAuthProvider } from "../constant";

export function useAuth() {
  const [auth, setAuth] = useAtom(authAtom);
  const [session, setSession] = useAtom(sessionAtom);
  const setAuthenticated = useSetAtom(setAuthenticatedAtom);
  const clearAuth = useSetAtom(clearAuthAtom);
  const setLoading = useSetAtom(setLoadingAtom);

  // tRPC mutations
  const initiateLoginMutation = trpc.auth.initiateLogin.useMutation();
  const completeLoginMutation = trpc.auth.completeLogin.useMutation();
  const connectWalletMutation = trpc.auth.connectWallet.useMutation();
  const logoutMutation = trpc.auth.logout.useMutation();

  // tRPC query for session validation
  const sessionQuery = trpc.auth.getSession.useQuery(
    { sessionId: session?.sessionId || "" },
    {
      enabled: !!session?.sessionId,
      retry: false,
      refetchOnWindowFocus: false,
      refetchOnMount: true,
    }
  );

  /**
   * Initialize authentication from persisted session
   */
  useEffect(() => {
    if (session && !auth.isAuthenticated && sessionQuery.data) {
      setAuthenticated({
        isAuthenticated: true,
        user: sessionQuery.data.user,
        suiAddress: sessionQuery.data.suiAddress,
        provider: sessionQuery.data.user.provider as OAuthProvider,
      });
    } else if (session && sessionQuery.data === null && !sessionQuery.isLoading) {
      // Session exists in atom but not in database - it's stale
      setSession(null);
      setLoading(false);
    } else if (sessionQuery.isError || (!session && !auth.isAuthenticated)) {
      setLoading(false);
    }
  }, [session, sessionQuery.data, sessionQuery.isError, sessionQuery.isLoading, auth.isAuthenticated, setAuthenticated, setLoading, setSession]);

  /**
   * Initiate OAuth login flow
   * Redirects user to OAuth provider
   */
  const login = useCallback(
    async (provider: OAuthProvider) => {
      try {
        setLoading(true);
        const result = await initiateLoginMutation.mutateAsync({
          provider,
        });

        // Store session ID temporarily
        setSession({
          sessionId: result.sessionId,
          ephemeralKeyPair: {
            privateKey: "",
            publicKey: "",
          },
          maxEpoch: 0,
          randomness: "",
          nonce: result.nonce,
          expiresAt: new Date(),
        });

        // Redirect to OAuth provider
        window.location.href = result.authUrl;
      } catch (error) {
        setLoading(false);
        console.error("Login failed:", error);
        throw error;
      }
    },
    [initiateLoginMutation, setSession, setLoading]
  );

  /**
   * Complete login after OAuth callback
   * Call this from /auth/callback route with JWT
   */
  const completeLogin = useCallback(
    async (jwt: string, sessionId: string) => {
      try {
        setLoading(true);

        const result = await completeLoginMutation.mutateAsync({
          jwt,
          sessionId,
        });

        // Update session with complete data
        setSession(result.sessionData);

        // Update auth state immediately
        setAuthenticated({
          isAuthenticated: true,
          user: result.user,
          suiAddress: result.suiAddress,
          provider: result.user.provider as OAuthProvider,
        });

        return result;
      } catch (error) {
        setLoading(false);
        console.error("Complete login failed:", error);
        throw error;
      }
    },
    [completeLoginMutation, setSession, setAuthenticated, setLoading]
  );

  /**
   * Connect wallet and authenticate
   * Call this after user signs message with their wallet
   */
  const connectWalletAuth = useCallback(
    async (params: {
      walletType: "slush";
      address: string;
      signature: string;
      message: string;
    }) => {
      try {
        setLoading(true);

        const result = await connectWalletMutation.mutateAsync(params);

        // Update session with complete data
        setSession(result.sessionData);

        // Update auth state immediately
        setAuthenticated({
          isAuthenticated: true,
          user: result.user,
          suiAddress: result.user.suiAddress,
          provider: null, // No OAuth provider for wallet auth
        });

        return result;
      } catch (error) {
        setLoading(false);
        console.error("Wallet connection failed:", error);
        throw error;
      }
    },
    [connectWalletMutation, setSession, setAuthenticated, setLoading]
  );

  /**
   * Logout user
   * Clears session and auth state
   */
  const logout = useCallback(async () => {
    try {
      if (session?.sessionId) {
        await logoutMutation.mutateAsync({
          sessionId: session.sessionId,
        });
      }

      clearAuth();
    } catch (error) {
      console.error("Logout failed:", error);
      // Clear state anyway
      clearAuth();
    }
  }, [session, logoutMutation, clearAuth]);

  return {
    // State
    ...auth,

    // Session data
    session,

    // Actions
    login,
    completeLogin,
    connectWalletAuth,
    logout,

    // Loading states
    isLoginPending: initiateLoginMutation.isPending || completeLoginMutation.isPending || connectWalletMutation.isPending,
    isLogoutPending: logoutMutation.isPending,
  };
}
