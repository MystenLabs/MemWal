/**
 * Personal Data Wallet Client Factory
 *
 * Provides convenience functions for creating PDW-enabled Sui clients
 * following MystenLabs best practices for client extensions.
 *
 * Also includes Simple PDW Client for easy function-based API.
 */

import { SuiClient } from '@mysten/sui/client';
import type { PDWConfig } from '../types';
import { createDefaultConfig, createTestnetConfig } from '../config/defaults';
import { validateConfig, mergeConfigs } from '../config/validation';
import { PersonalDataWallet } from './PersonalDataWallet';
import { SimplePDWClient, type SimplePDWConfig } from './SimplePDWClient';
import type { Keypair } from '@mysten/sui/cryptography';

/**
 * Create a new SuiClient extended with Personal Data Wallet functionality
 * 
 * @param suiClientConfig - Standard SuiClient configuration
 * @param pdwConfig - PDW-specific configuration
 * @returns Extended SuiClient with PDW capabilities
 * 
 * @example
 * ```typescript
 * const client = createPDWClient(
 *   { url: 'https://fullnode.devnet.sui.io' },
 *   {
 *     apiUrl: 'https://api.pdw.example.com',
 *     packageId: '0x123...'
 *   }
 * );
 * 
 * // Now use PDW functionality
 * const memory = await client.pdw.createMemory({
 *   content: 'My first memory',
 *   category: 'personal',
 *   userAddress: '0x789...'
 * });
 * ```
 */
export function createPDWClient(
  suiClientConfig: ConstructorParameters<typeof SuiClient>[0],
  pdwConfig?: Partial<PDWConfig>
) {
  const suiClient = new SuiClient(suiClientConfig);
  const fullConfig = validateConfig(mergeConfigs(createDefaultConfig(), pdwConfig || {}));
  
  return suiClient.$extend(PersonalDataWallet.asClientExtension(pdwConfig));
}

/**
 * Extend an existing SuiClient with Personal Data Wallet functionality
 * 
 * @param client - Existing SuiClient instance
 * @param pdwConfig - PDW-specific configuration
 * @returns Extended client with PDW capabilities
 */
export function extendWithPDW(
  client: SuiClient,
  pdwConfig?: Partial<PDWConfig>
) {
  return client.$extend(PersonalDataWallet.asClientExtension(pdwConfig));
}

/**
 * Create a PDW client with common development settings
 * 
 * @param overrides - Any configuration overrides
 * @returns Development-ready PDW client
 */
export function createDevPDWClient(overrides?: {
  suiUrl?: string;
  apiUrl?: string;
  packageId?: string;
}) {
  return createPDWClient(
    {
      url: overrides?.suiUrl || 'https://fullnode.devnet.sui.io',
    },
    {
      apiUrl: overrides?.apiUrl || 'http://localhost:3000/api',
      packageId: overrides?.packageId || '0x0',
      encryptionConfig: {
        enabled: true,
        keyServers: ['0x0'], // Placeholder for development
        policyConfig: {
          threshold: 2,
        },
      },
      storageConfig: {
        provider: 'walrus',
        cacheEnabled: true,
        encryptionEnabled: true,
      },
    }
  );
}

/**
 * Create a PDW client configured for testnet
 * 
 * @param overrides - Any configuration overrides
 * @returns Testnet-ready PDW client
 */
export function createTestnetPDWClient(overrides?: Partial<PDWConfig>) {
  const testnetConfig = createTestnetConfig(overrides);

  return createPDWClient(
    { url: 'https://fullnode.testnet.sui.io' },
    testnetConfig
  );
}

// ==================== SIMPLE PDW CLIENT ====================

/**
 * Create a Simple PDW Client (function-based API, no hooks)
 *
 * @param config - Simple client configuration
 * @returns Initialized simple client
 *
 * @example
 * ```typescript
 * import { createSimplePDWClient } from 'personal-data-wallet-sdk';
 *
 * const pdw = await createSimplePDWClient({
 *   signer: keypair,
 *   network: 'testnet',
 *   geminiApiKey: process.env.GEMINI_API_KEY
 * });
 *
 * await pdw.memory.create('I love TypeScript');
 * const results = await pdw.search.vector('programming');
 * ```
 */
export async function createSimplePDWClient(config: SimplePDWConfig): Promise<SimplePDWClient> {
  const client = new SimplePDWClient(config);
  await client.ready();
  return client;
}

/**
 * Create Simple PDW Client from Keypair
 *
 * Helper for Node.js environments
 */
export async function createSimplePDWClientFromKeypair(
  keypair: Keypair,
  config: Omit<SimplePDWConfig, 'signer' | 'userAddress'>
): Promise<SimplePDWClient> {
  return createSimplePDWClient({
    ...config,
    signer: keypair,
    userAddress: keypair.getPublicKey().toSuiAddress()
  });
}