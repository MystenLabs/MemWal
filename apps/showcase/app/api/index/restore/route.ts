import { NextRequest } from 'next/server';
import { getReadOnlyPDWClient } from '@/lib/pdw-read-only';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * POST /api/index/restore
 * Restore local HNSW index from Walrus cloud storage
 *
 * Body: { walletAddress: string, blobId: string }
 *
 * Use this when:
 * - User logs in on a new device and has a previously synced index
 * - Faster than rebuilding from blockchain (direct binary restore)
 */
export async function POST(req: NextRequest) {
  const startTime = Date.now();

  try {
    const { walletAddress, blobId } = await req.json();

    if (!walletAddress) {
      return new Response(JSON.stringify({
        success: false,
        error: 'walletAddress is required'
      }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    if (!blobId) {
      return new Response(JSON.stringify({
        success: false,
        error: 'blobId is required'
      }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    console.log(`\n${'='.repeat(70)}`);
    console.log(`📥 [/api/index/restore] RESTORING INDEX FROM WALRUS`);
    console.log(`${'='.repeat(70)}`);
    console.log(`📍 Wallet: ${walletAddress}`);
    console.log(`📍 Blob ID: ${blobId}`);

    // Get PDW client
    const pdw = await getReadOnlyPDWClient(walletAddress);

    // Check if Walrus backup is enabled
    if (!pdw.index.isWalrusEnabled()) {
      console.log('⚠️ Walrus backup not enabled, cannot restore');
      return new Response(JSON.stringify({
        success: false,
        error: 'Walrus backup is not enabled. Configure indexBackup in client settings.'
      }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    // Load index from Walrus
    console.log('📥 Downloading index from Walrus...');
    const loaded = await pdw.index.loadFromWalrus(walletAddress, blobId);

    if (!loaded) {
      return new Response(JSON.stringify({
        success: false,
        error: 'Failed to restore index from Walrus. The blob may not exist or be corrupted.'
      }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    // Get index stats after restore
    let indexStats = null;
    try {
      indexStats = pdw.index.getStats(walletAddress);
    } catch (e) {
      console.warn('Could not get index stats:', e);
    }

    const duration = Date.now() - startTime;
    console.log(`✅ Index restored from Walrus in ${(duration / 1000).toFixed(2)}s`);
    if (indexStats) {
      console.log(`   Total vectors: ${indexStats.totalVectors}`);
    }
    console.log(`${'='.repeat(70)}\n`);

    return new Response(JSON.stringify({
      success: true,
      message: 'Index restored from Walrus successfully',
      data: {
        blobId,
        duration,
        durationFormatted: `${(duration / 1000).toFixed(2)}s`,
        indexStats
      }
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });

  } catch (error) {
    console.error('❌ Index restore API error:', error);
    return new Response(JSON.stringify({
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error'
    }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
}
