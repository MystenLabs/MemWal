/**
 * AUTH STATE ATOMS
 * Jotai atoms for authentication state management
 */

import { atom } from "jotai";
import { atomWithStorage, createJSONStorage } from "jotai/utils";
import type { AuthState, SessionData } from "../domain/type";
import { STORAGE_KEYS } from "../constant";

// ═══════════════════════════════════════════════════════════════
// Core Auth State
// ═══════════════════════════════════════════════════════════════

/**
 * Main authentication state
 * Synchronized across components
 */
export const authAtom = atom<AuthState>({
  isAuthenticated: false,
  user: null,
  suiAddress: null,
  provider: null,
  isLoading: true, // Start with loading to check persisted session
});

/**
 * Current session data
 * Persisted in sessionStorage (browser only)
 */
export const sessionAtom = atomWithStorage<SessionData | null>(
  STORAGE_KEYS.sessionId,
  null,
  createJSONStorage(() =>
    typeof window !== "undefined" ? sessionStorage : ({
      getItem: () => null,
      setItem: () => {},
      removeItem: () => {},
      length: 0,
      clear: () => {},
      key: () => null,
    } as Storage)
  ),
  { getOnInit: false }
);

// ═══════════════════════════════════════════════════════════════
// Derived Atoms
// ═══════════════════════════════════════════════════════════════

/**
 * Check if user is authenticated (read-only)
 */
export const isAuthenticatedAtom = atom((get) => get(authAtom).isAuthenticated);

/**
 * Get current user (read-only)
 */
export const currentUserAtom = atom((get) => get(authAtom).user);

/**
 * Get Sui address (read-only)
 */
export const suiAddressAtom = atom((get) => get(authAtom).suiAddress);

/**
 * Check if auth is loading (read-only)
 */
export const isLoadingAtom = atom((get) => get(authAtom).isLoading);

// ═══════════════════════════════════════════════════════════════
// Actions (Write-only atoms)
// ═══════════════════════════════════════════════════════════════

/**
 * Set authenticated state
 */
export const setAuthenticatedAtom = atom(
  null,
  (get, set, update: Omit<AuthState, "isLoading">) => {
    set(authAtom, {
      ...update,
      isLoading: false,
    });
  }
);

/**
 * Clear auth state (logout)
 */
export const clearAuthAtom = atom(null, (get, set) => {
  set(authAtom, {
    isAuthenticated: false,
    user: null,
    suiAddress: null,
    provider: null,
    isLoading: false,
  });
  set(sessionAtom, null);
});

/**
 * Set loading state
 */
export const setLoadingAtom = atom(null, (get, set, isLoading: boolean) => {
  set(authAtom, {
    ...get(authAtom),
    isLoading,
  });
});
