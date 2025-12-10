/**
 * Default PDW Configuration
 * 
 * Provides sensible defaults for different environments
 */

import type { PDWConfig } from '../types';

export function createDefaultConfig(): PDWConfig {
  return {
    // Updated October 3, 2025 - Dynamic Fields Implementation
    packageId: '0x6dc2fe501926b17f441e46c3ac121ad0924da3aa7c5bc78781ddd7df1080694a',
    accessRegistryId: '0x0',
    apiUrl: 'http://localhost:3000/api',
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

export function createProductionConfig(overrides: Partial<PDWConfig> = {}): PDWConfig {
  return {
    ...createDefaultConfig(),
    apiUrl: 'https://api.personaldatawallet.com',
    accessRegistryId: overrides.accessRegistryId ?? '0x0',
    encryptionConfig: {
      enabled: true,
      keyServers: [
        // Production SEAL key servers - to be configured
        '0x0' // Placeholder
      ],
      policyConfig: {
        threshold: 2,
      },
    },
    // Production Walrus endpoints
    walrusPublisherUrl: 'https://publisher.walrus.space',
    walrusAggregatorUrl: 'https://aggregator.walrus.space',
    ...overrides,
  };
}

export function createTestnetConfig(overrides: Partial<PDWConfig> = {}): PDWConfig {
  return {
    ...createDefaultConfig(),
    apiUrl: 'https://testnet-api.personaldatawallet.com',
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