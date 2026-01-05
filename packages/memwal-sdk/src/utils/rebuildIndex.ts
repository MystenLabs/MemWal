/**
 * Rebuild HNSW Index from Existing On-Chain Memories
 *
 * This utility fetches all existing memories from the blockchain and re-indexes them
 * locally in IndexedDB for vector search. Use this when:
 *
 * 1. You have old memories created before local indexing was implemented
 * 2. Your IndexedDB was cleared
 * 3. You want to sync a new device with existing on-chain memories
 *
 * @example
 * ```typescript
 * import { rebuildIndex } from 'personal-data-wallet-sdk/utils/rebuildIndex';
 * import { useCurrentAccount, useSuiClient, useSignPersonalMessage } from '@mysten/dapp-kit';
 *
 * const account = useCurrentAccount();
 * const client = useSuiClient();
 * const { mutateAsync: signPersonalMessage } = useSignPersonalMessage();
 *
 * await rebuildIndex({
 *   userAddress: account.address,
 *   client,
 *   signPersonalMessage,
 *   packageId: process.env.NEXT_PUBLIC_PACKAGE_ID,
 *   geminiApiKey: process.env.NEXT_PUBLIC_GEMINI_API_KEY,
 *   walrusAggregator: process.env.NEXT_PUBLIC_WALRUS_AGGREGATOR,
 *   onProgress: (current, total) => console.log(`${current}/${total}`)
 * });
 * ```
 */

import type { SuiClient } from '@mysten/sui/client';
import { BrowserHnswIndexService } from '../vector/BrowserHnswIndexService';
import { EmbeddingService } from '../services/EmbeddingService';
import { ClientMemoryManager, type ClientMemoryMetadata } from '../client/ClientMemoryManager';
import { ViewService } from '../services/ViewService';

export interface RebuildIndexOptions {
  /** User's blockchain address */
  userAddress: string;

  /** Sui client instance */
  client: SuiClient;

  /** Function to sign messages for SEAL decryption */
  signPersonalMessage: (params: { message: Uint8Array }) => Promise<{ signature: string }>;

  /** Package ID for the PDW smart contract */
  packageId: string;

  /** Gemini API key for generating embeddings */
  geminiApiKey: string;

  /** Walrus aggregator URL */
  walrusAggregator: string;

  /** Access registry ID (for SEAL) */
  accessRegistryId?: string;

  /** Progress callback (current, total) */
  onProgress?: (current: number, total: number, status: string) => void;

  /** Whether to force re-index even if index exists */
  force?: boolean;
}

export interface RebuildIndexResult {
  success: boolean;
  totalMemories: number;
  indexedMemories: number;
  failedMemories: number;
  errors: Array<{ blobId: string; error: string }>;
  duration: number;
}

/**
 * Rebuild HNSW index from existing on-chain memories
 */
