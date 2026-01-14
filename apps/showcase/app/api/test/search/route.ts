/**
 * Test endpoint for pdw.search namespace
 *
 * Usage:
 * # Vector search (semantic)
 * curl -X GET "http://localhost:3000/api/test/search?walletAddress=YOUR_WALLET&method=vector&query=programming"
 *
 * # Filter by category
 * curl -X GET "http://localhost:3000/api/test/search?walletAddress=YOUR_WALLET&method=byCategory&category=fact"
 *
 * # Filter by importance
 * curl -X GET "http://localhost:3000/api/test/search?walletAddress=YOUR_WALLET&method=byImportance&min=7&max=10"
 *
 * # Advanced search (combined filters)
 * curl -X POST "http://localhost:3000/api/test/search" -H "Content-Type: application/json" \
 *   -d '{"method": "advanced", "walletAddress": "YOUR_WALLET", "text": "programming", "category": "fact", "importance": {"min": 5, "max": 10}}'
 */
import { NextRequest, NextResponse } from 'next/server';
import { getReadOnlyPDWClient } from '@/lib/pdw-read-only';

// Force dynamic rendering
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const DUMMY_WALLET = '0x0000000000000000000000000000000000000000000000000000000000000000';

export async function GET(request: NextRequest) {
  const walletAddress = request.nextUrl.searchParams.get('walletAddress');
  const method = request.nextUrl.searchParams.get('method') || 'vector';
  const query = request.nextUrl.searchParams.get('query') || '';
  const category = request.nextUrl.searchParams.get('category');
  const minImportance = request.nextUrl.searchParams.get('min');
  const maxImportance = request.nextUrl.searchParams.get('max');
  const limit = parseInt(request.nextUrl.searchParams.get('limit') || '10');
  const fetchContent = request.nextUrl.searchParams.get('fetchContent') === 'true';

  try {
    console.log(`[TEST] search.${method}() - wallet: ${walletAddress || 'dummy'}`);

    const pdw = await getReadOnlyPDWClient(walletAddress || DUMMY_WALLET);

    let result: any;

    switch (method) {
      case 'vector':
        if (!query) {
          return NextResponse.json(
            { error: 'query param is required for vector search' },
            { status: 400 }
          );
        }
        result = await pdw.search.vector(query, {
          limit,
          category: category || undefined,
          fetchContent
        });
        break;

      case 'byCategory':
        if (!category) {
          return NextResponse.json(
            { error: 'category param is required for byCategory search' },
            { status: 400 }
          );
        }
        result = await pdw.search.byCategory(category, { limit });
        break;

      case 'byImportance':
        const min = parseInt(minImportance || '1');
        const max = parseInt(maxImportance || '10');
        result = await pdw.search.byImportance(min, max, { limit });
        break;

      case 'keyword':
        if (!query) {
          return NextResponse.json(
            { error: 'query param is required for keyword search' },
            { status: 400 }
          );
        }
        result = await pdw.search.keyword(query, {
          limit,
          category: category || undefined
        });
        break;

      case 'semantic':
        if (!query) {
          return NextResponse.json(
            { error: 'query param is required for semantic search' },
            { status: 400 }
          );
        }
        result = await pdw.search.semantic(query, { limit });
        break;

      case 'list':
        // Simple list from memory namespace
        result = await pdw.memory.list({
          category: category || undefined,
          limit
        });
        break;

      default:
        return NextResponse.json(
          { error: `Unknown method: ${method}. Use: vector, byCategory, byImportance, keyword, semantic, list` },
          { status: 400 }
        );
    }

    console.log(`[TEST] search.${method}() found ${result?.length || 0} results`);

    // Format results for display
    const formattedResults = (result || []).map((r: any) => ({
      id: r.id,
      content: r.content ? r.content.substring(0, 200) + (r.content.length > 200 ? '...' : '') : '[no content - use fetchContent=true or pdw.memory.get(blobId)]',
      category: r.category,
      importance: r.importance,
      score: r.score || r.similarity,
      blobId: r.blobId,
      encrypted: r.encrypted || r.metadata?.isEncrypted,
      timestamp: r.timestamp || r.createdAt,
    }));

    return NextResponse.json({
      success: true,
      method,
      params: { query, category, minImportance, maxImportance, limit, fetchContent },
      walletAddress: walletAddress || DUMMY_WALLET,
      count: formattedResults.length,
      results: formattedResults,
    });
  } catch (error) {
    console.error(`[TEST] search.${method}() error:`, error);
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

// POST for advanced search with combined filters
export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const {
      method = 'advanced',
      walletAddress,
      text,
      query,  // Accept both "text" and "query" for consistency
      category,
      importance,
      dateRange,
      limit = 10
    } = body;

    // SDK handles both field names - prefer "text" but fallback to "query"
    const searchText = text || query;

    console.log(`[TEST] search.${method}() - wallet: ${walletAddress || 'dummy'}`);

    const pdw = await getReadOnlyPDWClient(walletAddress || DUMMY_WALLET);

    let result: any;

    if (method === 'advanced') {
      result = await pdw.search.advanced({
        text: searchText,  // Use normalized field (accepts both "text" and "query")
        category,
        importance,
        dateRange: dateRange ? {
          start: new Date(dateRange.start),
          end: dateRange.end ? new Date(dateRange.end) : undefined
        } : undefined,
        limit
      });
    } else if (method === 'byDate') {
      if (!dateRange) {
        return NextResponse.json(
          { error: 'dateRange is required for byDate search' },
          { status: 400 }
        );
      }
      result = await pdw.search.byDate({
        start: new Date(dateRange.start),
        end: dateRange.end ? new Date(dateRange.end) : undefined
      }, { limit, category });
    } else {
      return NextResponse.json(
        { error: `POST only supports advanced and byDate methods` },
        { status: 400 }
      );
    }

    console.log(`[TEST] search.${method}() found ${result?.length || 0} results`);

    // Format results
    const formattedResults = (result || []).map((r: any) => ({
      id: r.id,
      content: r.content ? r.content.substring(0, 200) + (r.content.length > 200 ? '...' : '') : '[no content]',
      category: r.category,
      importance: r.importance,
      score: r.score || r.similarity,
      blobId: r.blobId,
      encrypted: r.encrypted || r.metadata?.isEncrypted,
      timestamp: r.timestamp || r.createdAt,
    }));

    return NextResponse.json({
      success: true,
      method,
      params: { text, category, importance, dateRange, limit },
      walletAddress: walletAddress || DUMMY_WALLET,
      count: formattedResults.length,
      results: formattedResults,
    });
  } catch (error) {
    console.error('[TEST] search error:', error);
    return NextResponse.json(
      {
        success: false,
        error: error instanceof Error ? error.message : String(error),
      },
      { status: 500 }
    );
  }
}
