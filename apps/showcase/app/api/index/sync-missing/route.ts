import { getFullnodeUrl, SuiClient } from '@mysten/sui/client';
import { WalrusClient, WalrusFile } from '@mysten/walrus';
import { NextRequest } from 'next/server';
import { getReadOnlyPDWClient } from '@/lib/pdw-read-only';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

// Lock to prevent concurrent syncs for the same user
const syncInProgress: Map<string, Promise<Response>> = new Map();

// Cache for Quilt files to avoid re-fetching
const quiltFileCache: Map<string, WalrusFile[]> = new Map();

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
 * Extract base Quilt ID from a blobId that may have a suffix
 * Walrus blobIds are base64url encoded 32 bytes = 43 characters
 * Quilt file IDs have a suffix appended (like 'BAgBmAA', 'BZgDKAA')
 *
 * Examples:
 * - 'xRntOonjqnLFUe37FE2vFVMJFiZtFiCLWCqFUUN1lEE' → base (43 chars)
 * - 'xRntOonjqnLFUe37FE2vFVMJFiZtFiCLWCqFUUN1lEEBAgBmAA' → base + suffix
 */
function extractBaseQuiltId(blobId: string): string {
  // Standard Walrus blobId is 43 characters (base64url of 32 bytes)
  const BASE_BLOB_ID_LENGTH = 43;

  if (blobId.length > BASE_BLOB_ID_LENGTH) {
    return blobId.substring(0, BASE_BLOB_ID_LENGTH);
  }
  return blobId;
}

/**
 * Extract suffix from blobId (the quilt file identifier part)
 */
function extractQuiltSuffix(blobId: string): string | null {
  const BASE_BLOB_ID_LENGTH = 43;

  if (blobId.length > BASE_BLOB_ID_LENGTH) {
    return blobId.substring(BASE_BLOB_ID_LENGTH);
  }
  return null;
}

/**
 * POST /api/index/sync-missing
 * Incrementally sync only NEW memories from blockchain to local index
 * Much faster than full rebuild - only fetches missing memories
 * Checks by blobId - if already indexed, skip
 *
 * Body: { walletAddress: string }
 */
