/**
 * useMemoryServices - Core hook for client-side memory services
 *
 * Manages lifecycle of browser-compatible services:
 * - EmbeddingService (Gemini API)
 * - BrowserHnswIndexService (hnswlib-wasm + IndexedDB)
 * - BrowserKnowledgeGraphManager (IndexedDB)
 *
 * Services are singletons per user address, shared across components.
 */

import { useEffect, useState, useMemo } from 'react';
import { EmbeddingService } from '../services/EmbeddingService';
import { GeminiAIService } from '../services/GeminiAIService';
import { BrowserHnswIndexService } from '../vector/BrowserHnswIndexService';
import { BrowserKnowledgeGraphManager } from '../graph/BrowserKnowledgeGraphManager';
import { StorageService } from '../services/StorageService';
import { EncryptionService } from '../services/EncryptionService';

export interface MemoryServicesConfig {
  geminiApiKey?: string; // Optional but recommended for AI services
  embeddingModel?: string;
  embeddingDimension?: number;
  hnswMaxElements?: number;
  hnswM?: number;
  hnswEfConstruction?: number;
  batchSize?: number;
  batchDelayMs?: number;
  packageId?: string;
  walrusAggregator?: string;
  walrusPublisher?: string;
  sealServerObjectIds?: string[];
  suiClient?: any;
}

export interface MemoryServices {
  embeddingService: EmbeddingService | null;
  geminiAIService: GeminiAIService | null;
  hnswService: BrowserHnswIndexService | null;
  graphManager: BrowserKnowledgeGraphManager | null;
  storageService: StorageService | null;
  encryptionService: EncryptionService | null;
  isReady: boolean;
  isLoading: boolean;
  error: Error | null;
}

// Singleton store for services (shared across all hooks)
const servicesStore = new Map<string, {
  embedding: EmbeddingService;
  geminiAI: GeminiAIService;
  hnsw: BrowserHnswIndexService;
  graph: BrowserKnowledgeGraphManager;
  storage: StorageService;
  encryption: EncryptionService;
  refCount: number;
}>();

/**
 * Initialize and manage memory services for client-side operations
 *
 * @param userAddress - User's blockchain address (used as unique identifier)
 * @param config - Optional configuration for services
 * @returns Memory services and loading state
 *
 * @example
 * ```tsx
 * function MyComponent() {
 *   const account = useCurrentAccount();
 *   const { embeddingService, hnswService, isReady } = useMemoryServices(
 *     account?.address,
 *     { geminiApiKey: process.env.NEXT_PUBLIC_GEMINI_API_KEY }
 *   );
 *
 *   if (!isReady) return <Loading />;
 *   // Use services...
 * }
 * ```
 */
