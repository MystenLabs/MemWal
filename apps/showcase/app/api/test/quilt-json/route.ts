/**
 * Test endpoint for QuiltBatchManager JSON package operations
 *
 * Usage:
 * # Get all memory packages from a Quilt as JSON
 * curl -X GET "http://localhost:3000/api/test/quilt-json?quiltId=YOUR_QUILT_ID"
 *
 * # Get specific file by identifier
 * curl -X GET "http://localhost:3000/api/test/quilt-json?quiltId=YOUR_QUILT_ID&identifier=memory-123.json"
 *
 * # List all files in Quilt with tags
 * curl -X GET "http://localhost:3000/api/test/quilt-json?quiltId=YOUR_QUILT_ID&method=list"
 */
import { NextRequest, NextResponse } from 'next/server';
import { getFullnodeUrl, SuiClient } from '@mysten/sui/client';
import { walrus } from '@mysten/walrus';

// Force dynamic rendering
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const SUI_NETWORK = (process.env.SUI_NETWORK as 'testnet' | 'mainnet') || 'testnet';
const WALRUS_AGGREGATOR = process.env.WALRUS_AGGREGATOR || 'https://aggregator.walrus-testnet.walrus.space';

export async function GET(request: NextRequest) {
  const quiltId = request.nextUrl.searchParams.get('quiltId');
  const identifier = request.nextUrl.searchParams.get('identifier');
  const method = request.nextUrl.searchParams.get('method') || 'getAll';

  if (!quiltId) {
    return NextResponse.json(
      { error: 'quiltId query param is required' },
      { status: 400 }
    );
  }

  try {
    console.log(`[TEST] quilt-json - quiltId: ${quiltId}, method: ${method}`);

    // Create Sui client with Walrus extension
    const client = new SuiClient({ url: getFullnodeUrl(SUI_NETWORK) })
      .$extend(walrus({ network: SUI_NETWORK, aggregatorUrl: WALRUS_AGGREGATOR }));

    const startTime = performance.now();

    switch (method) {
      case 'list': {
        // List all files with their tags (no content parsing)
        const blob = await client.walrus.getBlob({ blobId: quiltId });
        const files = await blob.files();

        const fileList = await Promise.all(
          files.map(async (file) => {
            const fileIdentifier = await file.getIdentifier();
            const tags = await file.getTags();
            return {
              identifier: fileIdentifier,
              tags,
            };
          })
        );

        const timeMs = performance.now() - startTime;

        return NextResponse.json({
          success: true,
          method: 'list',
          quiltId,
          count: fileList.length,
          timeMs: timeMs.toFixed(1),
          files: fileList,
        });
      }

      case 'getOne': {
        // Get specific file by identifier
        if (!identifier) {
          return NextResponse.json(
            { error: 'identifier query param is required for getOne method' },
            { status: 400 }
          );
        }

        const blob = await client.walrus.getBlob({ blobId: quiltId });
        const files = await blob.files();

        // Find by identifier
        let matchingFile = null;
        for (const file of files) {
          const fileIdentifier = await file.getIdentifier();
          if (fileIdentifier === identifier) {
            matchingFile = file;
            break;
          }
        }

        if (!matchingFile) {
          return NextResponse.json(
            { error: `File "${identifier}" not found in Quilt` },
            { status: 404 }
          );
        }

        // Parse as JSON using SDK's json() method
        const memoryPackage = await matchingFile.json();
        const tags = await matchingFile.getTags();
        const timeMs = performance.now() - startTime;

        return NextResponse.json({
          success: true,
          method: 'getOne',
          quiltId,
          identifier,
          timeMs: timeMs.toFixed(1),
          tags,
          memoryPackage,
        });
      }

      case 'getAll':
      default: {
        // Get all files and parse as JSON
        const blob = await client.walrus.getBlob({ blobId: quiltId });
        const files = await blob.files();

        const results = await Promise.all(
          files.map(async (file) => {
            const fileIdentifier = await file.getIdentifier();
            const tags = await file.getTags();

            try {
              // Parse as JSON using SDK's json() method
              const memoryPackage = await file.json();
              return {
                identifier: fileIdentifier,
                tags,
                memoryPackage,
                parseSuccess: true,
              };
            } catch (parseError: any) {
              // Try workaround: trim trailing null bytes and parse manually
              const bytes = await file.bytes();
              const rawString = new TextDecoder().decode(bytes);

              // Find last non-null character
              let lastValidIndex = rawString.length - 1;
              while (lastValidIndex >= 0 && rawString.charCodeAt(lastValidIndex) === 0) {
                lastValidIndex--;
              }

              const nullsRemoved = rawString.length - lastValidIndex - 1;
              let trimParseErrorMsg = '';

              if (lastValidIndex < rawString.length - 1) {
                // There were trailing nulls, try parsing trimmed string
                const trimmedString = rawString.slice(0, lastValidIndex + 1);
                try {
                  const memoryPackage = JSON.parse(trimmedString);
                  return {
                    identifier: fileIdentifier,
                    tags,
                    memoryPackage,
                    parseSuccess: true,
                    note: `Trimmed ${nullsRemoved} trailing null bytes`,
                  };
                } catch (trimErr: any) {
                  trimParseErrorMsg = String(trimErr);

                  // Try to extract partial data by finding the truncation point
                  // Look for the last complete JSON field
                  const encryptedIdx = trimmedString.indexOf('"encryptedContent":"');
                  if (encryptedIdx > 0) {
                    // Try to parse everything before encryptedContent
                    const beforeEncrypted = trimmedString.slice(0, encryptedIdx);
                    // Close the object properly: remove trailing comma and close
                    const cleanedJson = beforeEncrypted.replace(/,\s*$/, '') + '}';
                    try {
                      const partialPackage = JSON.parse(cleanedJson);
                      return {
                        identifier: fileIdentifier,
                        tags,
                        memoryPackage: {
                          ...partialPackage,
                          encrypted: true,
                          encryptedContent: '[TRUNCATED - data corruption]',
                        },
                        parseSuccess: true,
                        note: `Partial recovery - encryptedContent was truncated (removed ${nullsRemoved} null bytes)`,
                        warning: 'Encrypted content is corrupted and cannot be decrypted',
                      };
                    } catch {
                      // Partial extraction also failed
                    }
                  }
                }
              }

              // If not JSON, return raw info with diagnostic
              // Find control characters in trimmed string (or original if no trimming)
              const checkString = lastValidIndex < rawString.length - 1
                ? rawString.slice(0, lastValidIndex + 1)
                : rawString;

              const controlChars: { pos: number; char: string; code: number }[] = [];
              for (let i = 0; i < checkString.length; i++) {
                const code = checkString.charCodeAt(i);
                // Control characters: 0x00-0x1F (except \t\n\r) and 0x7F
                if ((code < 0x20 && code !== 0x09 && code !== 0x0A && code !== 0x0D) || code === 0x7F) {
                  controlChars.push({ pos: i, char: checkString[i], code });
                  if (controlChars.length >= 10) break; // Limit to first 10
                }
              }

              // Show context around error position if we found control chars
              const errorContext = controlChars.length > 0
                ? checkString.slice(Math.max(0, controlChars[0].pos - 50), Math.min(checkString.length, controlChars[0].pos + 50))
                : '';

              // Show end of trimmed string
              const trimmedEnd = checkString.slice(-100);

              return {
                identifier: fileIdentifier,
                tags,
                parseSuccess: false,
                parseError: String(parseError),
                trimParseError: trimParseErrorMsg || null,
                rawSize: bytes.length,
                trimmedSize: checkString.length,
                nullsRemoved,
                rawPreview: rawString.slice(0, 200),
                trimmedEnd,
                controlCharsFound: controlChars.length,
                controlChars: controlChars.slice(0, 5),
                errorContext,
              };
            }
          })
        );

        const timeMs = performance.now() - startTime;

        return NextResponse.json({
          success: true,
          method: 'getAll',
          quiltId,
          count: results.length,
          timeMs: timeMs.toFixed(1),
          files: results,
        });
      }
    }
  } catch (error) {
    console.error('[TEST] quilt-json error:', error);
    return NextResponse.json(
      {
        success: false,
        error: error instanceof Error ? error.message : String(error),
      },
      { status: 500 }
    );
  }
}