export async function POST(req: NextRequest) {
  const startTime = Date.now();

  try {
    const { walletAddress } = await req.json();

    if (!walletAddress) {
      return new Response(JSON.stringify({
        success: false,
        error: 'walletAddress is required'
      }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    // Check if sync is already in progress for this user
    if (syncInProgress.has(walletAddress)) {
      console.log(`⏳ [/api/index/sync-missing] Sync already in progress for ${walletAddress.slice(0, 10)}..., waiting...`);
      const existingPromise = syncInProgress.get(walletAddress)!;
      const result = await existingPromise;
      const clonedBody = await result.clone().text();
      return new Response(clonedBody, {
        status: result.status,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    // Create and store the sync promise
    const syncPromise = performIncrementalSync(walletAddress, startTime);
    syncInProgress.set(walletAddress, syncPromise);

    try {
      const response = await syncPromise;
      return response;
    } finally {
      syncInProgress.delete(walletAddress);
    }

  } catch (error) {
    console.error('❌ Index sync-missing API error:', error);
    return new Response(JSON.stringify({
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error'
    }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
}

async function performIncrementalSync(walletAddress: string, startTime: number): Promise<Response> {
  console.log(`\n${'='.repeat(70)}`);
  console.log(`🔄 [/api/index/sync-missing] INCREMENTAL INDEX SYNC`);
  console.log(`${'='.repeat(70)}`);
  console.log(`📍 Wallet: ${walletAddress}`);

  const fs = await import('fs/promises');
  const network = (process.env.SUI_NETWORK as 'testnet' | 'mainnet') || 'testnet';
  const client = new SuiClient({ url: getFullnodeUrl(network) });
  const packageId = process.env.PACKAGE_ID!;

  // Step 1: Get existing indexed blobIds from local metadata
  const safeAddress = walletAddress.replace(/[^a-zA-Z0-9]/g, '_');
  const metadataPath = `./.pdw-indexes/${safeAddress}.hnsw.meta.json`;

  let existingBlobIds = new Set<string>();

  try {
    const metaContent = await fs.readFile(metadataPath, 'utf-8');
    const meta = JSON.parse(metaContent);
    // Collect all blobIds that are already indexed
    for (const [, entry] of Object.entries(meta.metadata || {})) {
      const memEntry = entry as any;
      if (memEntry.blobId) {
        existingBlobIds.add(memEntry.blobId);
      }
    }
    console.log(`📊 Existing index: ${existingBlobIds.size} memories (by blobId)`);
  } catch {
    console.log(`📊 No existing index found - will fetch all`);
  }

  // Step 2: Fetch all memories from blockchain
  console.log(`\n🔍 Fetching memories from blockchain...`);
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
      owner: walletAddress,
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

  console.log(`   Found ${memories.length} memories on-chain`);

  // Step 3: Filter to only NEW memories by blobId (not in local index)
  const newMemories = memories.filter(m => !existingBlobIds.has(m.blobId));

  console.log(`   New memories to sync: ${newMemories.length}`);

  if (newMemories.length === 0) {
    const duration = Date.now() - startTime;
    console.log(`\n✅ Index already up to date! (${duration}ms)`);
    console.log(`${'='.repeat(70)}\n`);

    return new Response(JSON.stringify({
      success: true,
      message: 'Index already up to date',
      data: {
        totalOnChain: memories.length,
        alreadyIndexed: existingBlobIds.size,
        newlyIndexed: 0,
        failed: 0,
        duration
      }
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });
  }

  // Step 4: Get PDW client (which has HNSW service) and Walrus client
  const pdw = await getReadOnlyPDWClient(walletAddress);

  const walrusClient = client.$extend(
    WalrusClient.experimental_asClientExtension({
      network,
      storageNodeClientOptions: {
        timeout: 60_000,
      },
    })
  );

  // Step 5: Fetch and index only NEW memories
  let indexedCount = 0;
  let failedCount = 0;
  const errors: Array<{ blobId: string; error: string }> = [];

  console.log(`\n📥 Fetching ${newMemories.length} new memories from Walrus...`);

  // Group memories by BASE quiltId to handle Quilts efficiently
  // In a Quilt, multiple memories share the same base quiltId but have different suffixes
  // e.g., 'xRntOonjq...N1lEEBAgBmAA' and 'xRntOonjq...N1lEEBZgDKAA' share base 'xRntOonjq...N1lEE'
  const memoriesByBaseQuiltId = new Map<string, typeof newMemories>();
  for (const memory of newMemories) {
    const baseQuiltId = extractBaseQuiltId(memory.blobId);
    const list = memoriesByBaseQuiltId.get(baseQuiltId) || [];
    list.push(memory);
    memoriesByBaseQuiltId.set(baseQuiltId, list);
  }

  const hasQuilts = memoriesByBaseQuiltId.size < newMemories.length;
  console.log(`   📦 Unique base quiltIds: ${memoriesByBaseQuiltId.size} (${hasQuilts ? 'Quilt batch detected' : 'individual blobs'})`);

  let processedCount = 0;

  for (const [baseQuiltId, memoriesInQuilt] of memoriesByBaseQuiltId) {
    const hasSuffixes = memoriesInQuilt.some(m => extractQuiltSuffix(m.blobId) !== null);
    console.log(`\n   🔍 Processing ${hasSuffixes ? 'Quilt' : 'blob'} ${baseQuiltId.substring(0, 20)}... (${memoriesInQuilt.length} memories)`);

    try {
      // Use getBlob().files() to correctly parse Quilt structure
      // For regular blob: returns [singleFile]
      // For Quilt: returns [file1, file2, ...] - all files in the quilt
      // IMPORTANT: Use baseQuiltId (without suffix) for fetching
      let files: WalrusFile[];

      if (quiltFileCache.has(baseQuiltId)) {
        files = quiltFileCache.get(baseQuiltId)!;
        console.log(`      ♻️ Using cached files (${files.length} files)`);
      } else {
        // Try to parse as Quilt first (getBlob().files() returns ALL files in Quilt)
        // Fall back to getFiles() for regular blobs
        try {
          const blob = await walrusClient.walrus.getBlob({ blobId: baseQuiltId });
          files = await blob.files();
          console.log(`      📥 Fetched Quilt: ${files.length} file(s)`);
        } catch (quiltError: any) {
          // Not a Quilt or parse error - try as regular blob
          const errorMsg = quiltError.message || '';
          if (errorMsg.includes('Unsupported quilt version') || errorMsg.includes('quilt')) {
            console.log(`      📄 Not a Quilt format, fetching as regular blob...`);
          } else {
            console.log(`      ⚠️ Quilt parse failed (${errorMsg.substring(0, 30)}), trying regular blob...`);
          }
          // getFiles returns single file for regular blob
          files = await walrusClient.walrus.getFiles({ ids: [baseQuiltId] });
          console.log(`      📥 Fetched regular blob: ${files.length} file(s)`);
        }
        quiltFileCache.set(baseQuiltId, files);
      }

      // For each memory in this Quilt/blob
      for (let i = 0; i < memoriesInQuilt.length; i++) {
        const memory = memoriesInQuilt[i];
        processedCount++;
        const suffix = extractQuiltSuffix(memory.blobId);
        console.log(`      [${processedCount}/${newMemories.length}] Processing vectorId=${memory.vectorId}${suffix ? ` (suffix: ${suffix})` : ''}...`);

        try {
          let content: string;
          let embedding: number[];
          let metadata: { category?: string; importance?: number; topic?: string } = {};
          let timestamp = Date.now();

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
              console.log(`         🎯 Matched by ${matchStrategy}`);
            }
          }

          if (!file) {
            throw new Error(`No file found for memory vectorId=${memory.vectorId} (Quilt has ${files.length} files)`);
          }

          // Get file content
          const rawBytes = await file.bytes();
          const rawText = new TextDecoder().decode(rawBytes);
          const trimmedText = rawText.trim();

          // Get file identifier and tags if available (for Quilts)
          const identifier = await file.getIdentifier();
          const tags = await file.getTags();

          if (identifier) {
            console.log(`         📎 File identifier: ${identifier}`);
          }

          if (trimmedText.startsWith('{') && trimmedText.endsWith('}')) {
            // JSON package format (correct format)
            try {
              const memoryData: MemoryContent = JSON.parse(trimmedText);
              content = memoryData.content;
              embedding = memoryData.embedding;
              metadata = memoryData.metadata || {};
              timestamp = memoryData.timestamp || Date.now();

              // Validate embedding exists and has reasonable length (768, 1536, or 3072 are common)
              if (!embedding || embedding.length < 768) {
                throw new Error(`Invalid embedding in JSON: length=${embedding?.length || 0} (min 768)`);
              }

              // Debug: Log content status
              if (content && content.length > 0) {
                console.log(`         📦 Format: JSON package (content: ${content.length} chars)`);
              } else {
                console.log(`         📦 Format: JSON package (⚠️ content EMPTY - QuiltBatchManager bug)`);
              }
            } catch (jsonError) {
              throw new Error(`Invalid JSON structure: ${(jsonError as Error).message}`);
            }
          } else if (trimmedText.length > 0 && !trimmedText.includes('\x00') && trimmedText.length < 10000) {
            // Plain text format (legacy format)
            const isPrintable = /^[\x20-\x7E\n\r\t\u00A0-\uFFFF]+$/.test(trimmedText);

            if (isPrintable) {
              console.log(`         📝 Format: Plain text (generating embedding...)`);
              content = trimmedText;

              // Generate embedding for plain text
              try {
                const embeddingResult = await pdw.embeddings.generate(content);
                embedding = Array.from(embeddingResult);

                // Validate embedding has reasonable length (default is now 768)
                if (embedding.length < 768) {
                  throw new Error(`Generated embedding too small: ${embedding.length} (min 768)`);
                }
              } catch (embError) {
                throw new Error(`Failed to generate embedding: ${(embError as Error).message}`);
              }
            } else {
              throw new Error('Binary or encrypted content - cannot index');
            }
          } else {
            throw new Error('Binary, encrypted, or empty content - cannot index');
          }

          // Add to HNSW index
          await pdw.index.add(
            walletAddress,
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
          console.log(`         ✓ Indexed: "${content.substring(0, 30)}..."`);

        } catch (error: any) {
          failedCount++;
          const errorMsg = error.message || String(error);
          errors.push({ blobId: memory.blobId, error: errorMsg });
          console.log(`         ✗ Failed: ${errorMsg.substring(0, 50)}...`);
        }
      }

    } catch (error: any) {
      // Failed to fetch files for this Quilt/blobId
      const errorMsg = error.message || String(error);
      console.log(`      ✗ Failed to fetch Quilt/blob: ${errorMsg.substring(0, 50)}...`);

      for (const memory of memoriesInQuilt) {
        processedCount++;
        failedCount++;
        errors.push({ blobId: memory.blobId, error: `Failed to fetch blob: ${errorMsg}` });
      }
    }
  }

  // Clear cache after processing
  quiltFileCache.clear();

  // Step 6: Flush index to disk
  console.log(`\n💾 Saving index...`);
  await pdw.index.flush(walletAddress);

  const duration = Date.now() - startTime;
  console.log(`\n✅ Incremental sync complete in ${(duration / 1000).toFixed(2)}s`);
  console.log(`   Total on-chain: ${memories.length}`);
  console.log(`   Already indexed: ${existingBlobIds.size}`);
  console.log(`   Newly indexed: ${indexedCount}`);
  console.log(`   Failed: ${failedCount}`);
  console.log(`${'='.repeat(70)}\n`);

  return new Response(JSON.stringify({
    success: true,
    message: indexedCount > 0
      ? `Synced ${indexedCount} new memories`
      : 'No new memories to sync',
    data: {
      totalOnChain: memories.length,
      alreadyIndexed: existingBlobIds.size,
      newlyIndexed: indexedCount,
      failed: failedCount,
      errors: errors.length > 0 ? errors : undefined,
      duration
    }
  }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' }
  });
}
