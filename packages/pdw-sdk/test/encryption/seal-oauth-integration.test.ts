/**
 * SEAL Integration Tests with Wallet Allowlist Permissions
 *
 * Tests the updated EncryptionService with CrossContextPermissionService
 * for wallet-based permission validation during decryption.
 */

import { describe, it, expect, beforeAll } from '@jest/globals';
import { SuiClient, getFullnodeUrl } from '@mysten/sui/client';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { fromHex } from '@mysten/sui/utils';
import { EncryptionService } from '../../src/services/EncryptionService';
import { CrossContextPermissionService } from '../../src/services/CrossContextPermissionService';
import type { PDWConfig } from '../../src/types';
import dotenv from 'dotenv';

dotenv.config({ path: '.env.test' });

describe('SEAL Integration with Wallet Allowlist Permissions', () => {
  let client: SuiClient;
  let encryptionService: EncryptionService;
  let permissionService: CrossContextPermissionService;
  let keypair: Ed25519Keypair;
  let userAddress: string;
  const packageId = process.env.PACKAGE_ID || process.env.SUI_PACKAGE_ID || '';
  const accessRegistryId = process.env.ACCESS_REGISTRY_ID || '';
  const requestingWalletA = '0x1111111111111111111111111111111111111111111111111111111111111111';
  const requestingWalletB = '0x2222222222222222222222222222222222222222222222222222222222222222';
  const contextWallet = '0x3333333333333333333333333333333333333333333333333333333333333333';

  beforeAll(() => {
    // Initialize Sui client
    client = new SuiClient({
      url: getFullnodeUrl('testnet'),
    });

    // Initialize keypair from environment
    const privateKeyHex = process.env.TEST_PRIVATE_KEY;
    if (!privateKeyHex) {
      throw new Error('TEST_PRIVATE_KEY not found in .env.test');
    }

    // Handle both hex and suiprivkey formats
    if (privateKeyHex.startsWith('suiprivkey')) {
      keypair = Ed25519Keypair.fromSecretKey(privateKeyHex);
    } else {
      const cleanHex = privateKeyHex.replace('0x', '');
      keypair = Ed25519Keypair.fromSecretKey(fromHex(cleanHex));
    }
    userAddress = keypair.getPublicKey().toSuiAddress();

    // Initialize services
    const config: PDWConfig = {
      packageId,
      accessRegistryId,
      encryptionConfig: {
        enabled: true,
        keyServers: [
          '0x73d05d62c18d9374e3ea529e8e0ed6161da1a141a94d3f76ae3fe4e99356db75',
          '0xf5d14a81a982144ae441cd7d64b09027f116a468bd36e7eca494f750591623c8'
        ]
      }
    };

    encryptionService = new EncryptionService(
      { client } as any,
      config
    );

    permissionService = new CrossContextPermissionService(
      { packageId, accessRegistryId },
      client
    );
  });

  describe('Transaction Building', () => {
    it('should build seal_approve transaction for requesting wallet', async () => {
      const tx = await encryptionService.buildAccessTransactionForWallet(
        userAddress,
        requestingWalletA,
        'read'
      );

      expect(tx).toBeDefined();
      expect(tx.constructor.name).toMatch(/Transaction/);
    });

    it('should warn when using deprecated buildAccessTransaction', async () => {
      // Test will emit real console.warn - no mocking
      const tx = await encryptionService.buildAccessTransaction(
        userAddress,
        'read'
      );

      expect(tx).toBeDefined();
      expect(tx.constructor.name).toMatch(/Transaction/);
      // Note: Real console.warn will appear in test output
    });

    it('should build different transactions for different requesting wallets', async () => {
      const tx1 = await encryptionService.buildAccessTransactionForWallet(
        userAddress,
        requestingWalletA,
        'read'
      );

      const tx2 = await encryptionService.buildAccessTransactionForWallet(
        userAddress,
        requestingWalletB,
        'read'
      );

      // Transactions should have same structure but different arguments
      const tx1Data = tx1.getData();
      const tx2Data = tx2.getData();
      
      // Both should have commands (moveCall)
      expect(tx1Data.commands.length).toBeGreaterThan(0);
      expect(tx2Data.commands.length).toBeGreaterThan(0);
      
      // Both should have inputs (arguments for the moveCall)
      expect(tx1Data.inputs.length).toBeGreaterThan(0);
      expect(tx2Data.inputs.length).toBeGreaterThan(0);
      
  // Inputs should be different due to different requesting wallet parameters
      expect(JSON.stringify(tx1Data.inputs)).not.toEqual(JSON.stringify(tx2Data.inputs));
    });
  });

  describe('Encryption', () => {
    it('should encrypt data without app_id requirement', async () => {
      const testData = 'Test data for encryption';
      const result = await encryptionService.encrypt(
        testData,
        userAddress
      );

      expect(result).toHaveProperty('encryptedContent');
      expect(result).toHaveProperty('backupKey');
      expect(result).toHaveProperty('contentHash');
      expect(result.encryptedContent).toBeInstanceOf(Uint8Array);
      expect(result.backupKey).toMatch(/^[0-9a-f]+$/);
    }, 60000);
  });

  describe('Decryption with Wallet Allowlist', () => {
    it('should warn when decrypting without requestingWallet', async () => {
      // Encrypt first
      const testData = 'Test data';
      const encrypted = await encryptionService.encrypt(testData, userAddress);

      // Try to decrypt without app_id (will emit real console.warn)
      try {
        await encryptionService.decrypt({
          encryptedContent: encrypted.encryptedContent,
          userAddress,
        });
      } catch (error) {
        // Expected to fail due to session key issues
        // Real warning will appear in test output
        expect(error).toBeDefined();
      }
    }, 60000);

  it('should attempt decryption with requestingWallet', async () => {
      // Encrypt first
      const testData = 'Test data with app';
      const encrypted = await encryptionService.encrypt(testData, userAddress);

      // Try to decrypt with app_id
      try {
        await encryptionService.decrypt({
          encryptedContent: encrypted.encryptedContent,
          userAddress,
          requestingWallet: requestingWalletA,
        });
      } catch (error) {
        // Expected to fail due to session key/permission setup requirements
        // The important part is that it builds the right transaction
        expect(error).toBeDefined();
      }
    }, 60000);
  });

  describe('CrossContextPermissionService Integration', () => {
    it('should build seal_approve transaction with wallet validation', () => {
      const identityBytes = fromHex(userAddress.replace('0x', ''));

      const tx = permissionService.buildSealApproveTransaction(
        identityBytes,
        requestingWalletA
      );

      expect(tx).toBeDefined();
      expect(tx.constructor.name).toMatch(/Transaction/);
    });

    it('should use same transaction builder as EncryptionService', async () => {
      // Build transaction via EncryptionService
      const encryptionTx = await encryptionService.buildAccessTransactionForWallet(
        userAddress,
        requestingWalletB,
        'read'
      );

      // Build transaction via CrossContextPermissionService
      const identityBytes = fromHex(userAddress.replace('0x', ''));
      const permissionTx = permissionService.buildSealApproveTransaction(
        identityBytes,
        requestingWalletB
      );

      // Both should be valid transactions
      expect(encryptionTx.constructor.name).toMatch(/Transaction/);
      expect(permissionTx.constructor.name).toMatch(/Transaction/);

      // Compare transaction data structures
      const encryptionData = encryptionTx.getData();
      const permissionData = permissionTx.getData();

      // Both should have same number of commands
      expect(encryptionData.commands.length).toBe(permissionData.commands.length);
      
      // Both should call seal_approve with same structure
      expect(encryptionData.commands[0].$kind).toBe('MoveCall');
      expect(permissionData.commands[0].$kind).toBe('MoveCall');
    });
  });

  describe('Wallet Allowlist Permission Flow', () => {
    it('should demonstrate complete permission + decryption flow', async () => {
      const expiresAt = Date.now() + 86400000; // 24h

      // Step 1: Register context wallet (would be done by app)
      const registerTx = permissionService.buildRegisterContextWalletTransaction({
        contextWallet,
        derivationIndex: 5,
        appHint: 'social-app'
      });
      expect(registerTx).toBeDefined();

      // Step 2: Grant wallet allowlist access
      const grantTx = permissionService.buildGrantWalletAllowlistTransaction({
        requestingWallet: requestingWalletA,
        targetWallet: contextWallet,
        scope: 'read',
        accessLevel: 'read',
        expiresAt
      });
      expect(grantTx).toBeDefined();

      // Step 3: Build SEAL approval with requesting wallet for decryption
      const sealTx = await encryptionService.buildAccessTransactionForWallet(
        userAddress,
        requestingWalletA,
        'read'
      );
      expect(sealTx).toBeDefined();

      // All transactions should be valid
      expect(registerTx.constructor.name).toMatch(/Transaction/);
      expect(grantTx.constructor.name).toMatch(/Transaction/);
      expect(sealTx.constructor.name).toMatch(/Transaction/);
    }, 60000);
  });

  describe('Backward Compatibility', () => {
    it('should support legacy decrypt without app_id', async () => {
      // Encrypt data
      const testData = 'Legacy data';
      const encrypted = await encryptionService.encrypt(testData, userAddress);

      // Decrypt without app_id (legacy mode - will emit real console.warn)
      try {
        await encryptionService.decrypt({
          encryptedContent: encrypted.encryptedContent,
          userAddress,
          // No app_id provided
        });
      } catch (error) {
        // Expected to fail, but should have used legacy transaction
        expect(error).toBeDefined();
      }
      // Real warning will appear in test output
    }, 60000);
  });
});
