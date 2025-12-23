import { getFullnodeUrl, SuiClient } from '@mysten/sui/client';

let readOnlyClients: Map<string, any> = new Map();
let SimplePDWClient: any = null;

// Lock to prevent multiple concurrent rebuilds for the same user
const rebuildInProgress: Map<string, Promise<void>> = new Map();

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
  if (SimplePDWClient) return SimplePDWClient;

  try {
    const pdwModule = await import('@cmdoss/memwal-sdk');
    SimplePDWClient = pdwModule.SimplePDWClient;
    if (!SimplePDWClient) {
      throw new Error('SimplePDWClient not found in SDK export');
    }
    return SimplePDWClient;
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

  // Return cached client if exists
  if (readOnlyClients.has(walletAddress)) {
    return readOnlyClients.get(walletAddress);
  }

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
        chatModel: process.env.AI_CHAT_MODEL || 'google/gemini-2.5-flash',
      },
      walrus: {
        aggregatorUrl: process.env.WALRUS_AGGREGATOR || 'https://aggregator.walrus-testnet.walrus.space',
        publisherUrl: process.env.WALRUS_PUBLISHER || 'https://publisher.walrus-testnet.walrus.space',
      },
      features: {
        enableEncryption: false,
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
    console.log(`✅ Read-only PDW Client initialized for: ${walletAddress}`);

    // Cache the client
    readOnlyClients.set(walletAddress, client);

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
  // Check if rebuild is already in progress for this user
  if (rebuildInProgress.has(userAddress)) {
    console.log('⏳ Index rebuild already in progress, waiting...');
    await rebuildInProgress.get(userAddress);
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
      rebuildInProgress.delete(userAddress);
    });

    // Store the promise so other requests can wait for it
    rebuildInProgress.set(userAddress, rebuildPromise);

  } catch (error) {
    console.error('❌ Error checking/rebuilding index:', error);
    rebuildInProgress.delete(userAddress);
  }
}

/**
 * Clear cached client for a wallet address
 */
export function clearReadOnlyClient(walletAddress: string) {
  readOnlyClients.delete(walletAddress);
}

/**
 * Clear all cached clients
 */
export function clearAllReadOnlyClients() {
  readOnlyClients.clear();
}