export function useMemoryServices(
  userAddress?: string,
  config: MemoryServicesConfig = {}
): MemoryServices {
  const [isReady, setIsReady] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<Error | null>(null);

  // Memoize config to prevent re-initialization
  const memoizedConfig = useMemo(() => ({
    geminiApiKey: config.geminiApiKey || '',
    embeddingModel: config.embeddingModel || 'text-embedding-004',
    embeddingDimension: config.embeddingDimension || 768,
    hnswMaxElements: config.hnswMaxElements || 10000,
    hnswM: config.hnswM || 16,
    hnswEfConstruction: config.hnswEfConstruction || 200,
    batchSize: config.batchSize || 50,
    batchDelayMs: config.batchDelayMs || 5000,
    packageId: config.packageId || '',
    walrusAggregator: config.walrusAggregator || 'https://aggregator.walrus-testnet.walrus.space',
    walrusPublisher: config.walrusPublisher || 'https://publisher.walrus-testnet.walrus.space',
    sealServerObjectIds: config.sealServerObjectIds || [
      '0x73d05d62c18d9374e3ea529e8e0ed6161da1a141a94d3f76ae3fe4e99356db75',
      '0xf5d14a81a982144ae441cd7d64b09027f116a468bd36e7eca494f750591623c8'
    ],
    suiClient: config.suiClient
  }), [
    config.geminiApiKey,
    config.embeddingModel,
    config.embeddingDimension,
    config.hnswMaxElements,
    config.hnswM,
    config.hnswEfConstruction,
    config.batchSize,
    config.batchDelayMs,
    config.packageId,
    config.walrusAggregator,
    config.walrusPublisher,
    config.sealServerObjectIds,
    config.suiClient
  ]);

  // Initialize services on mount
  useEffect(() => {
    if (!userAddress) {
      setIsReady(false);
      return;
    }

    // Increment ref count on mount
    if (servicesStore.has(userAddress)) {
      const existing = servicesStore.get(userAddress)!;
      existing.refCount++;
      setIsReady(true);
      console.log(`✅ Using existing services for ${userAddress} (refCount: ${existing.refCount})`);
    }

    let mounted = true;

    const initializeServices = async () => {
      try {
        setIsLoading(true);
        setError(null);

        // Check if services already exist (already checked above, but keeping for clarity)
        if (servicesStore.has(userAddress)) {
          setIsReady(true);
          setIsLoading(false);
          return;
        }

        // DEBUG: Log the API key status
        console.log('🔍 useMemoryServices - Initializing with config:', {
          hasGeminiApiKey: !!memoizedConfig.geminiApiKey,
          apiKeyPreview: memoizedConfig.geminiApiKey ? `${memoizedConfig.geminiApiKey.substring(0, 10)}...` : 'UNDEFINED',
          model: memoizedConfig.embeddingModel,
          dimensions: memoizedConfig.embeddingDimension
        });

        // Initialize embedding service
        const embeddingService = new EmbeddingService({
          apiKey: memoizedConfig.geminiApiKey,
          model: memoizedConfig.embeddingModel,
          dimensions: memoizedConfig.embeddingDimension
        });

        // Initialize Gemini AI service for metadata extraction
        const geminiAIService = new GeminiAIService({
          apiKey: memoizedConfig.geminiApiKey,
          model: 'gemini-2.5-flash-lite',
          temperature: 0.1
        });

        // Initialize HNSW service
        const hnswService = new BrowserHnswIndexService(
          {
            dimension: memoizedConfig.embeddingDimension,
            maxElements: memoizedConfig.hnswMaxElements,
            m: memoizedConfig.hnswM,
            efConstruction: memoizedConfig.hnswEfConstruction
          },
          {
            maxBatchSize: memoizedConfig.batchSize,
            batchDelayMs: memoizedConfig.batchDelayMs
          }
        );

        // Initialize knowledge graph manager
        const graphManager = new BrowserKnowledgeGraphManager();

        // Initialize storage service
        const storageService = new StorageService({
          walrusAggregatorUrl: memoizedConfig.walrusAggregator,
          walrusPublisherUrl: memoizedConfig.walrusPublisher,
          packageId: memoizedConfig.packageId,
          suiClient: memoizedConfig.suiClient,
          network: 'testnet',
          useUploadRelay: true
        });

        // Initialize encryption service
        const encryptionService = new EncryptionService(
          memoizedConfig.suiClient,
          {
            packageId: memoizedConfig.packageId,
            encryptionConfig: {
              enabled: true,
              keyServers: memoizedConfig.sealServerObjectIds
            }
          }
        );

        // Try to load existing index from IndexedDB
        try {
          await hnswService.loadIndexFromDB(userAddress);
          console.log('✅ Loaded existing HNSW index from IndexedDB');
        } catch (err) {
          console.log('ℹ️ No existing index found, will create on first add');
        }

        // Store services
        servicesStore.set(userAddress, {
          embedding: embeddingService,
          geminiAI: geminiAIService,
          hnsw: hnswService,
          graph: graphManager,
          storage: storageService,
          encryption: encryptionService,
          refCount: 1
        });

        if (mounted) {
          setIsReady(true);
          setIsLoading(false);
        }
      } catch (err) {
        console.error('Failed to initialize memory services:', err);
        if (mounted) {
          setError(err as Error);
          setIsLoading(false);
        }
      }
    };

    initializeServices();

    // Cleanup on unmount
    return () => {
      mounted = false;

      if (userAddress && servicesStore.has(userAddress)) {
        const services = servicesStore.get(userAddress)!;
        services.refCount--;

        // Destroy services if no more references
        if (services.refCount <= 0) {
          console.log(`🧹 Cleaning up services for user ${userAddress}`);
          services.hnsw.destroy();
          services.graph.destroy();
          servicesStore.delete(userAddress);
        }
      }
    };
  }, [userAddress, memoizedConfig]);

  // Return current services (get from store directly)
  if (!userAddress) {
    return {
      embeddingService: null,
      geminiAIService: null,
      hnswService: null,
      graphManager: null,
      storageService: null,
      encryptionService: null,
      isReady: false,
      isLoading,
      error
    };
  }

  // Get services from store
  const services = servicesStore.get(userAddress);

  if (!services || !isReady) {
    return {
      embeddingService: null,
      geminiAIService: null,
      hnswService: null,
      graphManager: null,
      storageService: null,
      encryptionService: null,
      isReady: false,
      isLoading,
      error
    };
  }

  return {
    embeddingService: services.embedding,
    geminiAIService: services.geminiAI,
    hnswService: services.hnsw,
    graphManager: services.graph,
    storageService: services.storage,
    encryptionService: services.encryption,
    isReady,
    isLoading,
    error
  };
}

/**
 * Clear all services for a specific user (useful for logout)
 */
export function clearMemoryServices(userAddress: string): void {
  if (servicesStore.has(userAddress)) {
    const services = servicesStore.get(userAddress)!;
    services.hnsw.destroy();
    services.graph.destroy();
    servicesStore.delete(userAddress);
    console.log(`✅ Cleared services for user ${userAddress}`);
  }
}

/**
 * Get current service statistics
 */
export function getMemoryServicesStats() {
  return {
    activeUsers: servicesStore.size,
    services: Array.from(servicesStore.entries()).map(([userAddress, services]) => ({
      userAddress,
      refCount: services.refCount,
      hnswStats: services.hnsw.getCacheStats()
    }))
  };
}
