/**
 * Test endpoint for indexing Quilt memories into local HNSW index
 *
 * Usage:
 * curl -X POST "http://localhost:3000/api/test/quilt-index" \
 *   -H "Content-Type: application/json" \
 *   -d '{"quiltId": "YOUR_QUILT_ID", "walletAddress": "YOUR_WALLET"}'
 */
import { NextRequest, NextResponse } from 'next/server';
import { getReadOnlyPDWClient } from '@/lib/pdw-read-only';

// Force dynamic rendering
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function POST(request: NextRequest) {
  try {
    const { quiltId, walletAddress } = await request.json();

    if (!quiltId) {
      return NextResponse.json(
        { error: 'quiltId is required' },
        { status: 400 }
      );
    }

    if (!walletAddress) {
      return NextResponse.json(
        { error: 'walletAddress is required' },
        { status: 400 }
      );
    }

    console.log(`[TEST] memory.indexFromQuilt() - quiltId: ${quiltId}`);

    const pdw = await getReadOnlyPDWClient(walletAddress);
    const result = await pdw.memory.indexFromQuilt(quiltId);

    return NextResponse.json({
      success: result.success,
      quiltId,
      walletAddress,
      result,
    });
  } catch (error) {
    console.error('[TEST] quilt-index error:', error);
    return NextResponse.json(
      {
        success: false,
        error: error instanceof Error ? error.message : String(error),
      },
      { status: 500 }
    );
  }
}

// GET for quick status check
export async function GET(request: NextRequest) {
  return NextResponse.json({
    endpoint: '/api/test/quilt-index',
    method: 'POST',
    usage: 'POST with JSON body: { quiltId: string, walletAddress: string }',
    description: 'Index Quilt memories into local HNSW index for vector search',
  });
}
