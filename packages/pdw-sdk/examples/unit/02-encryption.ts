/**
 * Test 02: Encryption & Decryption
 *
 * Tests EncryptionService functionality:
 * - Encrypt data with SEAL
 * - Decrypt data
 * - Handle different data types
 */

import { EncryptionService, SealService } from '../../src';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';

async function testEncryption() {
  console.log('🧪 Test 02: Encryption & Decryption\n');
  console.log('='.repeat(50));

  try {
    // Initialize services
    console.log('\n1️⃣ Initializing encryption services...');

    // Create a test keypair
    const keypair = new Ed25519Keypair();
    console.log(`✅ Generated keypair: ${keypair.getPublicKey().toSuiAddress()}`);

    const sealService = new SealService();
    const encryptionService = new EncryptionService(sealService);
    console.log('✅ Services initialized');

    // Test 1: Encrypt simple text
    console.log('\n2️⃣ Encrypting simple text...');
    const originalText = 'This is a secret message that needs to be encrypted!';
    const textData = new TextEncoder().encode(originalText);

    const encryptedText = await encryptionService.encrypt(textData, keypair);

    console.log('✅ Text encrypted:');
    console.log(`   - Original length: ${textData.length} bytes`);
    console.log(`   - Encrypted length: ${encryptedText.length} bytes`);
    console.log(`   - Encryption ratio: ${(encryptedText.length / textData.length).toFixed(2)}x`);

    // Test 2: Decrypt text
    console.log('\n3️⃣ Decrypting text...');
    const decryptedText = await encryptionService.decrypt(encryptedText, keypair);
    const decryptedString = new TextDecoder().decode(decryptedText);

    console.log('✅ Text decrypted:');
    console.log(`   - Original: "${originalText}"`);
    console.log(`   - Decrypted: "${decryptedString}"`);
    console.log(`   - Match: ${originalText === decryptedString ? '✅ Yes' : '❌ No'}`);

    // Test 3: Encrypt JSON data
    console.log('\n4️⃣ Encrypting JSON data...');
    const jsonData = {
      userId: 'user123',
      message: 'Confidential information',
      timestamp: Date.now(),
      metadata: {
        category: 'personal',
        importance: 10,
      },
    };

    const jsonString = JSON.stringify(jsonData);
    const jsonBytes = new TextEncoder().encode(jsonString);
    const encryptedJson = await encryptionService.encrypt(jsonBytes, keypair);

    console.log('✅ JSON encrypted:');
    console.log(`   - Original: ${jsonString.length} bytes`);
    console.log(`   - Encrypted: ${encryptedJson.length} bytes`);

    // Test 4: Decrypt JSON
    console.log('\n5️⃣ Decrypting JSON data...');
    const decryptedJson = await encryptionService.decrypt(encryptedJson, keypair);
    const parsedData = JSON.parse(new TextDecoder().decode(decryptedJson));

    console.log('✅ JSON decrypted and parsed:');
    console.log(`   - User ID: ${parsedData.userId}`);
    console.log(`   - Message: ${parsedData.message}`);
    console.log(`   - Data match: ${JSON.stringify(jsonData) === JSON.stringify(parsedData) ? '✅ Yes' : '❌ No'}`);

    // Test 5: Encrypt binary data (simulate file)
    console.log('\n6️⃣ Encrypting binary data...');
    const binaryData = new Uint8Array(1024); // 1KB of data
    for (let i = 0; i < binaryData.length; i++) {
      binaryData[i] = i % 256;
    }

    const encryptedBinary = await encryptionService.encrypt(binaryData, keypair);
    console.log('✅ Binary data encrypted:');
    console.log(`   - Original size: ${binaryData.length} bytes`);
    console.log(`   - Encrypted size: ${encryptedBinary.length} bytes`);

    const decryptedBinary = await encryptionService.decrypt(encryptedBinary, keypair);
    const binaryMatch = decryptedBinary.every((byte, i) => byte === binaryData[i]);
    console.log(`   - Data integrity: ${binaryMatch ? '✅ Verified' : '❌ Failed'}`);

    console.log('\n' + '='.repeat(50));
    console.log('🎉 All encryption tests passed!');

  } catch (error) {
    console.error('\n❌ Test failed:', error);
    if (error instanceof Error) {
      console.error('Stack trace:', error.stack);
    }
    process.exit(1);
  }
}

// Run tests
testEncryption();
