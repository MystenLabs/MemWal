/**
 * Test endpoint for pdw.memory.getRelated()
 *
 * Usage:
 * curl -X GET "http://localhost:3000/api/test/memory-related?memoryId=YOUR_MEMORY_ID&walletAddress=YOUR_WALLET&k=5"
 */
import { NextRequest, NextResponse } from 'next/server';
import { getReadOnlyPDWClient } from '@/lib/pdw-read-only';

// Force dynamic rendering
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const DUMMY_WALLET = '0x0000000000000000000000000000000000000000000000000000000000000000';

export async function GET(request: NextRequest) {
  const memoryId = request.nextUrl.searchParams.get('memoryId');
  const walletAddress = request.nextUrl.searchParams.get('walletAddress');
  const k = parseInt(request.nextUrl.searchParams.get('k') || '5');

  if (!memoryId) {
    return NextResponse.json(
      { error: 'memoryId query param is required' },
      { status: 400 }
    );
  }

  try {
    console.log(`[TEST] memory.getRelated() - memoryId: ${memoryId}, k: ${k}`);

    const pdw = await getReadOnlyPDWClient(walletAddress || DUMMY_WALLET);
    const related = await pdw.memory.getRelated(memoryId, k);

    console.log(`[TEST] memory.getRelated() found ${related.length} related memories`);

    return NextResponse.json({
      success: true,
      memoryId,
      k,
      count: related.length,
      related: related.map((m: any) => ({
        id: m.id,
        content: m.content?.substring(0, 200) + (m.content?.length > 200 ? '...' : ''),
        category: m.category,
        importance: m.importance,
        blobId: m.blobId,
      }))
    });
  } catch (error) {
    console.error('[TEST] memory.getRelated() error:', error);
    return NextResponse.json(
      {
        success: false,
        error: error instanceof Error ? error.message : String(error)
      },
      { status: 500 }
    );
  }
}
