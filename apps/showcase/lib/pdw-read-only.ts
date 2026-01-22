import { getFullnodeUrl, SuiClient } from '@mysten/sui/client';
import { getChatModel } from '@cmdoss/memwal-sdk';

// ============================================================================
// LRU Cache with TTL for PDW Clients - Prevents Memory Leaks
// Uses globalThis for cross-route caching in Next.js
// ============================================================================

interface CachedClient {
  client: any;
  lastAccessed: number;
  createdAt: number;
}

interface GlobalPDWCache {
  readOnlyClients: Map<string, CachedClient>;
  SimplePDWClient: any;
  rebuildInProgress: Map<string, Promise<void>>;
  initializationInProgress: Map<string, Promise<any>>;
  cleanupInterval: NodeJS.Timeout | null;
}

// Configuration
const MAX_CACHED_CLIENTS = 5; // Maximum number of clients to keep in memory
const CLIENT_TTL_MS = 5 * 60 * 1000; // 5 minutes TTL
const CLEANUP_INTERVAL_MS = 60 * 1000; // Check for expired clients every 1 minute

// Use globalThis to share cache across all Next.js API routes
// This prevents module isolation from creating separate caches per route
const GLOBAL_CACHE_KEY = '__PDW_CLIENT_CACHE__';

function getGlobalCache(): GlobalPDWCache {
  if (!(globalThis as any)[GLOBAL_CACHE_KEY]) {
    (globalThis as any)[GLOBAL_CACHE_KEY] = {
      readOnlyClients: new Map<string, CachedClient>(),
      SimplePDWClient: null,
      rebuildInProgress: new Map<string, Promise<void>>(),
      initializationInProgress: new Map<string, Promise<any>>(),
      cleanupInterval: null,
    };
    console.log('🔧 [Cache] Initialized global PDW client cache');
  }
  return (globalThis as any)[GLOBAL_CACHE_KEY];
}

// Accessor functions for global cache
const getReadOnlyClients = () => getGlobalCache().readOnlyClients;
const getRebuildInProgress = () => getGlobalCache().rebuildInProgress;
const getInitializationInProgress = () => getGlobalCache().initializationInProgress;

function getSimplePDWClient() {
  return getGlobalCache().SimplePDWClient;
}

function setSimplePDWClient(client: any) {
  getGlobalCache().SimplePDWClient = client;
}

function getCleanupInterval() {
  return getGlobalCache().cleanupInterval;
}

function setCleanupInterval(interval: NodeJS.Timeout | null) {
  getGlobalCache().cleanupInterval = interval;
}

/**
 * Start the cleanup interval if not already running
 */
function startCleanupInterval() {
  if (getCleanupInterval()) return;

  const interval = setInterval(() => {
    cleanupExpiredClients();
  }, CLEANUP_INTERVAL_MS);

  // Don't keep the process alive just for cleanup
  if (interval.unref) {
    interval.unref();
  }

  setCleanupInterval(interval);
}

/**
 * Clean up expired clients based on TTL
 */
function cleanupExpiredClients() {
  const now = Date.now();
  const expiredKeys: string[] = [];
  const clients = getReadOnlyClients();

  for (const [key, cached] of clients.entries()) {
    if (now - cached.lastAccessed > CLIENT_TTL_MS) {
      expiredKeys.push(key);
    }
  }

  for (const key of expiredKeys) {
    console.log(`🧹 [Cache] Removing expired client for: ${key.substring(0, 10)}...`);
    disposeClient(key);
  }

  if (expiredKeys.length > 0) {
    console.log(`🧹 [Cache] Cleaned up ${expiredKeys.length} expired clients. Active: ${clients.size}`);
  }
}

/**
 * Evict least recently used client if cache is full
 */
function evictLRUIfNeeded() {
  const clients = getReadOnlyClients();
  if (clients.size < MAX_CACHED_CLIENTS) return;

  let oldestKey: string | null = null;
  let oldestTime = Infinity;

  for (const [key, cached] of clients.entries()) {
    if (cached.lastAccessed < oldestTime) {
      oldestTime = cached.lastAccessed;
      oldestKey = key;
    }
  }

  if (oldestKey) {
    console.log(`🧹 [Cache] Evicting LRU client for: ${oldestKey.substring(0, 10)}...`);
    disposeClient(oldestKey);
  }
}

/**
 * Dispose a client and remove from cache
 */
function disposeClient(walletAddress: string) {
  const clients = getReadOnlyClients();
  const cached = clients.get(walletAddress);
  if (cached) {
    try {
      // Try to call dispose/cleanup if available on the client
      if (typeof cached.client?.dispose === 'function') {
        cached.client.dispose();
      }
      if (typeof cached.client?.cleanup === 'function') {
        cached.client.cleanup();
      }
    } catch (e) {
      // Ignore disposal errors
    }
    clients.delete(walletAddress);
  }
  // Also clean up any pending rebuild promises
  getRebuildInProgress().delete(walletAddress);
}

