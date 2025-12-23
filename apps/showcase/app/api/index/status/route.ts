import { NextRequest } from 'next/server';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * GET /api/index/status?walletAddress=xxx
 * Check if local HNSW index exists and get its stats
 *
 * Returns:
 * - hasLocalIndex: boolean - whether local index file exists
 * - localIndexCount: number - number of vectors in the index
 * - walrusBlobId: string | null - Walrus backup blob ID if available
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

    const { hasExistingIndexNode } = await import('@cmdoss/memwal-sdk');
    const fs = await import('fs/promises');

    // Check if local index exists
    const hasLocalIndex = await hasExistingIndexNode(walletAddress);

    let localIndexCount = 0;
    let walrusBlobId: string | null = null;

    if (hasLocalIndex) {
      // Read index stats from metadata file
      const safeAddress = walletAddress.replace(/[^a-zA-Z0-9]/g, '_');
      const metadataPath = `./.pdw-indexes/${safeAddress}.hnsw.meta.json`;

      try {
        const metaContent = await fs.readFile(metadataPath, 'utf-8');
        const meta = JSON.parse(metaContent);
        localIndexCount = Object.keys(meta.metadata || {}).length;
        walrusBlobId = meta.walrusBlobId || null;
      } catch {
        // Index exists but no metadata - fallback
        localIndexCount = 0;
      }
    }

    console.log(`[/api/index/status] ${walletAddress.slice(0, 10)}... hasIndex=${hasLocalIndex}, count=${localIndexCount}`);

    return new Response(JSON.stringify({
      success: true,
      data: {
        hasLocalIndex,
        localIndexCount,
        walrusBlobId
      }
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });

  } catch (error) {
    console.error('❌ Index status API error:', error);
    return new Response(JSON.stringify({
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error'
    }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
}
