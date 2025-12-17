/**
 * Storage Namespace - Consolidated Storage Operations
 *
 * Merges functionality from:
 * - StorageService: Walrus blob storage operations
 * - CacheNamespace: LRU in-memory caching
 *
 * Provides unified interface for data persistence (Walrus) and caching.
 *
 * @module client/namespaces/consolidated
 */

import type { ServiceContainer } from '../../SimplePDWClient';

// ============================================================================
// Types
// ============================================================================

/**
 * Cache statistics
 */
export interface CacheStats {
  size: number;
  totalAccess: number;
  hitRate: number;
  oldestItem?: Date;
  newestItem?: Date;
}

/**
 * Upload result from Walrus
 */
export interface UploadResult {
  blobId: string;
  size: number;
  contentType?: string;
}

/**
 * Memory package structure
 */
export interface MemoryPackage {
  content: string;
  contentType: string;
  metadata?: Record<string, any>;
  embedding?: number[];
  createdAt?: number;
}

/**
 * Upload options
 */
export interface UploadOptions {
  contentType?: string;
  encrypt?: boolean;
  epochs?: number;
}

// ============================================================================
// Sub-Namespaces
// ============================================================================

/**
 * Cache sub-namespace for LRU caching operations
 */
class CacheSubNamespace {
  constructor(private services: ServiceContainer) {}

  /**
   * Get cached value
   *
   * @param key - Cache key
   * @returns Cached value or null if not found/expired
   *
   * @example
   * ```typescript
   * const cached = pdw.storage.cache.get<User>('user:123');
   * if (cached) {
   *   console.log('Cache hit:', cached);
   * }
   * ```
   */
  get<T = any>(key: string): T | null {
    if (!this.services.batchService) {
      throw new Error('Batch service (cache) not configured.');
    }
    return this.services.batchService.getCache<T>(key);
  }

  /**
   * Set cache value
   *
   * @param key - Cache key
   * @param value - Value to cache
   * @param ttl - Time-to-live in milliseconds (optional)
   *
   * @example
   * ```typescript
   * pdw.storage.cache.set('user:123', userData, 60000); // 1 minute TTL
   * ```
   */
  set<T = any>(key: string, value: T, ttl?: number): void {
    if (!this.services.batchService) {
      throw new Error('Batch service (cache) not configured.');
    }
    this.services.batchService.setCache(key, value, ttl);
  }

  /**
   * Check if key exists in cache
   *
   * @param key - Cache key
   * @returns True if key exists and not expired
   */
  has(key: string): boolean {
    if (!this.services.batchService) {
      throw new Error('Batch service (cache) not configured.');
    }
    return this.services.batchService.hasCache(key);
  }

  /**
   * Delete cache entry
   *
   * @param key - Cache key
   * @returns True if deleted, false if not found
   */
  delete(key: string): boolean {
    if (!this.services.batchService) {
      throw new Error('Batch service (cache) not configured.');
    }
    return this.services.batchService.deleteCache(key);
  }

  /**
   * Clear all cache entries
   */
  clear(): void {
    if (!this.services.batchService) {
      throw new Error('Batch service (cache) not configured.');
    }
    this.services.batchService.clearCache();
  }

  /**
   * Get cache statistics
   *
   * @returns Cache statistics
   */
  stats(): CacheStats {
    if (!this.services.batchService) {
      throw new Error('Batch service (cache) not configured.');
    }
    return this.services.batchService.getCacheStats();
  }
}

// ============================================================================
// Storage Namespace
// ============================================================================

/**
 * Storage Namespace - Unified Storage Operations
 *
 * Consolidates Walrus blob storage and in-memory caching.
 *
 * @example
 * ```typescript
 * // Upload to Walrus
 * const result = await pdw.storage.upload(data);
 * console.log('Blob ID:', result.blobId);
 *
 * // Download from Walrus
 * const data = await pdw.storage.download(blobId);
 *
 * // Use cache
 * pdw.storage.cache.set('key', value, 60000);
 * const cached = pdw.storage.cache.get('key');
 * ```
 */
export class StorageNamespace {
  private _cache: CacheSubNamespace;

  constructor(private services: ServiceContainer) {
    this._cache = new CacheSubNamespace(services);
  }

  /**
   * Cache operations
   */
  get cache(): CacheSubNamespace {
    return this._cache;
  }

  // ==========================================================================
  // Walrus Storage Operations
  // ==========================================================================

  /**
   * Upload data to Walrus
   *
   * @param data - Data to upload (string, Uint8Array, or object)
   * @param options - Upload options
   * @returns Upload result with blob ID
   *
   * @example
   * ```typescript
   * // Upload raw bytes
   * const result = await pdw.storage.upload(new Uint8Array([1, 2, 3]));
   *
   * // Upload JSON
   * const result = await pdw.storage.upload({ name: 'test' });
   *
   * // Upload with options
   * const result = await pdw.storage.upload(data, { encrypt: true });
   * ```
   */
  async upload(data: string | Uint8Array | object, options: UploadOptions = {}): Promise<UploadResult> {
    if (!this.services.storage) {
      throw new Error('Storage service not configured.');
    }

    // Convert data to Uint8Array
    let bytes: Uint8Array;
    let contentType = options.contentType || 'application/octet-stream';

    if (typeof data === 'string') {
      bytes = new TextEncoder().encode(data);
      contentType = options.contentType || 'text/plain';
    } else if (data instanceof Uint8Array) {
      bytes = data;
    } else {
      bytes = new TextEncoder().encode(JSON.stringify(data));
      contentType = options.contentType || 'application/json';
    }

    // Encrypt if requested
    if (options.encrypt && this.services.encryption) {
      const encryptResult = await this.services.encryption.encrypt(
        bytes,
        this.services.config.userAddress,
        2
      );
      bytes = encryptResult.encryptedObject;
    }

    // Upload to Walrus using uploadBlob method
    const result = await this.services.storage.uploadBlob(bytes, {
      signer: this.services.config.signer.getSigner(),
      epochs: options.epochs,
      deletable: true
    });

    return {
      blobId: result.blobId,
      size: bytes.length,
      contentType
    };
  }

