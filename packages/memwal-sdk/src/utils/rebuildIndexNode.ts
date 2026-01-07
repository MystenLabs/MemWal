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
import { WalrusClient, WalrusFile } from '@mysten/walrus';

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

  /**
   * Quilt IDs to include in the rebuild.
   * Quilts contain batch-uploaded memories that may not have on-chain Memory objects.
   * Pass Quilt IDs here to include them in the index rebuild.
   */
  quiltIds?: string[];

  /**
   * Number of concurrent blob fetches (default: 10)
   * Higher values can speed up rebuilding but may overwhelm the server
   * Benchmark results: 10 is ~1.64x faster than sequential
   */
  fetchConcurrency?: number;
}

export interface RebuildIndexNodeResult {
  success: boolean;
  totalMemories: number;
  indexedMemories: number;
  failedMemories: number;
  errors: Array<{ blobId: string; error: string }>;
  duration: number;
  /** Detailed timing breakdown for performance analysis */
  timing?: {
    /** Time to initialize services (ms) */
    initMs: number;
    /** Time to fetch blockchain data (ms) */
    blockchainFetchMs: number;
    /** Time to fetch all blobs from Walrus (ms) */
    walrusFetchMs: number;
    /** Time to process memories and build index (ms) */
    processingMs: number;
    /** Time to save index to disk (ms) */
    saveMs: number;
    /** Total blobs fetched */
    blobsFetched: number;
    /** Total content bytes downloaded */
    totalBytesDownloaded: number;
  };
}

interface MemoryContent {
  content: string;
  embedding: number[];
  metadata: {
    category: string;
    importance: number;
    topic: string;
    memoryId?: string;
  };
  timestamp: number;
}

/**
 * Find a matching file in a Quilt using multiple strategies
 * Mirrors the logic in SDK's QuiltBatchManager.findMemoryInQuilt()
 *
 * Strategies (in order):
 * 1. Match by tags['memory_id'] === vectorId
 * 2. Match by identifier === `memory-${vectorId}.json`
 * 3. Match by JSON metadata.memoryId === vectorId
 * 4. Fallback to index-based matching
 */
