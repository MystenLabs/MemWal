/**
 * Test endpoint to read files from a Walrus Quilt
 *
 * Usage:
 * curl -X GET "http://localhost:3000/api/test/quilt-files?quiltId=YOUR_QUILT_ID"
 */
import { NextRequest, NextResponse } from 'next/server';

// Force dynamic rendering
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const WALRUS_AGGREGATOR = process.env.WALRUS_AGGREGATOR || 'https://aggregator.walrus-testnet.walrus.space';

export async function GET(request: NextRequest) {
  const blobId = request.nextUrl.searchParams.get('quiltId') || request.nextUrl.searchParams.get('blobId');

  if (!blobId) {
    return NextResponse.json(
      { error: 'quiltId or blobId query param is required' },
      { status: 400 }
    );
  }

  try {
    console.log(`[TEST] Reading blob - blobId: ${blobId}`);

    // Fetch directly from Walrus aggregator
    const url = `${WALRUS_AGGREGATOR}/v1/blobs/${blobId}`;
    console.log(`[TEST] Fetching from: ${url}`);

    const response = await fetch(url);

    if (!response.ok) {
      throw new Error(`Walrus fetch failed: ${response.status} ${response.statusText}`);
    }

    const rawBytes = new Uint8Array(await response.arrayBuffer());
    const textContent = new TextDecoder().decode(rawBytes);

    console.log(`[TEST] Fetched ${rawBytes.length} bytes`);

    // Try to parse as JSON
    let parsed = null;
    let isQuilt = false;

    try {
      parsed = JSON.parse(textContent);

      // Check if it's a memory package format
      if (parsed.version && parsed.content && parsed.embedding) {
        console.log('[TEST] Detected JSON memory package format');
      }
    } catch (e) {
      // Not JSON - might be binary Quilt format
      console.log('[TEST] Not JSON, checking for Quilt header...');

      // Check for Quilt magic bytes (if any)
      const header = textContent.substring(0, 50);
      console.log('[TEST] First 50 chars:', header);
    }

    return NextResponse.json({
      success: true,
      blobId,
      size: rawBytes.length,
      isJson: parsed !== null,
      content: parsed || {
        preview: textContent.substring(0, 1000),
        truncated: textContent.length > 1000,
        totalLength: textContent.length,
      },
    });
  } catch (error) {
    console.error('[TEST] Blob read error:', error);
    return NextResponse.json(
      {
        success: false,
        error: error instanceof Error ? error.message : String(error),
      },
      { status: 500 }
    );
  }
}
