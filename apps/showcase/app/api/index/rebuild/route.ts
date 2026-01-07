import { getFullnodeUrl, SuiClient } from '@mysten/sui/client';
import { NextRequest } from 'next/server';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

// Server-side lock to prevent concurrent rebuilds for the same user
const rebuildInProgress: Map<string, Promise<Response>> = new Map();

/**
 * POST /api/index/rebuild
 * Force rebuild HNSW index from blockchain + Walrus
 *
 * Body: { walletAddress: string }
 *
 * Use this when:
 * - User logs in on a new device
 * - Index is out of sync
 * - Manual refresh needed
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

    // Check if rebuild is already in progress for this user
    if (rebuildInProgress.has(walletAddress)) {
      console.log(`⏳ [/api/index/rebuild] Rebuild already in progress for ${walletAddress.slice(0, 10)}..., waiting...`);
      const existingPromise = rebuildInProgress.get(walletAddress)!;
      // Clone the response since Response can only be consumed once
      const result = await existingPromise;
      const clonedBody = await result.clone().text();
      return new Response(clonedBody, {
        status: result.status,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    // Create and store the rebuild promise
    const rebuildPromise = performRebuild(walletAddress, startTime);
    rebuildInProgress.set(walletAddress, rebuildPromise);

    try {
      const response = await rebuildPromise;
      return response;
    } finally {
      rebuildInProgress.delete(walletAddress);
    }

  } catch (error) {
    console.error('❌ Index rebuild API error:', error);
    return new Response(JSON.stringify({
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error'
    }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
}

async function performRebuild(walletAddress: string, startTime: number): Promise<Response> {
  console.log(`\n${'='.repeat(70)}`);
  console.log(`🔄 [/api/index/rebuild] REBUILDING INDEX FROM BLOCKCHAIN`);
  console.log(`${'='.repeat(70)}`);
  console.log(`📍 Working directory: ${process.cwd()}`);
  console.log(`📍 Wallet: ${walletAddress}`);

  const { rebuildIndexNode, clearIndexNode } = await import('@cmdoss/memwal-sdk');

  // Clear existing index first
  console.log(`\n🗑️ Clearing existing index...`);
  await clearIndexNode(walletAddress);
  console.log(`   ✅ Index cleared`);

  const network = (process.env.SUI_NETWORK as 'testnet' | 'mainnet') || 'testnet';
  const client = new SuiClient({ url: getFullnodeUrl(network) });

  console.log(`\n🔄 Starting rebuild...`);
  console.log(`   Network: ${network}`);
  console.log(`   Package ID: ${process.env.PACKAGE_ID}`);

  const result = await rebuildIndexNode({
    userAddress: walletAddress,
    client,
    packageId: process.env.PACKAGE_ID!,
    walrusAggregator: process.env.WALRUS_AGGREGATOR || 'https://aggregator.walrus-testnet.walrus.space',
    force: true,
    fetchConcurrency: 10, // Optimized based on benchmark (1.64x faster than sequential)
    onProgress: (current, total, status) => {
      console.log(`   [${current}/${total}] ${status}`);
    }
  });

  // Check index files after rebuild
  console.log(`\n📁 Verifying index files...`);
  const fs = await import('fs/promises');
  const indexDir = './.pdw-indexes';
  try {
    const files = await fs.readdir(indexDir);
    console.log(`   Index directory contents: ${files.length > 0 ? files.join(', ') : '(empty)'}`);

    const safeAddress = walletAddress.replace(/[^a-zA-Z0-9]/g, '_');
    const expectedFile = `${safeAddress}.hnsw`;
    if (files.includes(expectedFile)) {
      const stats = await fs.stat(`${indexDir}/${expectedFile}`);
      console.log(`   📄 ${expectedFile}: ${stats.size} bytes, modified ${stats.mtime}`);
    }
  } catch (e) {
    console.log(`   ⚠️ Could not verify index files: ${e}`);
  }

  const totalDuration = Date.now() - startTime;
  console.log(`\n✅ Rebuild complete in ${(totalDuration / 1000).toFixed(2)}s`);
  console.log(`   Total: ${result.totalMemories}, Indexed: ${result.indexedMemories}, Failed: ${result.failedMemories}`);
  console.log(`${'='.repeat(70)}\n`);

  return new Response(JSON.stringify({
    success: result.success,
    message: result.success
      ? `Index rebuilt successfully: ${result.indexedMemories}/${result.totalMemories} memories indexed`
      : 'Index rebuild had issues',
    data: {
      totalMemories: result.totalMemories,
      indexedMemories: result.indexedMemories,
      failedMemories: result.failedMemories,
      duration: result.duration,
      durationFormatted: `${(result.duration / 1000).toFixed(2)}s`,
      timing: result.timing
    }
  }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' }
  });
}
