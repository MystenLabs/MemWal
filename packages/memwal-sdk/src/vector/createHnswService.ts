/**
 * createHnswService - Factory for Environment-Aware HNSW Service
 *
 * Automatically detects the runtime environment and returns the appropriate
 * HNSW implementation:
 * - Browser: BrowserHnswIndexService (hnswlib-wasm)
 * - Node.js: NodeHnswService (hnswlib-node)
 *
 * Uses singleton pattern to prevent redundant initializations.
 */

import type { IHnswService, HnswServiceConfig } from './IHnswService';
import { isBrowser, isNode } from './IHnswService';

// Re-export environment detection functions
export { isBrowser, isNode };

// Singleton instance and initialization promise
let singletonInstance: IHnswService | null = null;
let singletonInitPromise: Promise<IHnswService> | null = null;
let instanceCount = 0;

/**
 * Create an HNSW service appropriate for the current environment.
 * Uses singleton pattern - subsequent calls return the same instance.
 *
 * @param config - Service configuration (only used on first call)
 * @returns Promise<IHnswService> - The appropriate HNSW service for the environment
 *
 * @example
 * ```typescript
 * const hnswService = await createHnswService({
 *   indexConfig: { dimension: 3072 }
 * });
 *
 * await hnswService.addVector(userAddress, vectorId, embedding);
 * const results = await hnswService.search(userAddress, queryEmbedding);
 * ```
 */
export async function createHnswService(config: HnswServiceConfig = {}): Promise<IHnswService> {
  // Return existing singleton if available
  if (singletonInstance) {
    instanceCount++;
    console.log(`[createHnswService] Returning singleton instance (request #${instanceCount})`);
    return singletonInstance;
  }

  // Return pending initialization promise if already in progress
  if (singletonInitPromise) {
    instanceCount++;
    console.log(`[createHnswService] Waiting for pending initialization (request #${instanceCount})`);
    return singletonInitPromise;
  }

  // Create new singleton instance
  instanceCount = 1;
  singletonInitPromise = createNewInstance(config);

  try {
    singletonInstance = await singletonInitPromise;
    return singletonInstance;
  } catch (error) {
    // Reset on failure to allow retry
    singletonInitPromise = null;
    throw error;
  }
}

/**
 * Internal function to create a new HNSW service instance
 */
async function createNewInstance(config: HnswServiceConfig): Promise<IHnswService> {
  if (isBrowser()) {
    console.log('[createHnswService] Browser environment detected, using hnswlib-wasm');

    // Dynamic import for browser service
    const { BrowserHnswIndexService } = await import('./BrowserHnswIndexService');
    const service = new BrowserHnswIndexService(config.indexConfig);
    return service as unknown as IHnswService;
  }

  if (isNode()) {
    console.log('[createHnswService] Node.js environment detected, using hnswlib-node');

    // Dynamic import for Node.js service
    const { NodeHnswService } = await import('./NodeHnswService');
    const service = new NodeHnswService(config);
    await service.initialize();
    return service;
  }

  throw new Error(
    'Unsupported environment: HNSW service requires either a browser (for hnswlib-wasm) ' +
    'or Node.js (for hnswlib-node) environment.'
  );
}

/**
 * Reset the singleton instance (useful for testing)
 */
export function resetHnswServiceSingleton(): void {
  if (singletonInstance) {
    singletonInstance.destroy();
  }
  singletonInstance = null;
  singletonInitPromise = null;
  instanceCount = 0;
  console.log('[createHnswService] Singleton instance reset');
}

/**
 * Get singleton statistics
 */
export function getHnswServiceStats(): { instanceCount: number; isInitialized: boolean } {
  return {
    instanceCount,
    isInitialized: singletonInstance !== null
  };
}

/**
 * Check if HNSW service is available in the current environment
 */
export function isHnswAvailable(): boolean {
  return isBrowser() || isNode();
}

/**
 * Get the type of HNSW service that would be used
 */
export function getHnswServiceType(): 'browser' | 'node' | 'none' {
  if (isBrowser()) return 'browser';
  if (isNode()) return 'node';
  return 'none';
}