async function findMatchingFile(
  files: WalrusFile[],
  vectorId: number,
  fallbackIndex: number
): Promise<{ file: WalrusFile | undefined; matchStrategy: string }> {
  let matchedFile: WalrusFile | undefined;
  let matchStrategy = '';

  // Strategy 1: Match by tags['memory_id']
  for (const f of files) {
    const tags = await f.getTags();
    if (tags?.['memory_id'] === String(vectorId)) {
      matchedFile = f;
      const identifier = await f.getIdentifier();
      matchStrategy = `memory_id tag: ${tags['memory_id']} (${identifier})`;
      break;
    }
  }

  // Strategy 2: Match by identifier pattern "memory-{vectorId}.json"
  if (!matchedFile) {
    for (const f of files) {
      const identifier = await f.getIdentifier();
      if (identifier === `memory-${vectorId}.json`) {
        matchedFile = f;
        matchStrategy = `identifier: ${identifier}`;
        break;
      }
    }
  }

  // Strategy 3: Parse JSON to find matching metadata.memoryId
  if (!matchedFile) {
    for (const f of files) {
      try {
        const json = await f.json() as MemoryContent;
        if (json?.metadata?.memoryId === String(vectorId)) {
          matchedFile = f;
          const identifier = await f.getIdentifier();
          matchStrategy = `JSON metadata.memoryId: ${json.metadata.memoryId} (${identifier})`;
          break;
        }
      } catch {
        // Not valid JSON, continue
      }
    }
  }

  // Strategy 4: Fallback to index-based matching
  if (!matchedFile && fallbackIndex < files.length) {
    matchedFile = files[fallbackIndex];
    const identifier = await matchedFile.getIdentifier();
    matchStrategy = `index fallback (${fallbackIndex}): ${identifier || 'no identifier'}`;
  }

  return { file: matchedFile, matchStrategy };
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
    force = false,
    quiltIds = [],
    fetchConcurrency = 10
  } = options;

  const startTime = Date.now();
  const errors: Array<{ blobId: string; error: string }> = [];

  // Detailed timing
  const timing = {
    initMs: 0,
    blockchainFetchMs: 0,
    walrusFetchMs: 0,
    processingMs: 0,
    saveMs: 0,
    blobsFetched: 0,
    totalBytesDownloaded: 0,
  };

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
    timing.initMs = Date.now() - startTime;
    console.log(`[rebuildIndexNode] ⏱️ Init: ${timing.initMs}ms`);

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
    const blockchainFetchStart = Date.now();
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

    // Process memories grouped by blobId (for Quilt support)
    // In a Quilt, multiple memories share the same blobId
    const memoriesByBlobId = new Map<string, typeof memories>();
    for (const memory of memories) {
      const list = memoriesByBlobId.get(memory.blobId) || [];
      list.push(memory);
      memoriesByBlobId.set(memory.blobId, list);
    }

    console.log(`[rebuildIndexNode] Unique blobIds: ${memoriesByBlobId.size} (${memoriesByBlobId.size < totalMemories ? 'Quilt detected' : 'individual blobs'})`);
    timing.blockchainFetchMs = Date.now() - blockchainFetchStart;
    console.log(`[rebuildIndexNode] ⏱️ Blockchain fetch: ${timing.blockchainFetchMs}ms`);

    let indexedCount = 0;
    let failedCount = 0;
    let processedCount = 0;

    // ==================== PARALLEL BLOB FETCHING + CONTENT ====================
    // Step 1: Check blob types (Quilt vs regular) in parallel
    // Step 2: Fetch content in parallel (patches for Quilt, bytes for regular)
    const blobIds = Array.from(memoriesByBlobId.keys());

    console.log(`[rebuildIndexNode] Fetching ${blobIds.length} blobs (concurrency: ${fetchConcurrency})...`);
    const fetchStartTime = Date.now();

    const quiltFileCache = new Map<string, WalrusFile[]>();
    const contentCache = new Map<string, Uint8Array>(); // blobId or blobId:identifier -> content
    const fetchErrors: Array<{ blobId: string; error: string }> = [];

    // Process in batches to control concurrency
    for (let i = 0; i < blobIds.length; i += fetchConcurrency) {
      const batch = blobIds.slice(i, i + fetchConcurrency);
      const batchNum = Math.floor(i / fetchConcurrency) + 1;
      const totalBatches = Math.ceil(blobIds.length / fetchConcurrency);

      console.log(`[rebuildIndexNode]   📥 Batch ${batchNum}/${totalBatches}: ${batch.length} blobs...`);
      onProgress?.(i, blobIds.length, `Fetching batch ${batchNum}/${totalBatches}...`);

      // Parallel fetch: check type + fetch content for each blob
      const results = await Promise.all(
        batch.map(async (blobId) => {
          try {
            // Try as Quilt first (getBlob + files)
            try {
              const blob = await walrusClient.walrus.getBlob({ blobId });
              const quiltFiles = await blob.files();

              if (quiltFiles.length > 1) {
                // It's a Quilt with multiple patches - fetch all content in parallel
                const patchResults = await Promise.all(
                  quiltFiles.map(async (file) => {
                    const identifier = await file.getIdentifier();
                    const tags = await file.getTags();
                    const bytes = await file.bytes();
                    return { file, identifier, tags, bytes };
                  })
                );

                return {
                  blobId,
                  success: true,
                  isQuilt: true,
                  files: quiltFiles,
                  patches: patchResults,
                };
              } else {
                // Single file in blob - fetch content
                const bytes = await quiltFiles[0].bytes();
                return {
                  blobId,
                  success: true,
                  isQuilt: false,
                  files: quiltFiles,
                  bytes,
                };
              }
            } catch {
              // Not a Quilt - try as regular blob
              const files = await walrusClient.walrus.getFiles({ ids: [blobId] });
              if (files[0]) {
                const bytes = await files[0].bytes();
                return {
                  blobId,
                  success: true,
                  isQuilt: false,
                  files,
                  bytes,
                };
              }
              return { blobId, success: false, error: 'No file found' };
            }
          } catch (error: any) {
            return { blobId, success: false, error: error.message || String(error) };
          }
        })
      );

      // Process results into caches
      for (const result of results) {
        if (!result.success) {
          fetchErrors.push({ blobId: result.blobId, error: result.error || 'Unknown error' });
          console.error(`[rebuildIndexNode]     ✗ ${result.blobId.substring(0, 16)}...: ${result.error}`);
          continue;
        }

        if (result.isQuilt && result.patches) {
          // Quilt: cache files and patch contents
          quiltFileCache.set(result.blobId, result.files!);
          for (const patch of result.patches) {
            const cacheKey = patch.identifier
              ? `${result.blobId}:${patch.identifier}`
              : result.blobId;
            contentCache.set(cacheKey, patch.bytes);
          }
          console.log(`[rebuildIndexNode]     ✓ ${result.blobId.substring(0, 16)}... (Quilt: ${result.patches.length} patches)`);
        } else if (result.bytes) {
          // Regular blob: cache file and content
          quiltFileCache.set(result.blobId, result.files!);
          contentCache.set(result.blobId, result.bytes);
          console.log(`[rebuildIndexNode]     ✓ ${result.blobId.substring(0, 16)}... (${result.bytes.length} bytes)`);
        }
      }
    }

    timing.walrusFetchMs = Date.now() - fetchStartTime;
    timing.blobsFetched = quiltFileCache.size;
    // Calculate total bytes downloaded
    for (const bytes of contentCache.values()) {
      timing.totalBytesDownloaded += bytes.length;
    }
    console.log(`[rebuildIndexNode] ⏱️ Walrus fetch: ${timing.walrusFetchMs}ms (${quiltFileCache.size} blobs, ${contentCache.size} contents, ${(timing.totalBytesDownloaded / 1024).toFixed(1)}KB)`);

    const processingStart = Date.now();

    // ==================== PROCESS MEMORIES ====================
    for (const [blobId, memoriesInBlob] of memoriesByBlobId) {
      console.log(`[rebuildIndexNode] Processing blobId ${blobId.substring(0, 20)}... (${memoriesInBlob.length} memories)`);

      // Get pre-fetched files from cache
      const files = quiltFileCache.get(blobId);

      if (!files) {
        // Blob fetch failed - mark all memories in this blob as failed
        const fetchError = fetchErrors.find(e => e.blobId === blobId);
        const errorMsg = fetchError?.error || 'Failed to fetch blob';
        console.error(`[rebuildIndexNode]   ✗ No files available: ${errorMsg}`);

        for (const memory of memoriesInBlob) {
          processedCount++;
          failedCount++;
          errors.push({ blobId: memory.blobId, error: `Blob fetch failed: ${errorMsg}` });
        }
        continue;
      }

      console.log(`[rebuildIndexNode]   📦 Using ${files.length} pre-fetched file(s)`);

      // For each memory in this blobId
      for (let i = 0; i < memoriesInBlob.length; i++) {
        const memory = memoriesInBlob[i];
        processedCount++;
        const progress = `Memory ${processedCount}/${totalMemories}`;

        console.log(`[rebuildIndexNode] Processing ${progress}: vectorId=${memory.vectorId}`);
        onProgress?.(processedCount, totalMemories, `Processing ${progress}...`);

        try {
          // Find matching file using helper function (mirrors SDK's QuiltBatchManager.findMemoryInQuilt)
          let file: WalrusFile | undefined;

          if (files.length === 1) {
            // Single file - use it directly
            file = files[0];
          } else if (files.length > 1) {
            // Multiple files in Quilt - use matching strategies
            const { file: matchedFile, matchStrategy } = await findMatchingFile(files, memory.vectorId, i);
            file = matchedFile;
            if (matchStrategy) {
              console.log(`[rebuildIndexNode]   🎯 Matched by ${matchStrategy}`);
            }
          }

          if (!file) {
            throw new Error(`No file found for memory vectorId=${memory.vectorId} (blob has ${files.length} files)`);
          }

          // Get file identifier and tags if available (for Quilts)
          const identifier = await file.getIdentifier();
          const tags = await file.getTags();

          // Get content from cache (already pre-fetched) or fetch if not cached
          const cacheKey = identifier ? `${blobId}:${identifier}` : blobId;
          let rawBytes = contentCache.get(cacheKey);
          if (!rawBytes) {
            // Fallback: fetch content if not in cache
            rawBytes = await file.bytes();
          }
          const rawText = new TextDecoder().decode(rawBytes);
          const trimmedText = rawText.trim();

          if (identifier) {
            console.log(`[rebuildIndexNode]   📎 File identifier: ${identifier}`);
          }

          let content: string;
          let embedding: number[];
          let metadata: { category?: string; importance?: number; topic?: string } = {};
          let timestamp = Date.now();

          if (trimmedText.startsWith('{') && trimmedText.endsWith('}')) {
            // JSON package format (correct format)
            try {
              const memoryData: MemoryContent = JSON.parse(trimmedText);
              content = memoryData.content;
              embedding = memoryData.embedding;
              metadata = memoryData.metadata || {};
              timestamp = memoryData.timestamp || Date.now();

              if (!embedding || embedding.length !== 3072) {
                throw new Error(`Invalid embedding in JSON: length=${embedding?.length || 0}`);
              }

              console.log(`[rebuildIndexNode]   📦 Format: JSON package`);
            } catch (jsonError) {
              throw new Error(`Invalid JSON structure: ${(jsonError as Error).message}`);
            }
          } else if (trimmedText.length > 0 && !trimmedText.includes('\x00') && trimmedText.length < 10000) {
            // Plain text format - cannot index without embedding
            throw new Error('Plain text format detected but no embedding available - skip');
          } else {
            throw new Error('Binary, encrypted, or empty content - cannot index');
          }

          // Add to HNSW index
          await hnswService.addVector(
            userAddress,
            memory.vectorId,
            embedding,
            {
              blobId: memory.blobId,
              memoryObjectId: memory.id,
              category: metadata.category || memory.category || tags?.['category'],
              importance: metadata.importance || memory.importance || parseInt(tags?.['importance'] || '5'),
              topic: metadata.topic || tags?.['topic'] || '',
              timestamp,
              content,
              isEncrypted: false
            }
          );

          indexedCount++;
          console.log(`[rebuildIndexNode]   ✓ Indexed: "${content.substring(0, 30)}..."`);

        } catch (error: any) {
          failedCount++;
          const errorMsg = error.message || String(error);
          errors.push({ blobId: memory.blobId, error: errorMsg });
          console.error(`[rebuildIndexNode]   ✗ Failed: ${errorMsg}`);
        }
      }
    }

    // ==================== QUILT MEMORIES ====================
    // Process additional Quilts that may not have on-chain Memory objects
    let quiltMemoriesTotal = 0;
    let quiltMemoriesIndexed = 0;

    if (quiltIds.length > 0) {
      console.log(`\n[rebuildIndexNode] Processing ${quiltIds.length} additional Quilt(s)...`);
      onProgress?.(processedCount, totalMemories + quiltIds.length, 'Processing Quilts...');

      for (const quiltId of quiltIds) {
        console.log(`[rebuildIndexNode] Processing Quilt: ${quiltId.substring(0, 30)}...`);

        try {
          // Fetch Quilt files
          const blob = await walrusClient.walrus.getBlob({ blobId: quiltId });
          const files = await blob.files();
          console.log(`[rebuildIndexNode]   📥 Fetched Quilt: ${files.length} file(s)`);

          // Process each file in the Quilt
          for (let fileIdx = 0; fileIdx < files.length; fileIdx++) {
            const file = files[fileIdx];
            quiltMemoriesTotal++;

            try {
              const identifier = await file.getIdentifier() || `quilt-file-${fileIdx}`;
              const tags = await file.getTags();

              // Parse JSON content
              const rawBytes = await file.bytes();
              let rawText = new TextDecoder().decode(rawBytes);

              // Trim trailing null bytes (Quilt corruption workaround)
              let lastValidIndex = rawText.length - 1;
              while (lastValidIndex >= 0 && rawText.charCodeAt(lastValidIndex) === 0) {
                lastValidIndex--;
              }
              rawText = rawText.slice(0, lastValidIndex + 1);

              if (!rawText.startsWith('{') || !rawText.endsWith('}')) {
                throw new Error('Not a JSON file');
              }

              const memoryData: MemoryContent = JSON.parse(rawText);

              if (!memoryData.embedding || memoryData.embedding.length === 0) {
                throw new Error('No embedding in package');
              }

              // Generate unique vector ID for Quilt memory
              const vectorId = Date.now() % 4294967295 + fileIdx;
              const memoryId = (memoryData as any).metadata?.memoryId || identifier.replace('.json', '');

              // Add to HNSW index
              await hnswService.addVector(
                userAddress,
                vectorId,
                memoryData.embedding,
                {
                  blobId: quiltId,
                  memoryObjectId: memoryId,
                  category: memoryData.metadata?.category || tags?.['category'] || 'general',
                  importance: memoryData.metadata?.importance || parseInt(tags?.['importance'] || '3'),
                  topic: memoryData.metadata?.topic || tags?.['topic'] || '',
                  timestamp: memoryData.timestamp || Date.now(),
                  content: memoryData.content || '[encrypted]',
                  isEncrypted: (memoryData as any).encrypted === true,
                  quiltId,
                  identifier
                }
              );

              quiltMemoriesIndexed++;
              console.log(`[rebuildIndexNode]   ✓ Indexed Quilt file: ${identifier}`);

            } catch (fileError: any) {
              const errorMsg = fileError.message || String(fileError);
              errors.push({ blobId: quiltId, error: `File ${fileIdx}: ${errorMsg}` });
              console.error(`[rebuildIndexNode]   ✗ Failed file ${fileIdx}: ${errorMsg}`);
            }
          }

        } catch (quiltError: any) {
          const errorMsg = quiltError.message || String(quiltError);
          errors.push({ blobId: quiltId, error: `Quilt fetch failed: ${errorMsg}` });
          console.error(`[rebuildIndexNode]   ✗ Failed to fetch Quilt: ${errorMsg}`);
        }
      }

      console.log(`[rebuildIndexNode] Quilt indexing complete: ${quiltMemoriesIndexed}/${quiltMemoriesTotal}`);
    }

    // Update totals
    const finalTotal = totalMemories + quiltMemoriesTotal;
    const finalIndexed = indexedCount + quiltMemoriesIndexed;
    const finalFailed = failedCount + (quiltMemoriesTotal - quiltMemoriesIndexed);

    timing.processingMs = Date.now() - processingStart;
    console.log(`[rebuildIndexNode] ⏱️ Processing: ${timing.processingMs}ms`);

    // Force save index
    const saveStart = Date.now();
    console.log('[rebuildIndexNode] Saving index to disk...');
    onProgress?.(finalTotal, finalTotal, 'Saving index...');
    await hnswService.flushBatch(userAddress);
    timing.saveMs = Date.now() - saveStart;
    console.log(`[rebuildIndexNode] ⏱️ Save: ${timing.saveMs}ms`);

    const duration = Date.now() - startTime;
    console.log('[rebuildIndexNode] Index rebuild complete!');
    console.log(`[rebuildIndexNode] On-chain: ${totalMemories}, Quilts: ${quiltMemoriesTotal}, Total indexed: ${finalIndexed}, Failed: ${finalFailed}`);
    console.log(`[rebuildIndexNode] Duration: ${(duration / 1000).toFixed(2)}s`);
    console.log(`[rebuildIndexNode] ⏱️ TIMING BREAKDOWN:`);
    console.log(`   Init:       ${timing.initMs}ms (${((timing.initMs / duration) * 100).toFixed(1)}%)`);
    console.log(`   Blockchain: ${timing.blockchainFetchMs}ms (${((timing.blockchainFetchMs / duration) * 100).toFixed(1)}%)`);
    console.log(`   Walrus:     ${timing.walrusFetchMs}ms (${((timing.walrusFetchMs / duration) * 100).toFixed(1)}%)`);
    console.log(`   Processing: ${timing.processingMs}ms (${((timing.processingMs / duration) * 100).toFixed(1)}%)`);
    console.log(`   Save:       ${timing.saveMs}ms (${((timing.saveMs / duration) * 100).toFixed(1)}%)`);

    return {
      success: true,
      totalMemories: finalTotal,
      indexedMemories: finalIndexed,
      failedMemories: finalFailed,
      errors,
      duration,
      timing
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
