import { forceRebuildIndex } from '@/lib/pdw-service';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * POST /api/index/rebuild
 * Force rebuild HNSW index from blockchain + Walrus
 *
 * Use this when:
 * - User logs in on a new device
 * - Index is out of sync
 * - Manual refresh needed
 */
export async function POST() {
  try {
    console.log('🔄 Starting index rebuild via API...');

    const result = await forceRebuildIndex();

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
