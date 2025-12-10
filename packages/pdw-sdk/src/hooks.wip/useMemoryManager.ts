/**
 * useMemoryManager - Foundation hook for Personal Data Wallet
 *
 * Creates and maintains a stable ClientMemoryManager instance.
 * Auto-configured from environment variables with optional overrides.
 *
 * @example
 * ```tsx
 * import { useMemoryManager } from 'personal-data-wallet-sdk/hooks';
 * import { useCurrentAccount } from '@mysten/dapp-kit';
 *
 * function MyComponent() {
 *   const account = useCurrentAccount();
 *   const manager = useMemoryManager({
 *     packageId: process.env.NEXT_PUBLIC_PACKAGE_ID
 *   });
 *
 *   if (!manager) return <div>Connect wallet to continue</div>;
 *
 *   return <div>Manager ready!</div>;
 * }
 * ```
 */

import { useMemo } from 'react';
import { ClientMemoryManager } from '../client/ClientMemoryManager';
import type { MemoryManagerConfig } from './utils/types';

export type { MemoryManagerConfig };

/**
 * Get environment variable with fallback
 */
function getEnvVar(key: string, fallback?: string): string | undefined {
  if (typeof process !== 'undefined' && process.env) {
    return process.env[key] || fallback;
  }
  return fallback;
}

/**
 * Initialize and provide access to ClientMemoryManager instance
 *
 * @param config - Optional configuration (uses env vars as defaults)
 * @returns ClientMemoryManager instance or null if wallet not connected
 */
export function useMemoryManager(config?: MemoryManagerConfig): ClientMemoryManager | null {
  // Merge config with environment variables
  const memoizedConfig = useMemo(() => {
    const packageId = config?.packageId || getEnvVar('NEXT_PUBLIC_PACKAGE_ID');
    const accessRegistryId = config?.accessRegistryId || getEnvVar('NEXT_PUBLIC_ACCESS_REGISTRY_ID');
    const walrusAggregator = config?.walrusAggregator || getEnvVar('NEXT_PUBLIC_WALRUS_AGGREGATOR');
    const geminiApiKey = config?.geminiApiKey || getEnvVar('NEXT_PUBLIC_GEMINI_API_KEY');

    // Validate required config
    if (!packageId || !accessRegistryId || !walrusAggregator || !geminiApiKey) {
      console.warn('⚠️ Missing required configuration for ClientMemoryManager');
      return null;
    }

    return {
      packageId,
      accessRegistryId,
      walrusAggregator,
      geminiApiKey,
      sealServerObjectIds: config?.sealServerObjectIds,
      walrusNetwork: config?.walrusNetwork || 'testnet',
      categories: config?.categories,
    };
  }, [
    config?.packageId,
    config?.accessRegistryId,
    config?.walrusAggregator,
    config?.geminiApiKey,
    config?.sealServerObjectIds,
    config?.walrusNetwork,
    config?.categories,
  ]);

  // Create stable manager instance
  const manager = useMemo(() => {
    if (!memoizedConfig) return null;

    try {
      return new ClientMemoryManager(memoizedConfig);
    } catch (error) {
      console.error('Failed to create ClientMemoryManager:', error);
      return null;
    }
  }, [memoizedConfig]);

  return manager;
}

export default useMemoryManager;
