/**
 * Rebuild HNSW Index from Blockchain + Walrus (Node.js)
 *
 * This utility fetches all existing memories from the Sui blockchain,
 * downloads embeddings from Walrus using the Walrus SDK, and rebuilds the local HNSW index.
 *
 * Use this when:
 * 1. User logs in on a new device
 * 2. Local index file was deleted/corrupted
 * 3. Need to sync with latest on-chain state
 *
 * @example
 * ```typescript
 * import { rebuildIndexNode } from 'personal-data-wallet-sdk';
 * import { getFullnodeUrl, SuiClient } from '@mysten/sui/client';
 *
 * const client = new SuiClient({ url: getFullnodeUrl('testnet') });
 *
 * await rebuildIndexNode({
 *   userAddress: '0x...',
 *   client,
 *   packageId: process.env.PACKAGE_ID!,
 *   network: 'testnet',
 *   onProgress: (current, total, status) => console.log(`${current}/${total}: ${status}`)
 * });
 * ```
 */

import type { SuiClient } from '@mysten/sui/client';
import { WalrusClient } from '@mysten/walrus';

export interface RebuildIndexNodeOptions {
  /** User's blockchain address */
  userAddress: string;

  /** Sui client instance */
  client: SuiClient;

  /** Package ID for the PDW smart contract */
  packageId: string;

  /** Walrus network (testnet or mainnet) */
  network?: 'testnet' | 'mainnet';

  /** @deprecated Use network instead. Walrus aggregator URL (fallback) */
  walrusAggregator?: string;

  /** Index directory (default: .pdw-indexes) */
  indexDirectory?: string;

  /** Progress callback */
  onProgress?: (current: number, total: number, status: string) => void;

  /** Whether to force re-index even if index exists */
  force?: boolean;
}

export interface RebuildIndexNodeResult {
  success: boolean;
  totalMemories: number;
  indexedMemories: number;
  failedMemories: number;
  errors: Array<{ blobId: string; error: string }>;
  duration: number;
}

interface MemoryContent {
  content: string;
  embedding: number[];
  metadata: {
    category: string;
    importance: number;
    topic: string;
  };
  timestamp: number;
}

/**
 * Rebuild HNSW index from blockchain + Walrus (Node.js)
 */
