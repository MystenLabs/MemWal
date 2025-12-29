/**
 * Test endpoint for SDK's QuiltBatchManager
 *
 * Tests the partial recovery logic for truncated JSON in Quilts
 *
 * Usage:
 * # Get all memory packages using SDK
 * curl -X GET "http://localhost:3000/api/test/quilt-sdk?quiltId=YOUR_QUILT_ID"
 *
 * # Get specific memory by identifier
 * curl -X GET "http://localhost:3000/api/test/quilt-sdk?quiltId=YOUR_QUILT_ID&identifier=memory-123.json"
 */
import { NextRequest, NextResponse } from 'next/server';
import { QuiltBatchManager } from '@cmdoss/memwal-sdk/services';
import { WalrusClient } from '@mysten/walrus';
import { getFullnodeUrl, SuiClient } from '@mysten/sui/client';
import { walrus } from '@mysten/walrus';

// Force dynamic rendering
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const SUI_NETWORK = (process.env.SUI_NETWORK as 'testnet' | 'mainnet') || 'testnet';
const WALRUS_AGGREGATOR = process.env.WALRUS_AGGREGATOR || 'https://aggregator.walrus-testnet.walrus.space';
const WALRUS_PUBLISHER = process.env.WALRUS_PUBLISHER || 'https://publisher.walrus-testnet.walrus.space';

export async function GET(request: NextRequest) {
  const quiltId = request.nextUrl.searchParams.get('quiltId');
  const identifier = request.nextUrl.searchParams.get('identifier');

  if (!quiltId) {
    return NextResponse.json(
      { error: 'quiltId query param is required' },
      { status: 400 }
    );
  }

  try {
    console.log(`[TEST] quilt-sdk - quiltId: ${quiltId}, identifier: ${identifier || 'all'}`);

    // Create Walrus clients
    const walrusWithRelay = new WalrusClient({
      network: SUI_NETWORK,
      aggregatorUrl: WALRUS_AGGREGATOR,
      publisherUrl: WALRUS_PUBLISHER,
    });

    const walrusWithoutRelay = new WalrusClient({
      network: SUI_NETWORK,
      aggregatorUrl: WALRUS_AGGREGATOR,
    });

    // Create Sui client with Walrus extension
    const suiClient = new SuiClient({ url: getFullnodeUrl(SUI_NETWORK) })
      .$extend(walrus({ network: SUI_NETWORK, aggregatorUrl: WALRUS_AGGREGATOR }));

    // Create QuiltBatchManager
    const quiltManager = new QuiltBatchManager(
      walrusWithRelay,
      walrusWithoutRelay,
      suiClient as any,
      true, // useUploadRelay
      3     // epochs
    );

    const startTime = performance.now();

    if (identifier) {
      // Get specific memory package
      const result = await quiltManager.getMemoryPackage(quiltId, identifier);
      const timeMs = performance.now() - startTime;

      return NextResponse.json({
        success: true,
        method: 'getMemoryPackage',
        quiltId,
        identifier,
        timeMs: timeMs.toFixed(1),
        result: {
          identifier: result.identifier,
          tags: result.tags,
          memoryPackage: {
            content: result.memoryPackage.content?.slice(0, 200) || '',
            embedding: `[${result.memoryPackage.embedding?.length || 0} dimensions]`,
            metadata: result.memoryPackage.metadata,
            timestamp: result.memoryPackage.timestamp,
            version: result.memoryPackage.version,
            encrypted: result.memoryPackage.encrypted,
            encryptedContent: result.memoryPackage.encryptedContent?.slice(0, 100) || null,
          },
          retrievalTimeMs: result.retrievalTimeMs,
        },
      });
    } else {
      // Get all memory packages
      const results = await quiltManager.getAllMemoryPackages(quiltId);
      const timeMs = performance.now() - startTime;

      const formattedResults = results.map(r => ({
        identifier: r.identifier,
        tags: r.tags,
        memoryPackage: {
          content: r.memoryPackage.content?.slice(0, 200) || '',
          embedding: `[${r.memoryPackage.embedding?.length || 0} dimensions]`,
          metadata: r.memoryPackage.metadata,
          timestamp: r.memoryPackage.timestamp,
          version: r.memoryPackage.version,
          encrypted: r.memoryPackage.encrypted,
          encryptedContentPreview: r.memoryPackage.encryptedContent?.slice(0, 100) || null,
          isCorrupted: r.memoryPackage.encryptedContent?.includes('CORRUPTED') || false,
        },
      }));

      return NextResponse.json({
        success: true,
        method: 'getAllMemoryPackages',
        quiltId,
        count: results.length,
        timeMs: timeMs.toFixed(1),
        results: formattedResults,
      });
    }
  } catch (error) {
    console.error('[TEST] quilt-sdk error:', error);
    return NextResponse.json(
      {
        success: false,
        error: error instanceof Error ? error.message : String(error),
      },
      { status: 500 }
    );
  }
}
