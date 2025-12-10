/**
 * Debug signature format from Ed25519Keypair.signPersonalMessage()
 */

import { config } from 'dotenv';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { decodeSuiPrivateKey } from '@mysten/sui/cryptography';
import { toHex } from '@mysten/sui/utils';

// Load test environment
config({ path: '.env.test' });

async function debugSignatureFormat() {
  console.log('🔍 Debugging Ed25519Keypair.signPersonalMessage() signature format');
  console.log('================================================================\n');

  try {
    // Setup keypair
    const privateKey = process.env.TEST_PRIVATE_KEY || 'suiprivkey1qp0f8lavfvndyru7e2v4rrtevlnmzemsppudkgc6s8grz9v7y4p4sp905g6';
    const { secretKey } = decodeSuiPrivateKey(privateKey);
    const keypair = Ed25519Keypair.fromSecretKey(secretKey);
    const userAddress = keypair.toSuiAddress();

    console.log(`✅ Test setup complete for ${userAddress}\n`);

    // Test message (similar to SEAL personal message)
    const testMessage = "Please sign this message to authenticate with SEAL:\n\nAddress: 0xc5e67f46e1b99b580da3a6cc69acf187d0c08dbe568f8f5a78959079c9d82a15\nPackage: 0xe17807a2cfdb60c506ecdb6c24fe407384d9287fc5d7ae677872ba1b7f8d8623\nTTL: 30 minutes";
    
    console.log('📝 Test Message:');
    console.log(`   Message: "${testMessage.substring(0, 100)}..."`);
    console.log(`   Message length: ${testMessage.length} chars`);
    
    // Encode message as bytes
    const messageBytes = new TextEncoder().encode(testMessage);
    console.log(`   Message bytes length: ${messageBytes.length} bytes`);
    console.log(`   First 10 bytes: [${Array.from(messageBytes.slice(0, 10)).join(', ')}]\n`);

    // Sign the message
    console.log('🔏 Signing with Ed25519Keypair.signPersonalMessage()...');
    const signResult = await keypair.signPersonalMessage(messageBytes);
    
    console.log('📊 Signature Analysis:');
    console.log(`   signResult type: ${typeof signResult}`);
    console.log(`   signResult constructor: ${signResult?.constructor?.name}`);
    console.log(`   signResult keys: ${Object.keys(signResult || {}).join(', ')}`);
    
    if (signResult && typeof signResult === 'object') {
      console.log(`   signResult.signature type: ${typeof (signResult as any).signature}`);
      console.log(`   signResult.signature constructor: ${(signResult as any).signature?.constructor?.name}`);
      console.log(`   signResult.bytes type: ${typeof (signResult as any).bytes}`);
      console.log(`   signResult.bytes constructor: ${(signResult as any).bytes?.constructor?.name}`);
      
      const sig = (signResult as any).signature;
      const bytes = (signResult as any).bytes;
      
      if (typeof sig === 'string') {
        console.log(`   📝 Signature (base64): "${sig.substring(0, 50)}${sig.length > 50 ? '...' : ''}"`);
        console.log(`   📝 Starts with 0x: ${sig.startsWith('0x')}`);
      }
      
      if (bytes && bytes.constructor?.name === 'Uint8Array') {
        console.log(`   🔧 Bytes length: ${bytes.length}`);
        console.log(`   🔧 Bytes as hex: ${toHex(bytes)}`);
        console.log(`   🔧 Hex starts with 0x: ${toHex(bytes).startsWith('0x')}`);
      }
    }

    // Test different conversion approaches
    if ((signResult as any)?.signature) {
      console.log('\n🔧 Testing Conversion Approaches:');
      
      const sig = (signResult as any).signature;
      console.log(`   Original signature type: ${typeof sig}`);
      
      if (typeof sig === 'string') {
        console.log(`   ✅ Already string: "${sig.substring(0, 30)}..."`);
        console.log(`   ✅ Starts with 0x: ${sig.startsWith('0x')}`);
        console.log(`   ✅ Expected SEAL format: ${sig.startsWith('0x') ? 'YES' : 'NO'}`);
      } else if (sig && sig.constructor?.name === 'Uint8Array') {
        const hexSig = toHex(sig);
        console.log(`   🔄 Convert Uint8Array to hex: "${hexSig.substring(0, 30)}..."`);
        console.log(`   ✅ Starts with 0x: ${hexSig.startsWith('0x')}`);
        console.log(`   ✅ Expected SEAL format: YES`);
      }
    }

    console.log('\n🎯 CONCLUSION:');
    console.log('   The signature format returned by Ed25519Keypair.signPersonalMessage():');
    
    const sig = (signResult as any)?.signature;
    if (sig) {
      if (typeof sig === 'string' && sig.startsWith('0x')) {
        console.log('   ✅ CORRECT: signature is already a hex string with 0x prefix');
        console.log('   ✅ Can pass directly to sessionKey.setPersonalMessageSignature()');
      } else if (sig && sig.constructor?.name === 'Uint8Array') {
        console.log('   ⚠️  NEEDS CONVERSION: signature is Uint8Array');
        console.log('   🔧 Must convert with toHex() before passing to SEAL SDK');
      } else {
        console.log('   ❌ UNEXPECTED FORMAT: review signature handling logic');
      }
    }

  } catch (error) {
    console.error('❌ Debug failed:', error);
    console.error('   Error type:', typeof error);
    console.error('   Error message:', (error as Error).message);
    console.error('   Error stack:', (error as Error).stack);
  }
}

// Run the debug
debugSignatureFormat().catch(console.error);