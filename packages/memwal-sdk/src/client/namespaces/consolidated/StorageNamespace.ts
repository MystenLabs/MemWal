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
      signer: this.services.config.signer,
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
   * Automatically encrypts content if encryption is enabled in config.
   *
   * @param memoryPackage - Memory package to store
   * @returns Upload result
   */
  async storeMemoryPackage(memoryPackage: MemoryPackage): Promise<UploadResult> {
    if (!this.services.storage) {
      throw new Error('Storage service not configured.');
    }

    // Check if encryption is enabled
    const encryptionEnabled = this.services.config.features?.enableEncryption ?? true;
    let encryptedContent: Uint8Array | undefined;
    let encryptedEmbedding: Uint8Array | undefined;  // Option A v2: encrypted embedding
    let encryptionType: string | undefined;
    let memoryCapId: string | undefined;
    let keyId: string | undefined;

    console.log('🔍 Encryption check:', {
      encryptionEnabled,
      hasEncryptionService: !!this.services.encryption,
      hasCapabilityService: !!this.services.capability,
      configFeatures: this.services.config.features
    });

    if (encryptionEnabled && this.services.encryption && this.services.capability) {
      console.log('🔒 Encrypting memory package with SEAL (capability-based)...');

      try {
        // Step 1: Get or create capability for this app context
        const category = memoryPackage.metadata?.category || 'general';
        console.log(`🔐 Getting/creating capability for category: ${category}`);

        const cap = await this.services.capability.getOrCreate(
          {
            appId: category,
            userAddress: this.services.config.userAddress
          },
          this.services.config.signer
        );

        memoryCapId = cap.id;
        console.log(`✅ Capability ready: ${memoryCapId}`);

        // Step 2: Compute key_id from capability (keccak256(owner || nonce))
        keyId = this.services.capability.computeKeyId(cap);
        console.log(`🔑 Key ID computed: ${keyId.substring(0, 20)}...`);

        // Step 3: Encrypt the content using key_id as SEAL identity
        const contentBytes = new TextEncoder().encode(memoryPackage.content);
        const encryptResult = await this.services.encryption.encrypt(
          contentBytes,
          keyId, // Use key_id from capability as SEAL identity!
          2 // threshold: 2 of 2 key servers
        );

        encryptedContent = encryptResult.encryptedObject;
        encryptionType = 'seal-capability';

        console.log(`✅ Content encrypted: ${contentBytes.length} bytes → ${encryptedContent?.length || 0} bytes`);

        // Step 4: Also encrypt the embedding for fast index rebuild (Option A v2)
        const embeddingToEncrypt = memoryPackage.embedding && memoryPackage.embedding.length > 0
          ? memoryPackage.embedding
          : (memoryPackage.metadata?.embedding || []);

        if (embeddingToEncrypt.length > 0) {
          const embeddingBytes = new TextEncoder().encode(JSON.stringify(embeddingToEncrypt));
          const encryptEmbeddingResult = await this.services.encryption.encrypt(
            embeddingBytes,
            keyId,
            2
          );
          encryptedEmbedding = encryptEmbeddingResult.encryptedObject;
          console.log(`✅ Embedding encrypted: ${embeddingToEncrypt.length}D → ${encryptedEmbedding?.length || 0} bytes`);
        }

        console.log(`   Using capability: ${memoryCapId}`);
        console.log(`   Key ID: ${keyId.substring(0, 20)}...`);
      } catch (encryptError) {
        console.error('❌ Encryption failed:', encryptError);
        console.warn('⚠️ Falling back to plaintext storage');
        // Fall back to plaintext if encryption fails
      }
    } else {
      console.log('📝 Encryption disabled or services not available - storing plaintext');
    }

    // Include capability metadata for decryption
    const metadata = {
      ...memoryPackage.metadata,
      // Add capability info for decryption (CRITICAL for Option A!)
      ...(memoryCapId && keyId ? {
        memoryCapId,
        keyId,
        encryptionVersion: 'v2-capability' // Mark as new capability-based encryption
      } : {})
    };

    // Get embedding from root level (correct API) or metadata (legacy fallback)
    const rootEmbedding = memoryPackage.embedding && memoryPackage.embedding.length > 0;
    const metadataEmbedding = memoryPackage.metadata?.embedding && memoryPackage.metadata.embedding.length > 0;
    const embedding = rootEmbedding
      ? memoryPackage.embedding
      : (memoryPackage.metadata?.embedding || []);

    if (metadataEmbedding && !rootEmbedding) {
      console.warn('⚠️ Embedding in metadata (legacy) - should be at root level');
    }
    console.log(`📊 Embedding: ${embedding.length}D vector`);

    // Use uploadMemoryPackage method
    const result = await this.services.storage.uploadMemoryPackage(
      {
        content: memoryPackage.content,
        embedding,
        metadata,
        identity: this.services.config.userAddress,
        encryptedContent,    // Pass encrypted content if available
        encryptedEmbedding,  // Pass encrypted embedding for Option A v2
        encryptionType
      },
      {
        signer: this.services.config.signer,
        epochs: 3,
        deletable: true
      }
    );

    return {
      blobId: result.blobId,
      size: 0, // Size not returned by uploadMemoryPackage
      contentType: 'application/json',
      memoryCapId, // Return capability ID for reference
      keyId // Return key ID for reference
    } as UploadResult;
  }

  /**
   * Retrieve memory package from Walrus with optional decryption
   *
   * @param blobId - Blob ID of the memory package
   * @param decryptionContext - Optional context for decrypting SEAL-encrypted content
   * @returns Retrieved memory package with decrypted content
   *
   * @example
   * ```typescript
   * // Without decryption (returns encrypted data info)
   * const result = await pdw.storage.retrieveMemoryPackage(blobId);
   *
   * // With decryption
   * const result = await pdw.storage.retrieveMemoryPackage(blobId, {
   *   sessionKey,
   *   memoryCapId,
   *   keyId
   * });
   * ```
   */
  async retrieveMemoryPackage(
    blobId: string,
    decryptionContext?: {
      sessionKey: any;
      memoryCapId: string;
      keyId: Uint8Array;
    }
  ): Promise<{
    memoryPackage: MemoryPackage | null;
    decryptionStatus: 'success' | 'failed' | 'not_encrypted';
    error?: string;
  }> {
    if (!this.services.storage) {
      throw new Error('Storage service not configured.');
    }

    const result = await this.services.storage.retrieveMemoryPackage(blobId);

    // If not encrypted, return as-is
    if (!result.isEncrypted && result.memoryPackage) {
      return {
        memoryPackage: {
          content: result.memoryPackage.content,
          contentType: result.memoryPackage.contentType || 'text/plain',
          metadata: result.memoryPackage.metadata,
          embedding: result.memoryPackage.embedding,
          createdAt: result.memoryPackage.timestamp
        },
        decryptionStatus: 'not_encrypted'
      };
    }

    // v2.2 JSON package with encrypted content + encrypted embedding
    if (result.memoryPackage?.version === '2.2' && result.memoryPackage?.encryptedContent) {
      console.log('🔐 Detected v2.2 JSON package (Full Encryption - Content + Embedding)');

      const embeddingDimension = result.memoryPackage.metadata?.embeddingDimension || 0;
      console.log(`   embeddingDimension: ${embeddingDimension}D (encrypted on Walrus)`);

      // Return base package (content encrypted, embedding encrypted)
      const basePackage: MemoryPackage = {
        content: '[ENCRYPTED - requires decryption]',
        contentType: 'text/plain',
        metadata: result.memoryPackage.metadata,
        embedding: [], // Embedding is encrypted, needs decryption
        createdAt: result.memoryPackage.timestamp
      };

      if (decryptionContext && this.services.encryption) {
        try {
          console.log('🔐 Decrypting v2.2 content...');

          // Decrypt content
          const encryptedContentBase64 = result.memoryPackage.encryptedContent;
          const contentBinaryString = atob(encryptedContentBase64);
          const encryptedContentBytes = new Uint8Array(contentBinaryString.length);
          for (let i = 0; i < contentBinaryString.length; i++) {
            encryptedContentBytes[i] = contentBinaryString.charCodeAt(i);
          }

          const decryptedContentData = await this.services.encryption.decrypt({
            encryptedContent: encryptedContentBytes,
            userAddress: this.services.config.userAddress,
            sessionKey: decryptionContext.sessionKey,
            memoryCapId: decryptionContext.memoryCapId,
            keyId: decryptionContext.keyId
          });

          const decryptedContent = new TextDecoder().decode(decryptedContentData);
          console.log(`✅ v2.2 content decrypted: "${decryptedContent.substring(0, 50)}..."`);

          // Decrypt embedding if available
          let decryptedEmbedding: number[] = [];
          if (result.memoryPackage.encryptedEmbedding) {
            console.log('🔐 Decrypting v2.2 embedding...');
            const encryptedEmbeddingBase64 = result.memoryPackage.encryptedEmbedding;
            const embeddingBinaryString = atob(encryptedEmbeddingBase64);
            const encryptedEmbeddingBytes = new Uint8Array(embeddingBinaryString.length);
            for (let i = 0; i < embeddingBinaryString.length; i++) {
              encryptedEmbeddingBytes[i] = embeddingBinaryString.charCodeAt(i);
            }

            const decryptedEmbeddingData = await this.services.encryption.decrypt({
              encryptedContent: encryptedEmbeddingBytes,
              userAddress: this.services.config.userAddress,
              sessionKey: decryptionContext.sessionKey,
              memoryCapId: decryptionContext.memoryCapId,
              keyId: decryptionContext.keyId
            });

            const embeddingJson = new TextDecoder().decode(decryptedEmbeddingData);
            decryptedEmbedding = JSON.parse(embeddingJson);
            console.log(`✅ v2.2 embedding decrypted: ${decryptedEmbedding.length}D vector`);
          }

          return {
            memoryPackage: {
              ...basePackage,
              content: decryptedContent,
              embedding: decryptedEmbedding
            },
            decryptionStatus: 'success'
          };
        } catch (decryptError: any) {
          console.error('❌ v2.2 decryption failed:', decryptError.message);
          return {
            memoryPackage: basePackage,
            decryptionStatus: 'failed',
            error: decryptError.message
          };
        }
      }

      // No decryption context
      return {
        memoryPackage: basePackage,
        decryptionStatus: 'failed',
        error: 'No decryption context provided for v2.2 encrypted package'
      };
    }

    // v2.1 JSON package with encrypted content only (no embedding on Walrus)
    if (result.memoryPackage?.version === '2.1' && result.memoryPackage?.encryptedContent) {
      console.log('🔐 Detected v2.1 JSON package (Full Encryption - Content only)');

      const embeddingDimension = result.memoryPackage.metadata?.embeddingDimension || 0;
      console.log(`   embeddingDimension: ${embeddingDimension}D (stored locally, not on Walrus)`);

      const basePackage: MemoryPackage = {
        content: '[ENCRYPTED - requires decryption]',
        contentType: 'text/plain',
        metadata: result.memoryPackage.metadata,
        embedding: [], // v2.1 has no embedding on Walrus
        createdAt: result.memoryPackage.timestamp
      };

      if (decryptionContext && this.services.encryption) {
        try {
          console.log('🔐 Decrypting v2.1 content...');

          const encryptedBase64 = result.memoryPackage.encryptedContent;
          const binaryString = atob(encryptedBase64);
          const encryptedBytes = new Uint8Array(binaryString.length);
          for (let i = 0; i < binaryString.length; i++) {
            encryptedBytes[i] = binaryString.charCodeAt(i);
          }

          const decryptedData = await this.services.encryption.decrypt({
            encryptedContent: encryptedBytes,
            userAddress: this.services.config.userAddress,
            sessionKey: decryptionContext.sessionKey,
            memoryCapId: decryptionContext.memoryCapId,
            keyId: decryptionContext.keyId
          });

          const decryptedContent = new TextDecoder().decode(decryptedData);
          console.log(`✅ v2.1 decryption successful: "${decryptedContent.substring(0, 50)}..."`);

          return {
            memoryPackage: {
              ...basePackage,
              content: decryptedContent
            },
            decryptionStatus: 'success'
          };
        } catch (decryptError: any) {
          console.error('❌ v2.1 decryption failed:', decryptError.message);
          return {
            memoryPackage: basePackage,
            decryptionStatus: 'failed',
            error: decryptError.message
          };
        }
      }

      return {
        memoryPackage: basePackage,
        decryptionStatus: 'failed',
        error: 'No decryption context provided for v2.1 encrypted package'
      };
    }

    // v2.0 JSON package with encrypted content + plaintext embedding (legacy)
    if (result.memoryPackage?.version === '2.0' && result.memoryPackage?.encryptedContent) {
      console.log('📦 Detected v2.0 JSON package with encrypted content (legacy)');

      // Get embedding from root level OR metadata.embedding (fallback for encryption service bug)
      const embeddingArray = result.memoryPackage.embedding?.length > 0
        ? result.memoryPackage.embedding
        : result.memoryPackage.metadata?.embedding;

      const embeddingSource = result.memoryPackage.embedding?.length > 0 ? 'root' : 'metadata';
      console.log(`   embedding: ${embeddingArray?.length || 0}D (from ${embeddingSource})`);

      // Return embedding even without decryption (for index rebuilding)
      const basePackage: MemoryPackage = {
        content: '[ENCRYPTED - requires decryption]',
        contentType: 'text/plain',
        metadata: result.memoryPackage.metadata,
        embedding: embeddingArray,  // Plaintext embedding available!
        createdAt: result.memoryPackage.timestamp
      };

      if (decryptionContext && this.services.encryption) {
        try {
          console.log('🔐 Decrypting v2.0 encryptedContent...');

          // Convert base64 back to Uint8Array
          const encryptedBase64 = result.memoryPackage.encryptedContent;
          const binaryString = atob(encryptedBase64);
          const encryptedBytes = new Uint8Array(binaryString.length);
          for (let i = 0; i < binaryString.length; i++) {
            encryptedBytes[i] = binaryString.charCodeAt(i);
          }

          const decryptedData = await this.services.encryption.decrypt({
            encryptedContent: encryptedBytes,
            userAddress: this.services.config.userAddress,
            sessionKey: decryptionContext.sessionKey,
            memoryCapId: decryptionContext.memoryCapId,
            keyId: decryptionContext.keyId
          });

          const decryptedContent = new TextDecoder().decode(decryptedData);
          console.log(`✅ v2.0 decryption successful, content: "${decryptedContent.substring(0, 50)}..."`);

          return {
            memoryPackage: {
              ...basePackage,
              content: decryptedContent
            },
            decryptionStatus: 'success'
          };
        } catch (decryptError: any) {
          console.error('❌ v2.0 decryption failed:', decryptError.message);
          return {
            memoryPackage: basePackage,  // Return with embedding but encrypted content
            decryptionStatus: 'failed',
            error: decryptError.message
          };
        }
      }

      // No decryption context - return with embedding only
      return {
        memoryPackage: basePackage,
        decryptionStatus: 'failed',
        error: 'No decryption context provided (embedding still available)'
      };
    }

    // Legacy binary format (v0) - try to decrypt if context provided
    if (decryptionContext && this.services.encryption) {
      try {
        console.log('🔐 Decrypting legacy binary format...');

        const decryptedData = await this.services.encryption.decrypt({
          encryptedContent: result.content,
          userAddress: this.services.config.userAddress,
          sessionKey: decryptionContext.sessionKey,
          memoryCapId: decryptionContext.memoryCapId,
          keyId: decryptionContext.keyId
        });

        const decryptedContent = new TextDecoder().decode(decryptedData);
        console.log(`✅ Legacy decryption successful, content length: ${decryptedContent.length}`);

        return {
          memoryPackage: {
            content: decryptedContent,
            contentType: 'text/plain',
            metadata: result.metadata,
            createdAt: result.metadata.createdTimestamp
          },
          decryptionStatus: 'success'
        };
      } catch (decryptError: any) {
        console.error('❌ Legacy decryption failed:', decryptError.message);
        return {
          memoryPackage: null,
          decryptionStatus: 'failed',
          error: decryptError.message
        };
      }
    }

    // Encrypted but no decryption context provided
    return {
      memoryPackage: null,
      decryptionStatus: 'failed',
      error: 'Content is encrypted but no decryption context provided'
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

  // ==========================================================================
  // High-Level Decrypt API
  // ==========================================================================

  /**
   * Retrieve and decrypt a memory package with minimal boilerplate.
   * SDK handles all version detection, format conversion, and decryption internally.
   *
   * @param blobId - Blob ID on Walrus
   * @param options - Decryption options
   * @returns Decrypted content, embedding, and metadata
   *
   * @example
   * ```typescript
   * // With sign function (SDK creates session key)
   * const result = await pdw.storage.retrieveAndDecrypt(blobId, {
   *   signFn: async (message) => {
   *     const sig = await signPersonalMessage({ message: new TextEncoder().encode(message) });
   *     return { signature: sig.signature };
   *   }
   * });
   *
   * // With existing session key
   * const result = await pdw.storage.retrieveAndDecrypt(blobId, { sessionKey });
   *
   * console.log(result.content);     // "my name is Aaron"
   * console.log(result.embedding);   // [0.12, -0.34, ...] (3072D)
   * console.log(result.version);     // "2.2"
   * ```
   */
  async retrieveAndDecrypt(
    blobId: string,
    options: {
      /** Function to sign personal message (SDK will create session key) */
      signFn?: (message: string) => Promise<{ signature: string }>;
      /** Existing session key (skip signing if provided) */
      sessionKey?: any;
      /** Override memoryCapId (auto-detected from metadata if not provided) */
      memoryCapId?: string;
      /** Override keyId hex string (auto-detected from metadata if not provided) */
      keyId?: string;
    } = {}
  ): Promise<{
    content: string;
    embedding: number[];
    version: '2.2' | '2.1' | '2.0' | 'legacy' | 'plaintext';
    isEncrypted: boolean;
    metadata: Record<string, any>;
    blobId: string;
  }> {
    if (!this.services.storage) {
      throw new Error('Storage service not configured.');
    }

    console.log(`🔐 retrieveAndDecrypt: Downloading blob ${blobId}...`);

    // Step 1: Download blob from Walrus
    const blobData = await this.download(blobId);
    console.log(`   Downloaded ${blobData.length} bytes`);

    // Step 2: Detect format and parse
    let version: '2.2' | '2.1' | '2.0' | 'legacy' | 'plaintext' = 'legacy';
    let isEncrypted = false;
    let encryptedContentBase64: string | null = null;
    let encryptedEmbeddingBase64: string | null = null;
    let metadata: Record<string, any> = {};
    let plainEmbedding: number[] = [];

    try {
      const blobText = new TextDecoder().decode(blobData);
      const parsed = JSON.parse(blobText);

      // v2.2: Full encryption (content + embedding both encrypted)
      if (parsed.version === '2.2' && parsed.encryptedContent) {
        version = '2.2';
        isEncrypted = true;
        encryptedContentBase64 = parsed.encryptedContent;
        encryptedEmbeddingBase64 = parsed.encryptedEmbedding || null;
        metadata = parsed.metadata || {};
        console.log(`   Detected v2.2: encrypted content + encrypted embedding`);
      }
      // v2.1: Encrypted content only (no embedding on Walrus)
      else if (parsed.version === '2.1' && parsed.encryptedContent) {
        version = '2.1';
        isEncrypted = true;
        encryptedContentBase64 = parsed.encryptedContent;
        metadata = parsed.metadata || {};
        console.log(`   Detected v2.1: encrypted content only`);
      }
      // v2.0: Encrypted content + plaintext embedding
      else if (parsed.version === '2.0' && parsed.encryptedContent) {
        version = '2.0';
        isEncrypted = true;
        encryptedContentBase64 = parsed.encryptedContent;
        plainEmbedding = parsed.embedding || [];
        metadata = parsed.metadata || {};
        console.log(`   Detected v2.0: encrypted content + ${plainEmbedding.length}D plaintext embedding`);
      }
      // v1.0: Plaintext JSON package
      else if (parsed.version && parsed.content) {
        version = 'plaintext';
        isEncrypted = false;
        metadata = parsed.metadata || {};
        plainEmbedding = parsed.embedding || [];
        console.log(`   Detected plaintext JSON package`);
        return {
          content: parsed.content,
          embedding: plainEmbedding,
          version,
          isEncrypted,
          metadata,
          blobId
        };
      }
    } catch {
      // Not JSON - check if binary SEAL data
      const isBinary = blobData.some(byte => byte < 32 && byte !== 9 && byte !== 10 && byte !== 13);
      if (isBinary || blobData.some(byte => byte > 127)) {
        version = 'legacy';
        isEncrypted = true;
        console.log(`   Detected legacy binary format`);
      } else {
        // Plain text content
        version = 'plaintext';
        isEncrypted = false;
        console.log(`   Detected plaintext content`);
        return {
          content: new TextDecoder().decode(blobData),
          embedding: [],
          version,
          isEncrypted,
          metadata: {},
          blobId
        };
      }
    }

    // Step 3: If not encrypted, return as-is
    if (!isEncrypted) {
      return {
        content: new TextDecoder().decode(blobData),
        embedding: plainEmbedding,
        version,
        isEncrypted,
        metadata,
        blobId
      };
    }

    // Step 4: Get decryption parameters (from options or metadata)
    const memoryCapId = options.memoryCapId || metadata.memoryCapId;
    const keyIdHex = options.keyId || metadata.keyId;

    if (!memoryCapId || !keyIdHex) {
      throw new Error(
        `Missing decryption parameters. memoryCapId=${!!memoryCapId}, keyId=${!!keyIdHex}. ` +
        `Provide via options or ensure metadata contains these values.`
      );
    }

    // Step 5: Convert keyId hex string to Uint8Array (SDK handles this!)
    const keyIdBytes = new Uint8Array(
      (keyIdHex.startsWith('0x') ? keyIdHex.slice(2) : keyIdHex)
        .match(/.{1,2}/g)!
        .map((byte: string) => parseInt(byte, 16))
    );

    // Step 6: Get or create session key
    let sessionKey = options.sessionKey;
    if (!sessionKey) {
      if (!options.signFn) {
        throw new Error(
          'Decryption requires either sessionKey or signFn. ' +
          'Provide signFn to create session key automatically.'
        );
      }
      if (!this.services.encryption) {
        throw new Error('Encryption service not configured.');
      }

      console.log(`   Creating session key (will prompt for signature)...`);
      sessionKey = await this.services.encryption.createSessionKey(
        this.services.config.userAddress,
        {
          signPersonalMessageFn: async (message: string) => {
            return options.signFn!(message);
          }
        }
      );
      console.log(`   Session key created`);
    }

    // Step 7: Decrypt content
    console.log(`   Decrypting content...`);

    // Convert base64 to Uint8Array if needed
    let dataToDecrypt: Uint8Array;
    if (encryptedContentBase64) {
      const binaryString = atob(encryptedContentBase64);
      dataToDecrypt = new Uint8Array(binaryString.length);
      for (let i = 0; i < binaryString.length; i++) {
        dataToDecrypt[i] = binaryString.charCodeAt(i);
      }
    } else {
      dataToDecrypt = blobData;
    }

    const decryptedContentData = await this.services.encryption!.decrypt({
      encryptedContent: dataToDecrypt,
      userAddress: this.services.config.userAddress,
      sessionKey,
      memoryCapId,
      keyId: keyIdBytes
    });

    const content = new TextDecoder().decode(decryptedContentData);
    console.log(`   Content decrypted: "${content.substring(0, 50)}${content.length > 50 ? '...' : ''}"`);

    // Step 8: Decrypt embedding if v2.2
    let embedding: number[] = plainEmbedding;

    if (version === '2.2' && encryptedEmbeddingBase64) {
      console.log(`   Decrypting embedding...`);
      const embeddingBinaryString = atob(encryptedEmbeddingBase64);
      const encryptedEmbeddingBytes = new Uint8Array(embeddingBinaryString.length);
      for (let i = 0; i < embeddingBinaryString.length; i++) {
        encryptedEmbeddingBytes[i] = embeddingBinaryString.charCodeAt(i);
      }

      const decryptedEmbeddingData = await this.services.encryption!.decrypt({
        encryptedContent: encryptedEmbeddingBytes,
        userAddress: this.services.config.userAddress,
        sessionKey,
        memoryCapId,
        keyId: keyIdBytes
      });

      const embeddingJson = new TextDecoder().decode(decryptedEmbeddingData);
      embedding = JSON.parse(embeddingJson);
      console.log(`   Embedding decrypted: ${embedding.length}D vector`);
    }

    console.log(`✅ retrieveAndDecrypt complete: ${content.length} chars, ${embedding.length}D embedding`);

    return {
      content,
      embedding,
      version,
      isEncrypted,
      metadata,
      blobId
    };
  }

  // ==========================================================================
  // Batch Operations (Quilt)
  // ==========================================================================

  /**
   * Upload multiple memories as a Quilt (batch upload)
   *
   * Uses Walrus Quilt for ~90% gas savings compared to individual uploads.
   * Requires 2 user signatures:
   * - Transaction 1: Register blob on-chain
   * - Transaction 2: Certify upload on-chain
   *
   * @param memories - Array of memories to upload
   * @param options - Upload options including signer
   * @returns Quilt result with file mappings
   *
   * @example
   * ```typescript
   * const result = await pdw.storage.uploadMemoryBatch(
   *   memories,
   *   {
   *     signer: pdw.getConfig().signer,
   *     epochs: 3,
   *     userAddress: pdw.getConfig().userAddress
   *   }
   * );
   * console.log(`Uploaded ${result.files.length} files`);
   * ```
   */
  async uploadMemoryBatch(
    memories: Array<{
      content: string;
      category: string;
      importance: number;
      topic: string;
      embedding: number[];
      encryptedContent: Uint8Array;
      summary?: string;
      id?: string;
    }>,
    options: {
      signer: any; // UnifiedSigner
      epochs?: number;
      userAddress: string;
    }
  ): Promise<{
    quiltId: string;
    files: Array<{ identifier: string; blobId: string }>;
    uploadTimeMs: number;
  }> {
    if (!this.services.storage) {
      throw new Error('Storage service not configured.');
    }

    return this.services.storage.uploadMemoryBatch(memories, options);
  }
}
