import { getFullnodeUrl, SuiClient } from '@mysten/sui/client';
import { WalrusClient } from '@mysten/walrus';
import { NextRequest } from 'next/server';
import { getReadOnlyPDWClient } from '@/lib/pdw-read-only';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

// Lock to prevent concurrent syncs for the same user
const syncInProgress: Map<string, Promise<Response>> = new Map();

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

  for (let i = 0; i < newMemories.length; i++) {
    const memory = newMemories[i];
    console.log(`   [${i + 1}/${newMemories.length}] ${memory.blobId.substring(0, 20)}...`);

    try {
      // Download content from Walrus
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

      // Add to HNSW index via PDW client's index namespace
      await pdw.index.add(
        walletAddress,
        memory.vectorId,
        embedding,
        {
          blobId: memory.blobId,
          memoryObjectId: memory.id,
          category: memory.category,
          importance: memory.importance,
          topic: memoryData.metadata?.topic || '',
          timestamp: memoryData.timestamp,
          content: memoryData.content,
          isEncrypted: false
        }
      );

      indexedCount++;
      console.log(`      ✓ Indexed: "${memoryData.content.substring(0, 30)}..."`);

    } catch (error: any) {
      failedCount++;
      const errorMsg = error.message || String(error);
      errors.push({ blobId: memory.blobId, error: errorMsg });
      console.log(`      ✗ Failed: ${errorMsg.substring(0, 50)}...`);
    }
  }

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
