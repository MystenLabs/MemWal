/**
 * usePDWVectorStore - React Hook for PDWVectorStore
 *
 * Convenience hook for initializing and managing PDWVectorStore in React applications.
 * Handles initialization, lifecycle, and provides easy access to the vector store.
 *
 * @example
 * ```typescript
 * import { usePDWVectorStore } from 'personal-data-wallet-sdk/hooks';
 * import { useCurrentAccount } from '@mysten/dapp-kit';
 *
 * function MyComponent() {
 *   const account = useCurrentAccount();
 *
 *   const { vectorStore, isReady, error } = usePDWVectorStore({
 *     userAddress: account?.address,
 *     packageId: '0x...',
 *     walrusAggregator: 'https://...',
 *     geminiApiKey: process.env.NEXT_PUBLIC_GEMINI_API_KEY!
 *   });
 *
 *   if (!isReady) return <div>Initializing...</div>;
 *   if (error) return <div>Error: {error.message}</div>;
 *
 *   // Use vectorStore...
 * }
 * ```
 */

import { useState, useEffect, useMemo } from 'react';
import { PDWEmbeddings } from '../langchain/PDWEmbeddings';
import { PDWVectorStore } from '../langchain/PDWVectorStore';
import type { PDWVectorStoreConfig } from '../langchain/PDWVectorStore';

export interface UsePDWVectorStoreOptions extends PDWVectorStoreConfig {
  /**
   * Whether to initialize immediately
   * @default true
   */
  enabled?: boolean;
}

export interface UsePDWVectorStoreReturn {
  /**
   * Initialized PDWVectorStore instance
   */
  vectorStore: PDWVectorStore | null;

  /**
   * PDWEmbeddings instance
   */
  embeddings: PDWEmbeddings | null;

  /**
   * Whether the vector store is ready to use
   */
  isReady: boolean;

  /**
   * Initialization error if any
   */
  error: Error | null;

  /**
   * Manually reinitialize the vector store
   */
  reinitialize: () => void;
}

/**
 * React hook for managing PDWVectorStore
 *
 * Automatically initializes PDWEmbeddings and PDWVectorStore,
 * handles lifecycle, and provides ready state.
 */
export function usePDWVectorStore(
  options: UsePDWVectorStoreOptions
): UsePDWVectorStoreReturn {
  const { enabled = true, ...config } = options;

  const [vectorStore, setVectorStore] = useState<PDWVectorStore | null>(null);
  const [embeddings, setEmbeddings] = useState<PDWEmbeddings | null>(null);
  const [isReady, setIsReady] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const [initTrigger, setInitTrigger] = useState(0);

  // Memoize config to avoid recreating on every render
  const stableConfig = useMemo(
    () => config,
    [
      config.userAddress,
      config.packageId,
      config.geminiApiKey,
      config.walrusAggregator,
      // Add other config dependencies as needed
    ]
  );

  useEffect(() => {
    if (!enabled || !stableConfig.userAddress || !stableConfig.geminiApiKey) {
      setIsReady(false);
      return;
    }

    let cancelled = false;

    const initialize = async () => {
      try {
        setError(null);
        setIsReady(false);

        // Initialize embeddings
        const embeddingsInstance = new PDWEmbeddings({
          geminiApiKey: stableConfig.geminiApiKey,
          model: stableConfig.embeddingModel,
          dimensions: stableConfig.embeddingDimensions,
        });

        if (cancelled) return;

        // Initialize vector store
        const vectorStoreInstance = new PDWVectorStore(
          embeddingsInstance,
          stableConfig
        );

        if (cancelled) return;

        setEmbeddings(embeddingsInstance);
        setVectorStore(vectorStoreInstance);
        setIsReady(true);
      } catch (err) {
        if (cancelled) return;
        setError(err instanceof Error ? err : new Error(String(err)));
        setIsReady(false);
      }
    };

    initialize();

    return () => {
      cancelled = true;
    };
  }, [enabled, stableConfig, initTrigger]);

  const reinitialize = () => {
    setInitTrigger(prev => prev + 1);
  };

  return {
    vectorStore,
    embeddings,
    isReady,
    error,
    reinitialize,
  };
}
