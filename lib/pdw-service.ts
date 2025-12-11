import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { decodeSuiPrivateKey } from '@mysten/sui/cryptography';
import { getFullnodeUrl, SuiClient } from '@mysten/sui/client';
import { loadPDWClient } from './pdw-wrapper';

let pdwInstance: any | null = null;
let SimplePDWClient: any = null;
let indexRebuildInProgress = false;
let indexRebuildPromise: Promise<void> | null = null;

/**
 * Get or create the PDW client instance (singleton pattern)
 * This ensures only one instance is created per server session
 */
export async function getPDWClient(): Promise<any> {
  // Skip PDW initialization during build time
  if (process.env.NEXT_PHASE === 'phase-production-build') {
    throw new Error('PDW Client not available during build time');
  }

  if (pdwInstance) {
    return pdwInstance;
  }

  // Lazy load the PDW SDK only at runtime
  if (!SimplePDWClient) {
    try {
      SimplePDWClient = await loadPDWClient();
      if (!SimplePDWClient) {
        throw new Error('SimplePDWClient is undefined after loading');
      }
    } catch (error) {
      console.error('❌ Failed to import PDW SDK:', error);
      console.error('❌ SDK Packaging Issue - Please contact the SDK author');
      console.error('❌ Error details:', error);
      throw new Error('Failed to load personal-data-wallet-sdk - packaging issue');
    }
  }

  // Validate required environment variables
  const requiredEnvVars = {
    SUI_PRIVATE_KEY: process.env.SUI_PRIVATE_KEY,
    PACKAGE_ID: process.env.PACKAGE_ID,
    GEMINI_API_KEY: process.env.GEMINI_API_KEY,
    SUI_NETWORK: process.env.SUI_NETWORK,
    WALLET_ADDRESS: process.env.WALLET_ADDRESS,
  };

  const missingVars = Object.entries(requiredEnvVars)
    .filter(([_, value]) => !value)
    .map(([key]) => key);

  if (missingVars.length > 0) {
    throw new Error(
      `Missing required environment variables: ${missingVars.join(', ')}`
    );
  }

  try {
    // Decode the Sui private key
    const { secretKey } = decodeSuiPrivateKey(process.env.SUI_PRIVATE_KEY!);
    const keypair = Ed25519Keypair.fromSecretKey(secretKey);

    // Initialize the PDW client
    pdwInstance = new SimplePDWClient({
      signer: keypair,
      network: (process.env.SUI_NETWORK as 'testnet' | 'mainnet') || 'testnet',
      packageId: process.env.PACKAGE_ID!,
      geminiApiKey: process.env.GEMINI_API_KEY!,
      walrus: {
        aggregatorUrl: process.env.WALRUS_AGGREGATOR || 'https://aggregator.walrus-testnet.walrus.space',
        publisherUrl: process.env.WALRUS_PUBLISHER || 'https://publisher.walrus-testnet.walrus.space',
      },
      features: {
        enableEncryption: false, // Disable for now (can enable with SEAL later)
        enableLocalIndexing: true, // Enable hybrid HNSW (uses hnswlib-node for Node.js)
        enableKnowledgeGraph: true, // Enable knowledge graph extraction
      },
    });

    // Wait for the client to be ready
    await pdwInstance.ready();

    console.log('✅ PDW Client initialized successfully');
    console.log('📍 Wallet Address:', process.env.WALLET_ADDRESS);
    console.log('🌐 Network:', process.env.SUI_NETWORK);

    // Check and rebuild index if needed (run in background)
    ensureIndexExists(process.env.WALLET_ADDRESS!);

    return pdwInstance;
  } catch (error) {
    console.error('❌ Failed to initialize PDW Client:', error);
    throw new Error(`PDW initialization failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
  }
}

/**
 * Helper to check if content should be saved as a memory
 */
export async function shouldSaveAsMemory(content: string): Promise<boolean> {
  try {
    const pdw = await getPDWClient();
    return await pdw.ai.shouldSave(content);
  } catch (error) {
    console.error('Error checking if should save:', error);
    return false; // Default to not saving on error
  }
}

/**
 * Helper to classify content
 */
export async function classifyContent(content: string) {
  try {
    const pdw = await getPDWClient();
    return await pdw.ai.classifyFull(content);
  } catch (error) {
    console.error('Error classifying content:', error);
    return null;
  }
}

/**
 * Reset the PDW instance (useful for testing)
 */
export function resetPDWClient() {
  pdwInstance = null;
}

/**
 * Ensure HNSW index exists for the user
 * If not, rebuild it from blockchain + Walrus
 * Runs in background to not block initialization
 */
async function ensureIndexExists(userAddress: string): Promise<void> {
  // Prevent multiple concurrent rebuilds
  if (indexRebuildInProgress) {
    if (indexRebuildPromise) {
      await indexRebuildPromise;
    }
    return;
  }

  try {
    // Dynamic import to avoid bundling issues
    const { hasExistingIndexNode, rebuildIndexNode } = await import('personal-data-wallet-sdk');

    const hasIndex = await hasExistingIndexNode(userAddress);

    if (hasIndex) {
      console.log('✅ Local HNSW index exists for user');
      return;
    }

    console.log('⚠️ No local HNSW index found, rebuilding from blockchain...');
    indexRebuildInProgress = true;

    const network = (process.env.SUI_NETWORK as 'testnet' | 'mainnet') || 'testnet';
    const client = new SuiClient({ url: getFullnodeUrl(network) });

    indexRebuildPromise = rebuildIndexNode({
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
      } else {
        console.warn('⚠️ Index rebuild had issues:', result.errors);
      }
    }).catch((error) => {
      console.error('❌ Index rebuild failed:', error);
    }).finally(() => {
      indexRebuildInProgress = false;
      indexRebuildPromise = null;
    });

    // Don't await - let it run in background
  } catch (error) {
    console.error('❌ Error checking/rebuilding index:', error);
    indexRebuildInProgress = false;
    indexRebuildPromise = null;
  }
}

/**
 * Force rebuild index from blockchain (for manual trigger)
 */
export async function forceRebuildIndex(): Promise<{
  success: boolean;
  totalMemories: number;
  indexedMemories: number;
  failedMemories: number;
  duration: number;
}> {
  const userAddress = process.env.WALLET_ADDRESS;
  if (!userAddress) {
    throw new Error('WALLET_ADDRESS not configured');
  }

  const { rebuildIndexNode, clearIndexNode } = await import('personal-data-wallet-sdk');

  // Clear existing index first
  await clearIndexNode(userAddress);

  const network = (process.env.SUI_NETWORK as 'testnet' | 'mainnet') || 'testnet';
  const client = new SuiClient({ url: getFullnodeUrl(network) });

  console.log('🔄 Force rebuilding index from blockchain...');

  const result = await rebuildIndexNode({
    userAddress,
    client,
    packageId: process.env.PACKAGE_ID!,
    walrusAggregator: process.env.WALRUS_AGGREGATOR || 'https://aggregator.walrus-testnet.walrus.space',
    force: true,
    onProgress: (current, total, status) => {
      console.log(`[Index Rebuild] ${current}/${total}: ${status}`);
    }
  });

  return {
    success: result.success,
    totalMemories: result.totalMemories,
    indexedMemories: result.indexedMemories,
    failedMemories: result.failedMemories,
    duration: result.duration
  };
}
