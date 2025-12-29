/**
 * Test endpoint for pdw.graph namespace
 *
 * Usage:
 * curl -X GET "http://localhost:3000/api/test/graph?walletAddress=YOUR_WALLET&method=stats"
 * curl -X GET "http://localhost:3000/api/test/graph?walletAddress=YOUR_WALLET&method=getEntities"
 * curl -X GET "http://localhost:3000/api/test/graph?walletAddress=YOUR_WALLET&method=query&entityId=ENTITY_ID"
 * curl -X POST "http://localhost:3000/api/test/graph" -H "Content-Type: application/json" \
 *   -d '{"method": "extract", "content": "John works at Google in Mountain View"}'
 */
import { NextRequest, NextResponse } from 'next/server';
import { getReadOnlyPDWClient } from '@/lib/pdw-read-only';

// Force dynamic rendering
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const DUMMY_WALLET = '0x0000000000000000000000000000000000000000000000000000000000000000';

export async function GET(request: NextRequest) {
  const walletAddress = request.nextUrl.searchParams.get('walletAddress');
  const method = request.nextUrl.searchParams.get('method') || 'stats';
  const entityId = request.nextUrl.searchParams.get('entityId');
  const type = request.nextUrl.searchParams.get('type');

  try {
    console.log(`[TEST] graph.${method}() - wallet: ${walletAddress || 'dummy'}`);

    const pdw = await getReadOnlyPDWClient(walletAddress || DUMMY_WALLET);

    let result: any;

    switch (method) {
      case 'query':
        if (!entityId) {
          return NextResponse.json(
            { error: 'entityId query param is required for query method' },
            { status: 400 }
          );
        }
        result = await pdw.graph.query(entityId);
        break;

      case 'getEntities':
        result = await pdw.graph.getEntities({
          type: type || undefined,
          limit: 50,
        });
        break;

      case 'stats':
      default:
        result = await pdw.graph.stats();
        break;
    }

    console.log(`[TEST] graph.${method}() result:`, JSON.stringify(result, null, 2).substring(0, 500));

    return NextResponse.json({
      success: true,
      method,
      walletAddress: walletAddress || DUMMY_WALLET,
      result,
    });
  } catch (error) {
    console.error(`[TEST] graph.${method}() error:`, error);
    return NextResponse.json(
      {
        success: false,
        method,
        error: error instanceof Error ? error.message : String(error),
      },
      { status: 500 }
    );
  }
}

// POST for extract method
export async function POST(request: NextRequest) {
  try {
    const { method, content, walletAddress } = await request.json();

    if (method !== 'extract') {
      return NextResponse.json(
        { error: 'POST only supports extract method. Use GET for other methods.' },
        { status: 400 }
      );
    }

    if (!content) {
      return NextResponse.json(
        { error: 'content is required for extract method' },
        { status: 400 }
      );
    }

    console.log(`[TEST] graph.extract() - content: ${content.substring(0, 100)}...`);

    const pdw = await getReadOnlyPDWClient(walletAddress || DUMMY_WALLET);
    const result = await pdw.graph.extract(content);

    console.log(`[TEST] graph.extract() result: ${result.entities?.length || 0} entities, ${result.relationships?.length || 0} relationships`);

    return NextResponse.json({
      success: true,
      method: 'extract',
      result,
    });
  } catch (error) {
    console.error('[TEST] graph.extract() error:', error);
    return NextResponse.json(
      {
        success: false,
        method: 'extract',
        error: error instanceof Error ? error.message : String(error),
      },
      { status: 500 }
    );
  }
}
