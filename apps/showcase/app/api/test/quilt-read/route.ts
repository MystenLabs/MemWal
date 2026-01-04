/**
 * Test endpoint to read files from a Walrus Quilt using SDK
 *
 * Usage:
 * curl -X GET "http://localhost:3000/api/test/quilt-read?quiltId=YOUR_QUILT_ID"
 *
 * This endpoint properly parses Quilt format using Walrus SDK:
 * - Uses SuiClient.$extend(walrus()) to get Walrus capabilities
 * - Calls getBlob({ blobId }).files() to extract all files
 * - Returns file identifiers, tags, and content
 */
import { NextRequest, NextResponse } from 'next/server';
import { SuiClient, getFullnodeUrl } from '@mysten/sui/client';
import { walrus } from '@mysten/walrus';

// Force dynamic rendering
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const WALRUS_AGGREGATOR = process.env.WALRUS_AGGREGATOR || 'https://aggregator.walrus-testnet.walrus.space';
const SUI_NETWORK = (process.env.SUI_NETWORK as 'testnet' | 'mainnet') || 'testnet';

export async function GET(request: NextRequest) {
  const quiltId = request.nextUrl.searchParams.get('quiltId') || request.nextUrl.searchParams.get('blobId');
  const fileIndex = request.nextUrl.searchParams.get('index');
  const identifier = request.nextUrl.searchParams.get('identifier');

  if (!quiltId) {
    return NextResponse.json(
      { error: 'quiltId or blobId query param is required' },
      { status: 400 }
    );
  }

  try {
    console.log(`[QUILT-READ] Reading Quilt - quiltId: ${quiltId}`);

    // Create SuiClient with Walrus extension
    const client = new SuiClient({
      url: getFullnodeUrl(SUI_NETWORK),
    }).$extend(
      walrus({
        network: SUI_NETWORK,
        aggregatorUrl: WALRUS_AGGREGATOR,
      })
    );

    // Get files from Walrus using getFiles (works for both Quilts and regular blobs)
    console.log(`[QUILT-READ] Getting files from Walrus...`);
    let files;
    try {
      // Try getFiles first (works for Quilts)
      files = await client.walrus.getFiles({ ids: [quiltId] });
      console.log(`[QUILT-READ] getFiles returned ${files.length} files`);
    } catch (getFilesError) {
      console.log(`[QUILT-READ] getFiles failed, trying getBlob().files()...`);
      // Fallback to getBlob().files() for other formats
      const blob = await client.walrus.getBlob({ blobId: quiltId });
      files = await blob.files();
    }

    console.log(`[QUILT-READ] Found ${files.length} files in Quilt`);

    // If specific file requested by index or identifier
    if (fileIndex !== null || identifier) {
      let targetFile = null;

      if (fileIndex !== null) {
        const idx = parseInt(fileIndex);
        if (idx >= 0 && idx < files.length) {
          targetFile = files[idx];
        }
      } else if (identifier) {
        for (const f of files) {
          const fId = await f.getIdentifier();
          if (fId === identifier) {
            targetFile = f;
            break;
          }
        }
      }

      if (!targetFile) {
        return NextResponse.json(
          { error: `File not found in Quilt` },
          { status: 404 }
        );
      }

      const content = await targetFile.bytes();
      const fileIdentifier = await targetFile.getIdentifier();
      const tags = await targetFile.getTags();

      // Try to parse as JSON (memory package format)
      let parsed = null;
      try {
        const text = new TextDecoder().decode(content);
        parsed = JSON.parse(text);
      } catch {
        // Not JSON
      }

      return NextResponse.json({
        success: true,
        quiltId,
        file: {
          identifier: fileIdentifier,
          tags,
          size: content.length,
          isJson: parsed !== null,
          content: parsed || {
            preview: new TextDecoder().decode(content.slice(0, 500)),
            truncated: content.length > 500,
          },
        },
      });
    }

    // Return all files info
    const filesInfo = await Promise.all(
      files.map(async (file, index) => {
        const fileIdentifier = await file.getIdentifier();
        const tags = await file.getTags();
        const content = await file.bytes();

        // Try to parse as JSON (memory package format)
        let parsed = null;
        let contentPreview = '';
        try {
          const text = new TextDecoder().decode(content);
          parsed = JSON.parse(text);
          // For memory package, show content field
          if (parsed.content) {
            contentPreview = parsed.content.substring(0, 200);
          }
        } catch {
          contentPreview = new TextDecoder().decode(content.slice(0, 200));
        }

        return {
          index,
          identifier: fileIdentifier,
          tags,
          size: content.length,
          isJson: parsed !== null,
          isMemoryPackage: parsed?.version && parsed?.content && parsed?.embedding,
          contentPreview: contentPreview + (contentPreview.length >= 200 ? '...' : ''),
          // Include full memory data if it's a memory package
          memory: parsed?.version && parsed?.content ? {
            content: parsed.content,
            category: parsed.metadata?.category,
            importance: parsed.metadata?.importance,
            topic: parsed.metadata?.topic,
            embeddingDimensions: parsed.embedding?.length,
            timestamp: parsed.timestamp,
          } : null,
        };
      })
    );

    return NextResponse.json({
      success: true,
      quiltId,
      totalFiles: files.length,
      files: filesInfo,
    });

  } catch (error) {
    console.error('[QUILT-READ] Error:', error);
    return NextResponse.json(
      {
        success: false,
        error: error instanceof Error ? error.message : String(error),
        hint: 'Make sure the blobId is a valid Quilt. Single memory blobs should use /api/test/memory-get instead.',
      },
      { status: 500 }
    );
  }
}