export async function rebuildIndexNode(options: RebuildIndexNodeOptions): Promise<RebuildIndexNodeResult> {
  const {
    userAddress,
    client,
    packageId,
    network = (process.env.WALRUS_NETWORK as 'testnet' | 'mainnet') || 'testnet',
    walrusAggregator,
    indexDirectory = './.pdw-indexes',
    onProgress,
    force = false
  } = options;

  const startTime = Date.now();
  const errors: Array<{ blobId: string; error: string }> = [];

  console.log('[rebuildIndexNode] Starting index rebuild...');
  onProgress?.(0, 0, 'Initializing...');

  try {
    // Dynamic imports for Node.js modules
    const { NodeHnswService } = await import('../vector/NodeHnswService');
    const fs = await import('fs/promises');

    // Initialize Walrus client
    const walrusClient = client.$extend(
      WalrusClient.experimental_asClientExtension({
        network,
        storageNodeClientOptions: {
          timeout: 60_000,
        },
      })
    );

    // Initialize HNSW service
    const hnswService = new NodeHnswService({
      indexDirectory,
      indexConfig: {
        dimension: 3072,
        maxElements: 10000,
        m: 16,
        efConstruction: 200
      }
    });

    await hnswService.initialize();

    // Check if index exists
    const indexPath = `${indexDirectory}/${userAddress.replace(/[^a-zA-Z0-9]/g, '_')}.hnsw`;
    let indexExists = false;
    try {
      await fs.access(indexPath);
      indexExists = true;
    } catch {
      // Index doesn't exist
    }

    if (indexExists && !force) {
      console.log('[rebuildIndexNode] Index already exists. Use force=true to rebuild.');
      return {
        success: false,
        totalMemories: 0,
        indexedMemories: 0,
        failedMemories: 0,
        errors: [{ blobId: '', error: 'Index already exists. Use force=true to rebuild.' }],
        duration: Date.now() - startTime
      };
    }

    if (indexExists && force) {
      await hnswService.deleteIndex(userAddress);
      console.log('[rebuildIndexNode] Deleted existing index for rebuild');
    }

    // Fetch all memories from blockchain
    console.log('[rebuildIndexNode] Fetching memories from blockchain...');
    onProgress?.(0, 0, 'Fetching memories from blockchain...');

    const memories: Array<{
      id: string;
      blobId: string;
      vectorId: number;
      category: string;
      importance: number;
    }> = [];

    let cursor: string | null | undefined = undefined;
    let hasMore = true;

    while (hasMore) {
      const response = await client.getOwnedObjects({
        owner: userAddress,
        filter: {
          StructType: `${packageId}::memory::Memory`,
        },
        options: {
          showContent: true,
          showType: true,
        },
        cursor,
        limit: 50
      });

      for (const obj of response.data) {
        if (obj.data?.content && 'fields' in obj.data.content) {
          const fields = obj.data.content.fields as any;
          memories.push({
            id: obj.data.objectId,
            blobId: fields.blob_id || '',
            vectorId: parseInt(fields.vector_id || '0'),
            category: fields.category || 'general',
            importance: parseInt(fields.importance || '5')
          });
        }
      }

      cursor = response.nextCursor;
      hasMore = response.hasNextPage;
    }

    const totalMemories = memories.length;
    console.log(`[rebuildIndexNode] Found ${totalMemories} memories on-chain`);

    if (totalMemories === 0) {
      console.log('[rebuildIndexNode] No memories to index');
      return {
        success: true,
        totalMemories: 0,
        indexedMemories: 0,
        failedMemories: 0,
        errors: [],
        duration: Date.now() - startTime
      };
    }

    // Process each memory
    let indexedCount = 0;
    let failedCount = 0;

    for (let i = 0; i < memories.length; i++) {
      const memory = memories[i];
      const progress = `Memory ${i + 1}/${totalMemories}`;

      console.log(`[rebuildIndexNode] Processing ${progress}: ${memory.blobId.substring(0, 20)}...`);
      onProgress?.(i + 1, totalMemories, `Processing ${progress}...`);

      try {
        // Download content from Walrus using SDK
        const blobContent = await walrusClient.walrus.readBlob({ blobId: memory.blobId });

        // Parse JSON content
        const textDecoder = new TextDecoder();
        const jsonString = textDecoder.decode(blobContent);
        const memoryData: MemoryContent = JSON.parse(jsonString);

        // Extract embedding
        const embedding = memoryData.embedding;
        if (!embedding || embedding.length !== 3072) {
          throw new Error(`Invalid embedding: length=${embedding?.length || 0}`);
        }

        // Add to HNSW index
        await hnswService.addVector(
          userAddress,
          memory.vectorId,
          embedding,
          {
            blobId: memory.blobId,
            memoryObjectId: memory.id,
            category: memory.category,
            importance: memory.importance,
            topic: memoryData.metadata?.topic || '',
            timestamp: memoryData.timestamp
          }
        );

        indexedCount++;
        console.log(`[rebuildIndexNode]   ✓ Indexed: ${memory.blobId.substring(0, 20)}...`);

      } catch (error: any) {
        failedCount++;
        const errorMsg = error.message || String(error);
        errors.push({ blobId: memory.blobId, error: errorMsg });
        console.error(`[rebuildIndexNode]   ✗ Failed: ${errorMsg}`);
      }
    }

    // Force save index
    console.log('[rebuildIndexNode] Saving index to disk...');
    onProgress?.(totalMemories, totalMemories, 'Saving index...');
    await hnswService.flushBatch(userAddress);

    const duration = Date.now() - startTime;
    console.log('[rebuildIndexNode] Index rebuild complete!');
    console.log(`[rebuildIndexNode] Total: ${totalMemories}, Indexed: ${indexedCount}, Failed: ${failedCount}`);
    console.log(`[rebuildIndexNode] Duration: ${(duration / 1000).toFixed(2)}s`);

    return {
      success: true,
      totalMemories,
      indexedMemories: indexedCount,
      failedMemories: failedCount,
      errors,
      duration
    };

  } catch (error: any) {
    console.error('[rebuildIndexNode] Index rebuild failed:', error);
    return {
      success: false,
      totalMemories: 0,
      indexedMemories: 0,
      failedMemories: 0,
      errors: [{ blobId: '', error: error.message || String(error) }],
      duration: Date.now() - startTime
    };
  }
}

/**
 * Check if index exists for a user (Node.js)
 */
export async function hasExistingIndexNode(
  userAddress: string,
  indexDirectory = './.pdw-indexes'
): Promise<boolean> {
  try {
    const fs = await import('fs/promises');
    const indexPath = `${indexDirectory}/${userAddress.replace(/[^a-zA-Z0-9]/g, '_')}.hnsw`;
    await fs.access(indexPath);
    return true;
  } catch {
    return false;
  }
}

/**
 * Clear index for a user (Node.js)
 */
export async function clearIndexNode(
  userAddress: string,
  indexDirectory = './.pdw-indexes'
): Promise<void> {
  try {
    const fs = await import('fs/promises');
    const safeAddress = userAddress.replace(/[^a-zA-Z0-9]/g, '_');
    const indexPath = `${indexDirectory}/${safeAddress}.hnsw`;
    const metaPath = `${indexDirectory}/${safeAddress}.hnsw.meta.json`;

    await fs.unlink(indexPath).catch(() => {});
    await fs.unlink(metaPath).catch(() => {});

    console.log(`[clearIndexNode] Cleared index for user ${userAddress}`);
  } catch (error) {
    console.warn('[clearIndexNode] Error clearing index:', error);
  }
}
