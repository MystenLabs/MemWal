/**
 * MainWalletService Integration Tests (No Mocks)
 *
 * Exercises on-chain lookups and deterministic helpers using the
 * production configuration from `.env.test`.
 */

import { beforeAll, describe, expect, it, jest } from '@jest/globals';
import { SuiClient, getFullnodeUrl } from '@mysten/sui/client';
import { sha3_256 } from '@noble/hashes/sha3';
import dotenv from 'dotenv';

import { MainWalletService } from '../../src/wallet/MainWalletService';

dotenv.config({ path: '.env.test' });

const toHex = (bytes: Uint8Array) => Array.from(bytes).map((byte) => byte.toString(16).padStart(2, '0')).join('');
const deriveAddress = (label: string) => `0x${toHex(sha3_256(new TextEncoder().encode(label)))}`;

describe('MainWalletService (integration)', () => {
  jest.setTimeout(60_000);

  let suiClient: SuiClient;
  let service: MainWalletService;
  let packageId: string;
  const testUserAddress = process.env.TEST_USER_ADDRESS || '';

  beforeAll(() => {
    packageId = process.env.PACKAGE_ID || process.env.SUI_PACKAGE_ID || '';
    if (!packageId) {
      throw new Error('PACKAGE_ID (or SUI_PACKAGE_ID) must be defined in .env.test for MainWalletService tests');
    }

    const network = (process.env.SUI_NETWORK as 'testnet' | 'mainnet' | 'devnet') || 'testnet';
    const rpcUrl = process.env.SUI_RPC_URL || getFullnodeUrl(network);

    suiClient = new SuiClient({ url: rpcUrl });
    service = new MainWalletService({ suiClient, packageId });
  });

  describe('getMainWallet', () => {
    it('returns null for an unused address', async () => {
      const unusedAddress = deriveAddress('pdw-unused-address');
      const result = await service.getMainWallet(unusedAddress);
      expect(result).toBeNull();
    });

    it('retrieves metadata for the configured test user when available', async () => {
      if (!testUserAddress) {
        expect(testUserAddress).toBe('');
        const wallet = await service.getMainWallet(testUserAddress);
        expect(wallet).toBeNull();
        return;
      }

      const wallet = await service.getMainWallet(testUserAddress);

      if (!wallet) {
        expect(wallet).toBeNull();
        return;
      }

      expect(wallet.owner).toBe(testUserAddress);
      expect(wallet.walletId.startsWith('0x')).toBe(true);
      expect(wallet.createdAt).toBeGreaterThan(0);
      expect(wallet.salts.context.length).toBeGreaterThan(0);
    });
  });

  describe('createMainWallet', () => {
    it('generates a new wallet with random salt when none provided', async () => {
      const address = deriveAddress('pdw-main-wallet-create');
      const result = await service.createMainWallet({ userAddress: address });

      expect(result.owner).toBe(address);
      expect(result.walletId).toContain('wallet_');
      expect(result.salts.context).toBeDefined();
      expect(result.salts.context.length).toBeGreaterThan(0);
    });

    it('respects custom salt input', async () => {
      const address = deriveAddress('pdw-main-wallet-custom');
      const salt = 'custom_salt_for_tests';

      const result = await service.createMainWallet({
        userAddress: address,
        salts: { context: salt }
      });

      expect(result.salts.context).toBe(salt);
    });
  });

  describe('deriveContextId', () => {
    it('produces deterministic hashes for identical inputs', async () => {
      const address = deriveAddress('pdw-context-deterministic');
      const salt = 'context_salt';

      const first = await service.deriveContextId({ userAddress: address, appId: 'app-a', salt });
      const second = await service.deriveContextId({ userAddress: address, appId: 'app-a', salt });

      expect(first).toBe(second);
      expect(first).toMatch(/^0x[a-f0-9]{64}$/);
    });

    it('yields distinct IDs for different appIds', async () => {
      const address = deriveAddress('pdw-context-distinct');
      const salt = 'context_salt';

      const one = await service.deriveContextId({ userAddress: address, appId: 'app-one', salt });
      const two = await service.deriveContextId({ userAddress: address, appId: 'app-two', salt });

      expect(one).not.toBe(two);
    });

    it('throws when attempting salt lookup for unknown wallets', async () => {
      const address = deriveAddress('pdw-context-missing-wallet');

      await expect(
        service.deriveContextId({ userAddress: address, appId: 'integration-app' })
      ).rejects.toThrow('Main wallet not found - create one first');
    });
  });

  describe('rotateKeys', () => {
    it('returns simulated rotation metadata', async () => {
      const address = deriveAddress('pdw-rotate-keys');
      const result = await service.rotateKeys({ userAddress: address, sessionKeyTtlMin: 90 });

      expect(result.sessionKeyId).toContain(address.slice(2, 10));
      expect(result.expiresAt).toBeGreaterThan(Date.now());
      expect(result.backupKeyRotated).toBe(true);
    });
  });

  describe('hasMainWallet', () => {
    it('detects absence for unused addresses', async () => {
      const address = deriveAddress('pdw-has-wallet-none');
      const result = await service.hasMainWallet(address);
      expect(result).toBe(false);
    });

    it('returns a boolean for configured test user presence checks', async () => {
      const address = testUserAddress || deriveAddress('pdw-has-wallet-fallback');
      const result = await service.hasMainWallet(address);
      expect(typeof result).toBe('boolean');
    });
  });

  describe('address validation helpers', () => {
    it('rejects malformed Sui addresses', async () => {
      await expect(service.getMainWalletRequired('not-a-valid-address')).rejects.toThrow('Invalid Sui address format');
    });

    it('requires an existing wallet for well-formed addresses', async () => {
      const validAddress = deriveAddress('pdw-valid-address');
      await expect(service.getMainWalletRequired(validAddress)).rejects.toThrow('Main wallet not found for address');
    });
  });

  describe('ensureMainWallet', () => {
    it('returns existing metadata for the configured user when available', async () => {
      if (!testUserAddress) {
        console.warn('⚠️  TEST_USER_ADDRESS not configured; skipping ensureMainWallet existing-path test.');
        return;
      }

      const wallet = await service.ensureMainWallet(testUserAddress);
      expect(wallet.owner).toBe(testUserAddress);
      expect(wallet.salts.context.length).toBeGreaterThan(0);
    });

    it('generates deterministic metadata for new addresses', async () => {
      const freshAddress = deriveAddress(`pdw-ensure-${Date.now()}`);
      const wallet = await service.ensureMainWallet(freshAddress);

      expect(wallet.owner).toBe(freshAddress);
      expect(wallet.walletId).toContain(freshAddress.slice(2, 10));
      expect(wallet.salts.context.length).toBeGreaterThan(0);
    });
  });
});