/**
 * Get embedding configuration from environment
 */
function getEmbeddingConfig() {
  const embeddingProvider = (process.env.EMBEDDING_PROVIDER as 'google' | 'openai' | 'openrouter' | 'cohere') || 'openrouter';
  const embeddingApiKey = process.env.EMBEDDING_API_KEY || process.env.OPENROUTER_API_KEY || process.env.GEMINI_API_KEY;
  const embeddingModelName = process.env.EMBEDDING_MODEL || undefined;
  const embeddingDimensions = process.env.EMBEDDING_DIMENSIONS ? parseInt(process.env.EMBEDDING_DIMENSIONS) : undefined;

  if (!embeddingApiKey) {
    throw new Error('Missing embedding API key. Set EMBEDDING_API_KEY, OPENROUTER_API_KEY, or GEMINI_API_KEY');
  }

  return {
    provider: embeddingProvider,
    apiKey: embeddingApiKey,
    ...(embeddingModelName && { modelName: embeddingModelName }),
    ...(embeddingDimensions && { dimensions: embeddingDimensions }),
  };
}

/**
 * Create a UnifiedSigner that implements the full interface but throws on signing operations.
 * This allows using SimplePDWClient for read-only operations without a real private key.
 *
 * The SDK checks for 'signAndExecuteTransaction', 'signPersonalMessage', and 'getAddress'
 * to detect a UnifiedSigner, so we must implement all three methods.
 */
function createReadOnlySigner(userAddress: string) {
  return {
    // Required UnifiedSigner interface methods
    getAddress: () => userAddress,

    signAndExecuteTransaction: async () => {
      throw new Error('Read-only client cannot sign transactions. Use client-side signing with Slush wallet.');
    },

    signPersonalMessage: async () => {
      throw new Error('Read-only client cannot sign messages. Use client-side signing with Slush wallet.');
    },

    getPublicKey: () => null,

    getSigner: () => {
      throw new Error('Read-only client does not have a Signer. Use client-side signing with Slush wallet.');
    },
  };
}

/**
 * Load the SimplePDWClient class
 */
async function loadPDWClientClass() {
  const cachedClass = getSimplePDWClient();
  if (cachedClass) return cachedClass;

  try {
    const pdwModule = await import('@cmdoss/memwal-sdk');
    const ClientClass = pdwModule.SimplePDWClient;
    if (!ClientClass) {
      throw new Error('SimplePDWClient not found in SDK export');
    }
    setSimplePDWClient(ClientClass);
    return ClientClass;
  } catch (error: any) {
    console.error('❌ Failed to load PDW SDK:', error?.message);
    throw error;
  }
}

/**
 * Get or create a read-only PDW client for a specific wallet address
 * Used for querying memories without needing private key
 */
export async function getReadOnlyPDWClient(walletAddress: string): Promise<any> {
  // Skip during build
  if (process.env.NEXT_PHASE === 'phase-production-build') {
    throw new Error('PDW Client not available during build time');
  }

  if (!walletAddress) {
    throw new Error('walletAddress is required');
  }

  // Start cleanup interval on first access
  startCleanupInterval();

  const clients = getReadOnlyClients();
  const initInProgress = getInitializationInProgress();

  // Return cached client if exists and update last accessed time
  const cached = clients.get(walletAddress);
  if (cached) {
    cached.lastAccessed = Date.now();
    console.log(`📦 [Cache] Hit for: ${walletAddress.substring(0, 10)}... (${clients.size} cached)`);
    return cached.client;
  }

  // Check if initialization is already in progress for this wallet
  // This prevents race condition where multiple concurrent requests create multiple clients
  const existingInit = initInProgress.get(walletAddress);
  if (existingInit) {
    console.log(`⏳ [Cache] Waiting for initialization in progress for: ${walletAddress.substring(0, 10)}...`);
    return existingInit;
  }

  // Create initialization promise and store it
  const initPromise = createAndCacheClient(walletAddress);
  initInProgress.set(walletAddress, initPromise);

  try {
    return await initPromise;
  } finally {
    // Clean up initialization lock
    initInProgress.delete(walletAddress);
  }
}

/**
 * Internal function to create and cache a new PDW client
 */