export async function rebuildIndex(options: RebuildIndexOptions): Promise<RebuildIndexResult> {
  const {
    userAddress,
    client,
    signPersonalMessage,
    packageId,
    geminiApiKey,
    walrusAggregator,
    accessRegistryId,
    onProgress,
    force = false
  } = options;

  const startTime = Date.now();
  const errors: Array<{ blobId: string; error: string }> = [];

  console.log('🔄 Starting index rebuild...');
  onProgress?.(0, 0, 'Initializing services...');

  try {
    // Step 1: Initialize services
    const embeddingService = new EmbeddingService({
      apiKey: geminiApiKey,
      model: 'text-embedding-004',
      dimensions: 768
    });

    const hnswService = new BrowserHnswIndexService(
      {
        dimension: 768,
        maxElements: 10000,
        m: 16,
        efConstruction: 200
      },
      {
        maxBatchSize: 50,
        batchDelayMs: 1000 // Shorter delay for rebuild
      }
    );

    const viewService = new ViewService(client as any, { packageId });

    const memoryManager = new ClientMemoryManager({
      packageId,
      accessRegistryId: accessRegistryId || '',
      walrusAggregator,
      geminiApiKey,
      enableLocalIndexing: false // We'll handle indexing manually
    });

    // Step 2: Check if index already exists
    if (!force) {
      try {
        const hasExisting = await hnswService.loadIndexFromDB(userAddress);
        if (hasExisting) {
          console.log('ℹ️ Index already exists. Use force=true to rebuild.');
          return {
            success: false,
            totalMemories: 0,
            indexedMemories: 0,
            failedMemories: 0,
            errors: [{ blobId: '', error: 'Index already exists. Use force=true to rebuild.' }],
            duration: Date.now() - startTime
          };
        }
      } catch (err) {
        // No index exists, continue with rebuild
        console.log('✅ No existing index, proceeding with rebuild...');
      }
    } else {
      // Clear existing index if force rebuild
      hnswService.clearUserIndex(userAddress);
      console.log('🗑️ Cleared existing index for rebuild');
    }

    // Step 3: Fetch all on-chain memories
    console.log('📡 Fetching memories from blockchain...');
    onProgress?.(0, 0, 'Fetching memories from blockchain...');

    const result = await viewService.getUserMemories(userAddress, {
      limit: 1000 // Fetch up to 1000 memories
    });

    const totalMemories = result.data.length;
    console.log(`📊 Found ${totalMemories} memories on-chain`);

    if (totalMemories === 0) {
      console.log('ℹ️ No memories to index');
      return {
        success: true,
        totalMemories: 0,
        indexedMemories: 0,
        failedMemories: 0,
        errors: [],
        duration: Date.now() - startTime
      };
    }

    // Step 4: Process each memory
    let indexedCount = 0;
    let failedCount = 0;

    for (let i = 0; i < result.data.length; i++) {
      const memory = result.data[i];
      const progress = `Memory ${i + 1}/${totalMemories}`;

      console.log(`🔄 Processing ${progress}: ${memory.blobId}`);
      onProgress?.(i + 1, totalMemories, `Processing ${progress}...`);

      try {
        // Retrieve and decrypt memory content
        const memoryData = await memoryManager.retrieveMemory({
          blobId: memory.blobId,
          account: { address: userAddress },
          signPersonalMessage,
          client
        });

        // Generate/extract embedding
        let embedding = memoryData.embedding;
        if (!embedding || embedding.length !== 3072) {
          console.log(`  ⚠️ No valid embedding found, generating new one...`);
          const embeddingResult = await embeddingService.embedText({
            text: memoryData.content
          });
          embedding = embeddingResult.vector;
        }

        // Add to HNSW index
        // Option A+: Store content in index for fast local retrieval (no Walrus fetch needed)
        const vectorId = parseInt(memory.id.slice(-8), 16); // Use memory ID as vector ID
        hnswService.addVectorToIndexBatched(
          userAddress,
          vectorId,
          embedding,
          {
            blobId: memory.blobId,
            category: memory.category,
            importance: memory.importance,
            contentType: 'text/plain',
            contentSize: memory.contentSize,
            createdTimestamp: memory.createdAt,
            // Option A+: Store content for fast retrieval (avoids Walrus fetch on search)
            content: memoryData.content,
            isEncrypted: false // If we decrypted it successfully, store it
          }
        );

        indexedCount++;
        console.log(`  ✅ Indexed: ${memory.blobId.substring(0, 20)}...`);

      } catch (error: any) {
        failedCount++;
        const errorMsg = error.message || String(error);
        errors.push({ blobId: memory.blobId, error: errorMsg });
        console.error(`  ❌ Failed to index ${memory.blobId}:`, errorMsg);
      }
    }

    // Step 5: Force flush all pending vectors
    console.log('💾 Flushing index to IndexedDB...');
    onProgress?.(totalMemories, totalMemories, 'Saving index...');

    await hnswService.forceFlush(userAddress);

    const duration = Date.now() - startTime;
    console.log('✅ Index rebuild complete!');
    console.log(`   Total: ${totalMemories}, Indexed: ${indexedCount}, Failed: ${failedCount}`);
    console.log(`   Duration: ${(duration / 1000).toFixed(2)}s`);

    return {
      success: true,
      totalMemories,
      indexedMemories: indexedCount,
      failedMemories: failedCount,
      errors,
      duration
    };

  } catch (error: any) {
    console.error('❌ Index rebuild failed:', error);
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
 * Check if user has an existing index
 */
export async function hasExistingIndex(userAddress: string): Promise<boolean> {
  const hnswService = new BrowserHnswIndexService();
  try {
    return await hnswService.loadIndexFromDB(userAddress);
  } catch {
    return false;
  }
}

/**
 * Clear existing index for a user
 */
export function clearIndex(userAddress: string): void {
  const hnswService = new BrowserHnswIndexService();
  hnswService.clearUserIndex(userAddress);
  console.log(`🗑️ Cleared index for user ${userAddress}`);
}
