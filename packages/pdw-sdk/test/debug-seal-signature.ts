/**
 * Debug SEAL signature format issue
 * Investigate exact signature format requirements
 */

import { config } from 'dotenv';
import { SuiClient, getFullnodeUrl } from '@mysten/sui/client';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { decodeSuiPrivateKey } from '@mysten/sui/cryptography';
import { toHex, fromHex } from '@mysten/sui/utils';
import { SessionKey } from '@mysten/seal';

// Load environment variables
config({ path: '.env.test' });

async function debugSealSignature() {
  console.log('🔍 Debug SEAL Signature Format Requirements');
  console.log('==========================================\n');

  // Configuration
  const packageId = process.env.SUI_PACKAGE_ID || '0xe17807a2cfdb60c506ecdb6c24fe407384d9287fc5d7ae677872ba1b7f8d8623';
  const privateKey = process.env.TEST_PRIVATE_KEY || 'suiprivkey1qp0f8lavfvndyru7e2v4rrtevlnmzemsppudkgc6s8grz9v7y4p4sp905g6';

  try {
    // Initialize Sui client and keypair
    const suiClient = new SuiClient({
      url: getFullnodeUrl('testnet'),
    });

    const { secretKey } = decodeSuiPrivateKey(privateKey);
    const keypair = Ed25519Keypair.fromSecretKey(secretKey);
    const userAddress = keypair.toSuiAddress();

    console.log('📋 Setup:');
    console.log(`   User Address: ${userAddress}`);
    console.log(`   Package ID: ${packageId}`);
    console.log('');

    // Step 1: Create session key
    console.log('🔄 Step 1: Create SEAL Session Key');
    console.log('----------------------------------');

    const sessionKey = await SessionKey.create({
      address: userAddress,
      packageId: packageId,
      ttlMin: 30,
      suiClient
    });

    const personalMessage = sessionKey.getPersonalMessage();
    console.log('✅ Session key created');
    console.log(`   Personal message type: ${typeof personalMessage}`);
    console.log(`   Personal message length: ${personalMessage.length}`);
    console.log(`   Personal message (first 100 chars): ${personalMessage.toString().substring(0, 100)}...`);
    console.log('');

    // Step 2: Sign message with Ed25519Keypair
    console.log('🔄 Step 2: Sign Message with Ed25519Keypair');
    console.log('---------------------------------------------');

    const messageString = typeof personalMessage === 'string' 
      ? personalMessage 
      : new TextDecoder().decode(personalMessage);

    const messageSignature = await keypair.signPersonalMessage(new TextEncoder().encode(messageString));
    
    console.log('✅ Ed25519Keypair signature created');
    console.log(`   Signature type: ${typeof messageSignature.signature}`);
    console.log(`   Signature length: ${messageSignature.signature.length}`);
    console.log(`   Signature (raw): ${messageSignature.signature}`);
    console.log(`   Signature starts with 0x: ${messageSignature.signature.startsWith('0x')}`);
    console.log(`   Bytes type: ${typeof messageSignature.bytes}`);
    console.log(`   Bytes length: ${messageSignature.bytes.length}`);
    console.log(`   Bytes (raw): ${messageSignature.bytes}`);
    console.log('');

    // Step 3: Convert signatures to different formats
    console.log('🔄 Step 3: Convert to Different Formats');
    console.log('---------------------------------------');

    // Method 1: Direct base64 to hex conversion of signature field
    const signatureBytes1 = Uint8Array.from(atob(messageSignature.signature), c => c.charCodeAt(0));
    const hexSignature1 = toHex(signatureBytes1);
    console.log('Method 1 - Direct signature conversion:');
    console.log(`   Base64 signature: ${messageSignature.signature}`);
    console.log(`   Decoded bytes length: ${signatureBytes1.length}`);
    console.log(`   Hex result: ${hexSignature1}`);
    console.log('');

    // Method 2: Convert bytes field to hex (if different)
    if (messageSignature.bytes !== messageSignature.signature) {
      const signatureBytes2 = Uint8Array.from(atob(messageSignature.bytes), c => c.charCodeAt(0));
      const hexSignature2 = toHex(signatureBytes2);
      console.log('Method 2 - Bytes field conversion:');
      console.log(`   Base64 bytes: ${messageSignature.bytes}`);
      console.log(`   Decoded bytes length: ${signatureBytes2.length}`);
      console.log(`   Hex result: ${hexSignature2}`);
      console.log('');
    }

    // Method 3: Try using the signature as-is (if it's already hex)
    if (messageSignature.signature.startsWith('0x')) {
      console.log('Method 3 - Already hex format:');
      console.log(`   Hex signature: ${messageSignature.signature}`);
      console.log('');
    }

    // Step 4: Test each format with SEAL
    console.log('🔄 Step 4: Test Each Format with SEAL');
    console.log('-------------------------------------');

    const testFormats = [
      { name: 'Method 1 (signature->hex)', value: hexSignature1 },
    ];

    // Add method 2 if bytes field is different
    if (messageSignature.bytes !== messageSignature.signature) {
      const signatureBytes2 = Uint8Array.from(atob(messageSignature.bytes), c => c.charCodeAt(0));
      const hexSignature2 = toHex(signatureBytes2);
      testFormats.push({ name: 'Method 2 (bytes->hex)', value: hexSignature2 });
    }

    // Add method 3 if already hex
    if (messageSignature.signature.startsWith('0x')) {
      testFormats.push({ name: 'Method 3 (as-is)', value: messageSignature.signature });
    }

    // Add raw base64 format test
    testFormats.push({ name: 'Raw base64', value: messageSignature.signature });

    for (const format of testFormats) {
      console.log(`\n🧪 Testing ${format.name}:`);
      console.log(`   Value: ${format.value}`);
      console.log(`   Length: ${format.value.length}`);
      console.log(`   Starts with 0x: ${format.value.startsWith('0x')}`);

      try {
        // Create a new session key for each test
        const testSessionKey = await SessionKey.create({
          address: userAddress,
          packageId: packageId,
          ttlMin: 30,
          suiClient
        });

        await testSessionKey.setPersonalMessageSignature(format.value);
        console.log(`   ✅ SEAL accepted ${format.name} format!`);
        
        // Try to test with a simple encrypt operation
        console.log(`   🔄 Testing encryption with this signature format...`);
        // Note: We won't actually encrypt here, just check if signature is valid
        
        break; // If successful, we found the right format
        
      } catch (error) {
        console.log(`   ❌ SEAL rejected ${format.name} format: ${(error as Error).message}`);
      }
    }

    console.log('\n🎯 Signature Format Analysis Complete');

  } catch (error) {
    console.error('❌ Debug failed:', error);
    process.exit(1);
  }
}

// Run if called directly
if (require.main === module) {
  debugSealSignature().catch(console.error);
}

export { debugSealSignature };