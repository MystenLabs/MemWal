/**
 * Test endpoint to query on-chain Memory objects directly
 *
 * Usage:
 * curl -X GET "http://localhost:3000/api/test/memories-onchain?walletAddress=YOUR_WALLET"
 */
import { NextRequest, NextResponse } from 'next/server';
import { SuiClient, getFullnodeUrl } from '@mysten/sui/client';

// Force dynamic rendering
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const SUI_NETWORK = (process.env.SUI_NETWORK as 'testnet' | 'mainnet') || 'testnet';
const PACKAGE_ID = process.env.PACKAGE_ID;

export async function GET(request: NextRequest) {
  const walletAddress = request.nextUrl.searchParams.get('walletAddress');

  if (!walletAddress) {
    return NextResponse.json(
      { error: 'walletAddress query param is required' },
      { status: 400 }
    );
  }

  if (!PACKAGE_ID) {
    return NextResponse.json(
      { error: 'PACKAGE_ID not configured' },
      { status: 500 }
    );
  }

  try {
    console.log(`[MEMORIES-ONCHAIN] Querying memories for: ${walletAddress}`);

    const client = new SuiClient({ url: getFullnodeUrl(SUI_NETWORK) });

    // Query owned objects of type Memory with pagination
    const memoryType = `${PACKAGE_ID}::memory::Memory`;
    console.log(`[MEMORIES-ONCHAIN] Looking for type: ${memoryType}`);

    // Paginate to get ALL memories
    const allObjects: any[] = [];
    let cursor: string | null | undefined = undefined;
    let hasMore = true;
    let pageCount = 0;

    while (hasMore) {
      const response = await client.getOwnedObjects({
        owner: walletAddress,
        filter: {
          StructType: memoryType,
        },
        options: {
          showContent: true,
          showType: true,
        },
        cursor,
        limit: 50,
      });

      allObjects.push(...response.data);
      cursor = response.nextCursor;
      hasMore = response.hasNextPage;
      pageCount++;
    }

    console.log(`[MEMORIES-ONCHAIN] Found ${allObjects.length} memory objects (${pageCount} pages)`);

    // Parse memory objects
    const memories = allObjects.map((obj: any) => {
      const content = obj.data?.content;
      if (content?.dataType === 'moveObject') {
        const fields = content.fields;
        return {
          objectId: obj.data?.objectId,
          blobId: fields?.blob_id,
          category: fields?.category,
          topic: fields?.topic,
          importance: fields?.importance,
          vectorId: fields?.vector_id,
          contentSize: fields?.content_size,
          contentHash: fields?.content_hash,
          embeddingBlobId: fields?.embedding_blob_id,
          createdAt: fields?.created_at,
          updatedAt: fields?.updated_at,
        };
      }
      return null;
    }).filter(Boolean);

    return NextResponse.json({
      success: true,
      walletAddress,
      network: SUI_NETWORK,
      packageId: PACKAGE_ID,
      count: memories.length,
      memories,
    });

  } catch (error) {
    console.error('[MEMORIES-ONCHAIN] Error:', error);
    return NextResponse.json(
      {
        success: false,
        error: error instanceof Error ? error.message : String(error),
      },
      { status: 500 }
    );
  }
}
