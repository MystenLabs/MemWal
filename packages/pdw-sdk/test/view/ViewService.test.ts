import { beforeAll, describe, expect, it, jest } from '@jest/globals';
import { SuiClient, getFullnodeUrl } from '@mysten/sui/client';
import { sha3_256 } from '@noble/hashes/sha3';
import dotenv from 'dotenv';

import { ViewService } from '../../src/services/ViewService';

dotenv.config({ path: '.env.test' });

describe('ViewService (integration)', () => {
  jest.setTimeout(60_000);

  let suiClient: SuiClient;
  let service: ViewService;
  let packageId: string;
  const testUserAddress = process.env.TEST_USER_ADDRESS || '';
  const walletRegistryId = process.env.WALLET_REGISTRY_ID || '';
  const accessRegistryId = process.env.ACCESS_REGISTRY_ID || '';
  const hasTestUser = Boolean(testUserAddress);

  const toHex = (bytes: Uint8Array) => Array.from(bytes).map((byte) => byte.toString(16).padStart(2, '0')).join('');
  const deriveAddress = (label: string) => `0x${toHex(sha3_256(new TextEncoder().encode(label)))}`;

  beforeAll(() => {
    packageId = process.env.PACKAGE_ID || process.env.SUI_PACKAGE_ID || '';
    if (!packageId) {
      throw new Error('PACKAGE_ID (or SUI_PACKAGE_ID) must be defined in .env.test for ViewService tests');
    }

    const network = (process.env.SUI_NETWORK as 'testnet' | 'devnet' | 'mainnet') || 'testnet';
    const rpcUrl = process.env.SUI_RPC_URL || getFullnodeUrl(network);

    suiClient = new SuiClient({ url: rpcUrl });
    service = new ViewService(suiClient as any, {
      packageId,
      apiUrl: process.env.PDW_API_URL || process.env.API_URL || 'https://pdw-sdk.integration.tests',
      accessRegistryId,
      walletRegistryId,
    });
  });

  describe('object helpers', () => {
    it('returns false for clearly invalid object IDs', async () => {
      const invalidObjectId = 'not-a-sui-object-id';
      const exists = await service.objectExists(invalidObjectId);
      expect(exists).toBe(false);
    });

    it('detects existing registry objects when configured', async () => {
      if (!walletRegistryId) {
        console.warn('⚠️  WALLET_REGISTRY_ID not configured; skipping positive objectExists assertion.');
        return;
      }

      const exists = await service.objectExists(walletRegistryId);
      expect(exists).toBe(true);

      const objectType = await service.getObjectType(walletRegistryId);
      expect(typeof objectType === 'string' ? objectType.length : 0).toBeGreaterThan(0);
    });
  });

  describe('memory queries', () => {
    it('retrieves memory listings for the configured user (if any)', async () => {
      const address = hasTestUser ? testUserAddress : deriveAddress('pdw-empty-memories');
      const result = await service.getUserMemories(address, { limit: 25 });

      expect(Array.isArray(result.data)).toBe(true);
      expect(typeof result.hasMore).toBe('boolean');

      if (result.data.length > 0) {
        const memory = result.data[0];
        expect(memory.id.startsWith('0x')).toBe(true);
        expect(memory.owner).toBe(address);
        expect(typeof memory.category).toBe('string');
        expect(typeof memory.contentSize).toBe('number');
        expect(typeof memory.importance).toBe('number');
      }
    });

    it('fetches individual memories when identifiers are available', async () => {
      const address = hasTestUser ? testUserAddress : deriveAddress('pdw-memory-fetch');
      const listing = await service.getUserMemories(address, { limit: 5 });
      if (listing.data.length === 0) {
        expect(listing.data).toHaveLength(0);
        return;
      }

      const first = listing.data[0];
      const memory = await service.getMemory(first.id);

      expect(memory).not.toBeNull();
      if (!memory) {
        return;
      }

      expect(memory.id).toBe(first.id);
      expect(memory.owner).toBe(address);
      expect(memory.category).toBe(first.category);
    });

    it('summarizes memory statistics without mocks', async () => {
      const address = hasTestUser ? testUserAddress : deriveAddress('pdw-memory-stats');
      const stats = await service.getMemoryStats(address);

      expect(stats.totalMemories).toBeGreaterThanOrEqual(0);
      expect(typeof stats.totalSize).toBe('number');
      expect(typeof stats.averageImportance).toBe('number');
      expect(typeof stats.lastActivityTime).toBe('number');

      Object.entries(stats.categoryCounts).forEach(([category, count]) => {
        expect(typeof category).toBe('string');
        expect(typeof count).toBe('number');
      });
    });
  });

  describe('memory index', () => {
    it('returns structured metadata when an index exists', async () => {
      const address = hasTestUser ? testUserAddress : deriveAddress('pdw-memory-index');
      const index = await service.getMemoryIndex(address);
      if (!index) {
        expect(index).toBeNull();
        return;
      }

      expect(index.owner).toBe(address);
      expect(index.id.startsWith('0x')).toBe(true);
      expect(index.version).toBeGreaterThanOrEqual(0);
      expect(typeof index.indexBlobId).toBe('string');
    });
  });

  describe('access control queries', () => {
    it('lists access permissions granted by the test user when available', async () => {
      const address = hasTestUser ? testUserAddress : deriveAddress('pdw-access-permissions');
      const permissions = await service.getAccessPermissions(address, { asGrantor: true });
      expect(Array.isArray(permissions)).toBe(true);

      permissions.forEach((permission) => {
        expect(permission.id.startsWith('0x')).toBe(true);
        expect(permission.grantor).toBe(address);
        expect(typeof permission.grantee).toBe('string');
        expect(typeof permission.permissionType).toBe('string');
        expect(typeof permission.createdAt).toBe('number');
      });
    });

    it('returns empty results when registry objects are not configured', async () => {
      const registries = await service.getContentRegistry();
      expect(registries.data.length).toBe(0);
      expect(registries.hasMore).toBe(false);
    });

    it('fetches content registry entries for the configured owner when available', async () => {
      if (!testUserAddress || !walletRegistryId) {
        const address = deriveAddress('pdw-content-registry');
        const registries = await service.getContentRegistry({ owner: address, limit: 1 });
        expect(Array.isArray(registries.data)).toBe(true);
        return;
      }

      const registries = await service.getContentRegistry({ owner: testUserAddress, limit: 10 });

      expect(Array.isArray(registries.data)).toBe(true);
      expect(typeof registries.hasMore).toBe('boolean');

      registries.data.forEach((entry) => {
        expect(entry.owner).toBe(testUserAddress);
        expect(entry.id.startsWith('0x')).toBe(true);
        expect(typeof entry.contentHash).toBe('string');
      });
    });
  });

  describe('search helpers', () => {
    it('returns an empty array for unindexed content-hash lookups', async () => {
      const result = await service.findMemoryByContentHash('nonexistent-hash-for-integration-test');
      expect(Array.isArray(result)).toBe(true);
      expect(result.length).toBe(0);
    });
  });
});
