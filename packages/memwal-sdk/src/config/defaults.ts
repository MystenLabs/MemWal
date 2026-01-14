/**
 * Default PDW Configuration
 * 
 * Provides sensible defaults for different environments
 */

import type { PDWConfig } from '../types';

export function createDefaultConfig(): PDWConfig {
  return {
    // Updated January 12, 2026 - SEAL key_id first argument fix
    packageId: '0xa5d7d98ea41620c9aaf9f13afa6512455d4d10ca06ccea3f8cd5b2b9568e3a9e',
    accessRegistryId: '0x0',
    encryptionConfig: {
      enabled: true,
      keyServers: [], // To be configured based on environment
      policyConfig: {
        threshold: 2, // 2-of-3 threshold by default
      },
    },
    storageConfig: {
      cacheEnabled: true,
      encryptionEnabled: true,
    },
    // Walrus Storage Configuration
    walrusPublisherUrl: 'https://publisher.walrus-testnet.walrus.space',
    walrusAggregatorUrl: 'https://aggregator.walrus-testnet.walrus.space',
    walrusMaxFileSize: 1024 * 1024 * 1024, // 1GB
    walrusTimeout: 30000, // 30 seconds
  };
}

export function createTestnetConfig(overrides: Partial<PDWConfig> = {}): PDWConfig {
  return {
    ...createDefaultConfig(),
    accessRegistryId: overrides.accessRegistryId ?? '0x0',
    encryptionConfig: {
      enabled: true,
      keyServers: [
        // Testnet SEAL key servers
        '0x0' // Placeholder - will be updated with actual testnet servers
      ],
      policyConfig: {
        threshold: 2,
      },
    },
    // Testnet Walrus endpoints (same as default for now)
    walrusPublisherUrl: 'https://publisher.walrus-testnet.walrus.space',
    walrusAggregatorUrl: 'https://aggregator.walrus-testnet.walrus.space',
    ...overrides,
  };
}