  /**
   * Download data from Walrus
   *
   * @param blobId - Blob ID to download
   * @returns Raw data as Uint8Array
   *
   * @example
   * ```typescript
   * const data = await pdw.storage.download('blobId123');
   * const text = new TextDecoder().decode(data);
   * ```
   */
  async download(blobId: string): Promise<Uint8Array> {
    if (!this.services.storage) {
      throw new Error('Storage service not configured.');
    }

    // Use retrieveFromWalrusOnly which returns { content, metadata }
    const result = await this.services.storage.retrieveFromWalrusOnly(blobId);
    return result.content;
  }

  /**
   * Download and parse JSON from Walrus
   *
   * @param blobId - Blob ID to download
   * @returns Parsed JSON object
   *
   * @example
   * ```typescript
   * const data = await pdw.storage.downloadJson<MyType>('blobId123');
   * ```
   */
  async downloadJson<T = any>(blobId: string): Promise<T> {
    const bytes = await this.download(blobId);
    const text = new TextDecoder().decode(bytes);
    return JSON.parse(text);
  }

  /**
   * Download and decrypt data from Walrus
   *
   * @param blobId - Blob ID to download
   * @param options - Decryption options
   * @returns Decrypted data
   *
   * @example
   * ```typescript
   * const data = await pdw.storage.downloadDecrypted('blobId123');
   * ```
   */
  async downloadDecrypted(blobId: string, options?: {
    memoryCapId?: string;
    keyId?: Uint8Array;
  }): Promise<Uint8Array> {
    if (!this.services.storage) {
      throw new Error('Storage service not configured.');
    }
    if (!this.services.encryption) {
      throw new Error('Encryption service not configured.');
    }

    const encryptedData = await this.download(blobId);

    return await this.services.encryption.decrypt({
      encryptedContent: encryptedData,
      userAddress: this.services.config.userAddress,
      requestingWallet: this.services.config.userAddress,
      memoryCapId: options?.memoryCapId,
      keyId: options?.keyId
    });
  }

  /**
   * Store memory package to Walrus
   *
   * Higher-level method that stores a complete memory package.
   *
   * @param memoryPackage - Memory package to store
   * @returns Upload result
   */
  async storeMemoryPackage(memoryPackage: MemoryPackage): Promise<UploadResult> {
    if (!this.services.storage) {
      throw new Error('Storage service not configured.');
    }

    // Use uploadMemoryPackage method
    const result = await this.services.storage.uploadMemoryPackage(
      {
        content: memoryPackage.content,
        embedding: memoryPackage.embedding || [],
        metadata: memoryPackage.metadata || {},
        identity: this.services.config.userAddress
      },
      {
        signer: this.services.config.signer.getSigner(),
        epochs: 3,
        deletable: true
      }
    );

    return {
      blobId: result.blobId,
      size: 0, // Size not returned by uploadMemoryPackage
      contentType: 'application/json'
    };
  }

  /**
   * Retrieve memory package from Walrus
   *
   * @param blobId - Blob ID of the memory package
   * @returns Retrieved memory package with decrypted content
   */
  async retrieveMemoryPackage(blobId: string): Promise<{
    memoryPackage: MemoryPackage | null;
    decryptionStatus: 'success' | 'failed' | 'not_encrypted';
  }> {
    if (!this.services.storage) {
      throw new Error('Storage service not configured.');
    }

    const result = await this.services.storage.retrieveMemoryPackage(blobId);

    // Map to expected return type
    return {
      memoryPackage: result.memoryPackage ? {
        content: result.memoryPackage.content,
        contentType: result.memoryPackage.contentType || 'text/plain',
        metadata: result.memoryPackage.metadata,
        embedding: result.memoryPackage.embedding,
        createdAt: result.memoryPackage.timestamp
      } : null,
      decryptionStatus: result.isEncrypted
        ? (result.memoryPackage ? 'success' : 'failed')
        : 'not_encrypted'
    };
  }

  /**
   * Check if blob exists on Walrus
   *
   * @param blobId - Blob ID to check
   * @returns True if blob exists
   */
  async exists(blobId: string): Promise<boolean> {
    try {
      await this.download(blobId);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Get metadata for a blob
   *
   * @param blobId - Blob ID
   * @returns Blob metadata or null
   */
  async getMetadata(blobId: string): Promise<{
    blobId: string;
    size?: number;
    exists: boolean;
  }> {
    try {
      const data = await this.download(blobId);
      return {
        blobId,
        size: data.length,
        exists: true
      };
    } catch {
      return {
        blobId,
        exists: false
      };
    }
  }
}
