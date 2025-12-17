import { getPDWClient } from '@/lib/pdw-service';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * POST /api/memory/save
 * Save a memory to blockchain when user explicitly requests it
 *
 * Body: { content: string, category?: string }
 */
export async function POST(req: Request) {
  try {
    const { content, category } = await req.json();

    if (!content || typeof content !== 'string' || content.trim().length === 0) {
      return new Response(JSON.stringify({
        success: false,
        error: 'Content is required'
      }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    console.log(`💾 Saving memory: "${content.substring(0, 50)}..."`);

    const pdw = await getPDWClient();

    // Use the pipeline to create memory with proper classification
    const result = await pdw.pipeline.createMemory(content, {
      category: category || 'custom',
      importance: 5, // High importance for explicit saves
    });

    console.log(`✅ Memory saved:`, result);

    return new Response(JSON.stringify({
      success: true,
      memoryId: result.memoryObjectId,
      blobId: result.blobId,
      message: 'Memory saved to blockchain successfully'
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });

  } catch (error) {
    console.error('❌ Memory save error:', error);
    return new Response(JSON.stringify({
      success: false,
      error: error instanceof Error ? error.message : 'Failed to save memory'
    }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
}
