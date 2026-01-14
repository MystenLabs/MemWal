/**
 * Test endpoint to decrypt a memory blob from Walrus
 *
 * Usage:
 * curl -X POST "http://localhost:3000/api/test/decrypt-memory" \
 *   -H "Content-Type: application/json" \
 *   -d '{"blobId": "1-Thz2R9mn4-y5HseeHVx6st22r-1b3Sml72vxbRa9s", "walletAddress": "0x..."}'
 *
 * Note: Server-side decryption using read-only client (no wallet signing required)
 */
import { NextRequest, NextResponse } from 'next/server';
import { getReadOnlyPDWClient } from '@/lib/pdw-read-only';

// Force dynamic rendering
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function POST(request: NextRequest) {
  const startTime = Date.now();

  try {
    const { blobId, walletAddress } = await request.json();

    if (!blobId) {
      return NextResponse.json(
        { error: 'blobId is required' },
        { status: 400 }
      );
    }

    if (!walletAddress) {
      return NextResponse.json(
        { error: 'walletAddress is required' },
        { status: 400 }
      );
    }

    console.log(`\n${'='.repeat(70)}`);
    console.log(`🔓 [/api/test/decrypt-memory] TESTING DECRYPTION`);
    console.log(`${'='.repeat(70)}`);
    console.log(`📋 Request Details:`);
    console.log(`   blobId: ${blobId}`);
    console.log(`   walletAddress: ${walletAddress}`);

    // Get PDW client
    console.log(`\n🔧 Step 1: Getting read-only PDW client...`);
    const pdw = await getReadOnlyPDWClient(walletAddress);
    console.log(`   ✅ PDW client ready`);

    // Check encryption service
    if (!pdw.encryption) {
      return NextResponse.json({
        success: false,
        error: 'Encryption service not available',
        hint: 'Check that enableEncryption is true in config'
      }, { status: 500 });
    }

    // Download blob from Walrus
    console.log(`\n🔧 Step 2: Downloading blob from Walrus...`);
    const encryptedBlob = await pdw.storage.download(blobId);
    console.log(`   ✅ Blob downloaded: ${encryptedBlob.length} bytes`);

    // Check if it looks encrypted (binary data, not JSON)
    const isLikelyEncrypted = encryptedBlob[0] < 32 || encryptedBlob[0] > 126;
    console.log(`   🔍 Likely encrypted: ${isLikelyEncrypted}`);

    if (!isLikelyEncrypted) {
      // Try to parse as JSON
      try {
        const jsonStr = new TextDecoder().decode(encryptedBlob);
        const parsed = JSON.parse(jsonStr);
        return NextResponse.json({
          success: false,
          encrypted: false,
          message: 'Blob contains plaintext JSON (not encrypted)',
          content: parsed
        });
      } catch {
        // Not JSON either
      }
    }

    // Attempt decryption
    console.log(`\n🔧 Step 3: Attempting decryption...`);
    console.log(`   ⚠️ Note: Server-side decryption may fail if wallet signing required`);

    try {
      // Try to decrypt using EncryptionService
      // Note: This will only work if decryption doesn't require wallet signature
      const decrypted = await pdw.encryption.decrypt(
        encryptedBlob,
        walletAddress
      );

      const decryptedText = new TextDecoder().decode(decrypted);

      const duration = Date.now() - startTime;
      console.log(`\n✅ Decryption successful in ${duration}ms`);
      console.log(`   Original size: ${encryptedBlob.length} bytes`);
      console.log(`   Decrypted size: ${decrypted.length} bytes`);
      console.log(`   Content preview: "${decryptedText.slice(0, 100)}..."`);
      console.log(`${'='.repeat(70)}\n`);

      return NextResponse.json({
        success: true,
        encrypted: true,
        decrypted: true,
        blobId,
        sizes: {
          encrypted: encryptedBlob.length,
          decrypted: decrypted.length
        },
        content: decryptedText,
        duration
      });
    } catch (decryptError: any) {
      console.error(`\n❌ Decryption failed:`, decryptError.message);
      console.log(`${'='.repeat(70)}\n`);

      return NextResponse.json({
        success: false,
        encrypted: true,
        decrypted: false,
        blobId,
        error: decryptError.message,
        encryptedSize: encryptedBlob.length,
        note: 'Decryption may require wallet signature (not available server-side)',
        hint: 'Try decryption from browser with user wallet connected'
      }, { status: 400 });
    }
  } catch (error) {
    console.error('❌ Decrypt test error:', error);
    return NextResponse.json(
      {
        success: false,
        error: error instanceof Error ? error.message : String(error),
      },
      { status: 500 }
    );
  }
}

export async function GET(request: NextRequest) {
  const blobId = request.nextUrl.searchParams.get('blobId');
  const walletAddress = request.nextUrl.searchParams.get('walletAddress');

  if (!blobId || !walletAddress) {
    return NextResponse.json(
      { error: 'blobId and walletAddress query params required' },
      { status: 400 }
    );
  }

  const fakeRequest = {
    json: async () => ({ blobId, walletAddress })
  } as NextRequest;

  return POST(fakeRequest);
}
