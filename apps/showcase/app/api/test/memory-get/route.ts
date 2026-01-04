/**
 * Test endpoint for pdw.memory.get()
 *
 * Usage:
 * curl -X GET "http://localhost:3000/api/test/memory-get?memoryId=YOUR_BLOB_ID"
 *
 * Or with POST:
 * curl -X POST http://localhost:3000/api/test/memory-get \
 *   -H "Content-Type: application/json" \
 *   -d '{"memoryId": "YOUR_BLOB_ID"}'
 */
import { NextRequest, NextResponse } from 'next/server';
import { getReadOnlyPDWClient } from '@/lib/pdw-read-only';

// Force dynamic rendering
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

// Dummy wallet address for read-only operations
const DUMMY_WALLET = '0x0000000000000000000000000000000000000000000000000000000000000000';

export async function POST(request: NextRequest) {
  try {
    const { memoryId, walletAddress } = await request.json();

    if (!memoryId) {
      return NextResponse.json(
        { error: 'memoryId is required' },
        { status: 400 }
      );
    }

    console.log(`[TEST] memory.get() - memoryId: ${memoryId}`);

    const pdw = await getReadOnlyPDWClient(walletAddress || DUMMY_WALLET);
    const memory = await pdw.memory.get(memoryId);

    console.log('[TEST] memory.get() result:', JSON.stringify(memory, null, 2));

    return NextResponse.json({
      success: true,
      memory
    });
  } catch (error) {
    console.error('[TEST] memory.get() error:', error);
    return NextResponse.json(
      {
        success: false,
        error: error instanceof Error ? error.message : String(error)
      },
      { status: 500 }
    );
  }
}

// Also support GET with query param for easy testing
export async function GET(request: NextRequest) {
  const memoryId = request.nextUrl.searchParams.get('memoryId');
  const walletAddress = request.nextUrl.searchParams.get('walletAddress');

  if (!memoryId) {
    return NextResponse.json(
      { error: 'memoryId query param is required' },
      { status: 400 }
    );
  }

  try {
    console.log(`[TEST] memory.get() - memoryId: ${memoryId}`);

    const pdw = await getReadOnlyPDWClient(walletAddress || DUMMY_WALLET);
    const memory = await pdw.memory.get(memoryId);

    console.log('[TEST] memory.get() result:', JSON.stringify(memory, null, 2));

    return NextResponse.json({
      success: true,
      memory
    });
  } catch (error) {
    console.error('[TEST] memory.get() error:', error);
    return NextResponse.json(
      {
        success: false,
        error: error instanceof Error ? error.message : String(error)
      },
      { status: 500 }
    );
  }
}