async function createAndCacheClient(walletAddress: string): Promise<any> {
  // Evict LRU client if cache is full before creating new one
  evictLRUIfNeeded();

  const ClientClass = await loadPDWClientClass();
  const network = (process.env.SUI_NETWORK as 'testnet' | 'mainnet') || 'testnet';
  const packageId = process.env.PACKAGE_ID;

  if (!packageId) {
    throw new Error('Missing PACKAGE_ID environment variable');
  }

  try {
    // Get AI API key for Knowledge Graph (OpenRouter)
    const aiApiKey = process.env.OPENROUTER_API_KEY || process.env.GEMINI_API_KEY;

    const client = new ClientClass({
      signer: createReadOnlySigner(walletAddress),
      userAddress: walletAddress,
      network,
      // geminiApiKey is used for Knowledge Graph entity extraction (supports OpenRouter)
      geminiApiKey: aiApiKey,
      sui: {
        packageId,
        network,
      },
      embedding: getEmbeddingConfig(),
      // AI config for chat/analysis
      ai: {
        apiKey: aiApiKey,
        chatModel: getChatModel(),
      },
      walrus: {
        aggregatorUrl: process.env.WALRUS_AGGREGATOR || 'https://aggregator.walrus-testnet.walrus.space',
        publisherUrl: process.env.WALRUS_PUBLISHER || 'https://publisher.walrus-testnet.walrus.space',
      },
      features: {
        enableEncryption: true,
        enableLocalIndexing: true,
        enableKnowledgeGraph: !!aiApiKey, // Only enable if API key is available
      },
      // Enable Walrus backup for local index (cloud sync)
      indexBackup: {
        enabled: true,
        aggregatorUrl: process.env.WALRUS_AGGREGATOR || 'https://aggregator.walrus-testnet.walrus.space',
        publisherUrl: process.env.WALRUS_PUBLISHER || 'https://publisher.walrus-testnet.walrus.space',
        autoSync: false, // Don't auto-sync on every save (manual sync preferred)
        epochs: 3,
      },
    });

    await client.ready();
    const now = Date.now();
    console.log(`✅ Read-only PDW Client initialized for: ${walletAddress}`);

    // Cache the client with metadata
    const clients = getReadOnlyClients();
    clients.set(walletAddress, {
      client,
      lastAccessed: now,
      createdAt: now,
    });
    console.log(`📦 [Cache] Added client for: ${walletAddress.substring(0, 10)}... (${clients.size}/${MAX_CACHED_CLIENTS} cached)`);

    // Check and rebuild index in background
    ensureIndexExists(walletAddress);

    return client;
  } catch (error) {
    console.error('❌ Failed to initialize read-only PDW Client:', error);
    throw error;
  }
}

/**
 * Ensure HNSW index exists for the user
 * Uses a lock to prevent multiple concurrent rebuilds
 */
async function ensureIndexExists(userAddress: string): Promise<void> {
  const rebuildLocks = getRebuildInProgress();

  // Check if rebuild is already in progress for this user
  if (rebuildLocks.has(userAddress)) {
    console.log('⏳ Index rebuild already in progress, waiting...');
    await rebuildLocks.get(userAddress);
    return;
  }

  try {
    const { hasExistingIndexNode, rebuildIndexNode } = await import('@cmdoss/memwal-sdk');
    const hasIndex = await hasExistingIndexNode(userAddress);

    if (hasIndex) {
      console.log('✅ Local HNSW index exists for user');
      return;
    }

    console.log('⚠️ No local HNSW index found, rebuilding from blockchain...');

    const network = (process.env.SUI_NETWORK as 'testnet' | 'mainnet') || 'testnet';
    const client = new SuiClient({ url: getFullnodeUrl(network) });

    // Create rebuild promise and store in lock map
    const rebuildPromise = rebuildIndexNode({
      userAddress,
      client,
      packageId: process.env.PACKAGE_ID!,
      walrusAggregator: process.env.WALRUS_AGGREGATOR || 'https://aggregator.walrus-testnet.walrus.space',
      onProgress: (current, total, status) => {
        console.log(`[Index Rebuild] ${current}/${total}: ${status}`);
      }
    }).then((result) => {
      if (result.success) {
        console.log(`✅ Index rebuild complete: ${result.indexedMemories}/${result.totalMemories} memories indexed`);
      }
    }).catch((error) => {
      console.error('❌ Index rebuild failed:', error);
    }).finally(() => {
      // Remove lock when done
      getRebuildInProgress().delete(userAddress);
    });

    // Store the promise so other requests can wait for it
    rebuildLocks.set(userAddress, rebuildPromise);

  } catch (error) {
    console.error('❌ Error checking/rebuilding index:', error);
    getRebuildInProgress().delete(userAddress);
  }
}

/**
 * Clear cached client for a wallet address
 */
export function clearReadOnlyClient(walletAddress: string) {
  disposeClient(walletAddress);
}

/**
 * Clear all cached clients
 */
export function clearAllReadOnlyClients() {
  const clients = getReadOnlyClients();
  console.log(`🧹 [Cache] Clearing all ${clients.size} cached clients`);
  for (const key of clients.keys()) {
    disposeClient(key);
  }
}

/**
 * Get cache statistics (for debugging)
 */
export function getCacheStats() {
  const clients = getReadOnlyClients();
  return {
    size: clients.size,
    maxSize: MAX_CACHED_CLIENTS,
    ttlMs: CLIENT_TTL_MS,
    clients: Array.from(clients.entries()).map(([key, cached]) => ({
      address: key.substring(0, 10) + '...',
      age: Date.now() - cached.createdAt,
      lastAccessed: Date.now() - cached.lastAccessed,
    })),
  };
}
