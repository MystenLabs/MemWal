/**
 * Test endpoint for pdw.encryption namespace
 *
 * Usage:
 * curl -X POST "http://localhost:3000/api/test/encryption" \
 *   -H "Content-Type: application/json" \
 *   -d '{"action": "encrypt", "data": "Hello World", "walletAddress": "YOUR_WALLET"}'
 *
 * Note: SEAL encryption requires:
 * - enableEncryption: true in config
 * - ACCESS_REGISTRY_ID environment variable
 * - Connection to SEAL Key Servers
 */
import { NextRequest, NextResponse } from 'next/server';
import { getReadOnlyPDWClient } from '@/lib/pdw-read-only';

// Force dynamic rendering
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const DUMMY_WALLET = '0x0000000000000000000000000000000000000000000000000000000000000000';

export async function POST(request: NextRequest) {
  try {
    const { action, data, walletAddress } = await request.json();

    if (!action) {
      return NextResponse.json(
        { error: 'action is required (encrypt, decrypt, status)' },
        { status: 400 }
      );
    }

    const pdw = await getReadOnlyPDWClient(walletAddress || DUMMY_WALLET);

    switch (action) {
      case 'status':
        // Check if encryption is available
        const hasEncryption = !!pdw.encryption;
        return NextResponse.json({
          success: true,
          action: 'status',
          encryptionAvailable: hasEncryption,
          note: hasEncryption
            ? 'Encryption service is available'
            : 'Encryption service not configured. Set enableEncryption: true and provide ACCESS_REGISTRY_ID',
        });

      case 'encrypt':
        if (!data) {
          return NextResponse.json(
            { error: 'data is required for encryption' },
            { status: 400 }
          );
        }

        try {
          const dataBytes = new TextEncoder().encode(data);
          const result = await pdw.encryption.encrypt(dataBytes, 2);

          return NextResponse.json({
            success: true,
            action: 'encrypt',
            originalLength: dataBytes.length,
            encryptedLength: result.encryptedData.length,
            hasBackupKey: !!result.backupKey,
          });
        } catch (encryptError: any) {
          return NextResponse.json({
            success: false,
            action: 'encrypt',
            error: encryptError.message,
            hint: 'SEAL encryption requires enableEncryption: true and ACCESS_REGISTRY_ID',
          }, { status: 400 });
        }

      case 'decrypt':
        // SEAL decryption requires wallet signing for session key
        // This is by design - only the wallet owner can decrypt their data
        return NextResponse.json({
          success: false,
          action: 'decrypt',
          error: 'SEAL decryption requires wallet signing (cannot be done server-side)',
          explanation: {
            reason: 'SEAL uses identity-based encryption. Only the wallet owner can decrypt.',
            requirements: [
              '1. Session key created with wallet signature (signPersonalMessage)',
              '2. seal_approve transaction bytes for access control',
              '3. Encrypted data (Uint8Array from encrypt result)'
            ],
            frontendFlow: [
              '1. Call pdw.encryption.createSessionKey({ signPersonalMessageFn: signPersonalMessage })',
              '2. Pass sessionKey to pdw.encryption.decrypt({ encryptedData, sessionKey })',
              '3. SDK handles seal_approve transaction internally'
            ],
            note: 'Use the roundtrip action to test encrypt → store → retrieve cycle'
          }
        }, { status: 400 });

      case 'roundtrip':
        // Test full encrypt cycle - returns encrypted data that can be stored
        if (!data) {
          return NextResponse.json(
            { error: 'data is required for roundtrip test' },
            { status: 400 }
          );
        }

        try {
          const inputBytes = new TextEncoder().encode(data);
          const encryptResult = await pdw.encryption.encrypt(inputBytes, 2);

          // Convert to base64 for transport
          const encryptedBase64 = Buffer.from(encryptResult.encryptedData).toString('base64');
          const backupKeyBase64 = Buffer.from(encryptResult.backupKey).toString('base64');

          return NextResponse.json({
            success: true,
            action: 'roundtrip',
            input: {
              text: data,
              bytes: inputBytes.length
            },
            encrypted: {
              dataBase64: encryptedBase64,
              dataBytes: encryptResult.encryptedData.length,
              backupKeyBase64: backupKeyBase64,
              backupKeyBytes: encryptResult.backupKey.length,
            },
            decryptionInfo: {
              canDecryptServerSide: false,
              reason: 'SEAL decryption requires wallet signature for session key',
              frontendRequired: true,
              steps: [
                '1. Store encryptedBase64 with memory',
                '2. On frontend: useSignPersonalMessage() from @mysten/dapp-kit',
                '3. Call pdw.encryption.decrypt({ encryptedData: base64ToUint8Array(encryptedBase64) })'
              ]
            }
          });
        } catch (roundtripError: any) {
          return NextResponse.json({
            success: false,
            action: 'roundtrip',
            error: roundtripError.message,
          }, { status: 400 });
        }

      default:
        return NextResponse.json(
          { error: `Unknown action: ${action}. Use: encrypt, decrypt, roundtrip, status` },
          { status: 400 }
        );
    }
  } catch (error) {
    console.error('[TEST] encryption error:', error);
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
  // GET returns encryption status
  const walletAddress = request.nextUrl.searchParams.get('walletAddress');

  const fakeRequest = {
    json: async () => ({ action: 'status', walletAddress })
  } as NextRequest;

  return POST(fakeRequest);
}
