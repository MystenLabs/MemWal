import { NextRequest } from 'next/server';
import { getReadOnlyPDWClient } from '@/lib/pdw-read-only';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * POST /api/index/sync
 * Sync local HNSW index to Walrus cloud storage
 *
 * Body: { walletAddress: string }
 *
 * Returns:
 * - blobId: Walrus blob ID of the synced index
 * - Can be used to restore index on other devices
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

    console.log(`\n${'='.repeat(70)}`);
    console.log(`☁️ [/api/index/sync] SYNCING INDEX TO WALRUS`);
    console.log(`${'='.repeat(70)}`);
    console.log(`📍 Wallet: ${walletAddress}`);

    // Get PDW client with Walrus backup enabled
    const pdw = await getReadOnlyPDWClient(walletAddress);

    // Check if Walrus backup is enabled
    if (!pdw.index.isWalrusEnabled()) {
      console.log('⚠️ Walrus backup not enabled for this client');
      return new Response(JSON.stringify({
        success: false,
        error: 'Walrus backup is not enabled. Configure indexBackup in client settings.'
      }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    // Sync index to Walrus
    console.log('📤 Uploading index to Walrus...');
    const blobId = await pdw.index.syncToWalrus(walletAddress);

    if (!blobId) {
      return new Response(JSON.stringify({
        success: false,
        error: 'Failed to sync index to Walrus'
      }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    const duration = Date.now() - startTime;
    console.log(`✅ Index synced to Walrus in ${(duration / 1000).toFixed(2)}s`);
    console.log(`   Blob ID: ${blobId}`);
    console.log(`${'='.repeat(70)}\n`);

    return new Response(JSON.stringify({
      success: true,
      message: 'Index synced to Walrus successfully',
      data: {
        blobId,
        duration,
        durationFormatted: `${(duration / 1000).toFixed(2)}s`
      }
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });

  } catch (error) {
    console.error('❌ Index sync API error:', error);
    return new Response(JSON.stringify({
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error'
    }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
}

/**
 * GET /api/index/sync?walletAddress=xxx
 * Get the current Walrus blob ID for user's index
 */
export async function GET(req: NextRequest) {
  try {
    const walletAddress = req.nextUrl.searchParams.get('walletAddress');

    if (!walletAddress) {
      return new Response(JSON.stringify({
        success: false,
        error: 'walletAddress query parameter is required'
      }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    const pdw = await getReadOnlyPDWClient(walletAddress);
    const blobId = pdw.index.getWalrusBlobId(walletAddress);
    const isEnabled = pdw.index.isWalrusEnabled();

    return new Response(JSON.stringify({
      success: true,
      data: {
        walrusEnabled: isEnabled,
        blobId: blobId || null
      }
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });

  } catch (error) {
    console.error('❌ Get index blob ID error:', error);
    return new Response(JSON.stringify({
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error'
    }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
}
