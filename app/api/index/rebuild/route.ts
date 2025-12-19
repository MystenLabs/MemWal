import { getFullnodeUrl, SuiClient } from '@mysten/sui/client';
import { NextRequest } from 'next/server';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

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

    console.log(`🔄 Starting index rebuild for wallet: ${walletAddress}...`);

    const { rebuildIndexNode, clearIndexNode } = await import('@cmdoss/memwal-sdk');

    // Clear existing index first
    await clearIndexNode(walletAddress);

    const network = (process.env.SUI_NETWORK as 'testnet' | 'mainnet') || 'testnet';
    const client = new SuiClient({ url: getFullnodeUrl(network) });

    const result = await rebuildIndexNode({
      userAddress: walletAddress,
      client,
      packageId: process.env.PACKAGE_ID!,
      walrusAggregator: process.env.WALRUS_AGGREGATOR || 'https://aggregator.walrus-testnet.walrus.space',
      force: true,
      onProgress: (current, total, status) => {
        console.log(`[Index Rebuild] ${current}/${total}: ${status}`);
      }
    });

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
        durationFormatted: `${(result.duration / 1000).toFixed(2)}s`
      }
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });

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
