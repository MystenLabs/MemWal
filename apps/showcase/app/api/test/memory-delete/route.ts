/**
 * Test endpoint for pdw.memory.delete()
 *
 * Usage:
 * curl -X DELETE "http://localhost:3000/api/test/memory-delete?memoryId=YOUR_MEMORY_ID&walletAddress=YOUR_WALLET"
 *
 * Or with POST:
 * curl -X POST http://localhost:3000/api/test/memory-delete \
 *   -H "Content-Type: application/json" \
 *   -d '{"memoryId": "YOUR_MEMORY_ID", "walletAddress": "YOUR_WALLET"}'
 *
 * Note: This requires a wallet with signing capability (not read-only client)
 */
import { NextRequest, NextResponse } from 'next/server';
import { getReadOnlyPDWClient } from '@/lib/pdw-read-only';

// Force dynamic rendering
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function POST(request: NextRequest) {
  try {
    const { memoryId, walletAddress } = await request.json();

    if (!memoryId) {
      return NextResponse.json(
        { error: 'memoryId is required' },
        { status: 400 }
      );
    }

    if (!walletAddress) {
      return NextResponse.json(
        { error: 'walletAddress is required for delete operation' },
        { status: 400 }
      );
    }

    console.log(`[TEST] memory.delete() - memoryId: ${memoryId}`);

    // Note: Delete requires signing capability
    // Read-only client will throw error on sign operations
    const pdw = await getReadOnlyPDWClient(walletAddress);

    try {
      await pdw.memory.delete(memoryId);

      return NextResponse.json({
        success: true,
        message: `Memory ${memoryId} deleted successfully`,
        memoryId
      });
    } catch (deleteError: any) {
      // Check if it's a signing error (expected with read-only client)
      if (deleteError.message?.includes('Read-only') || deleteError.message?.includes('cannot sign')) {
        return NextResponse.json({
          success: false,
          error: 'Delete requires signing capability. Use client-side signing with wallet.',
          hint: 'The read-only client cannot perform delete operations. This endpoint needs to be called from the frontend with actual wallet signing.',
          memoryId
        }, { status: 400 });
      }
      throw deleteError;
    }

  } catch (error) {
    console.error('[TEST] memory.delete() error:', error);
    return NextResponse.json(
      {
        success: false,
        error: error instanceof Error ? error.message : String(error)
      },
      { status: 500 }
    );
  }
}

// Also support DELETE method
export async function DELETE(request: NextRequest) {
  const memoryId = request.nextUrl.searchParams.get('memoryId');
  const walletAddress = request.nextUrl.searchParams.get('walletAddress');

  if (!memoryId) {
    return NextResponse.json(
      { error: 'memoryId query param is required' },
      { status: 400 }
    );
  }

  if (!walletAddress) {
    return NextResponse.json(
      { error: 'walletAddress query param is required for delete operation' },
      { status: 400 }
    );
  }

  // Delegate to POST handler
  const fakeRequest = {
    json: async () => ({ memoryId, walletAddress })
  } as NextRequest;

  return POST(fakeRequest);
}
