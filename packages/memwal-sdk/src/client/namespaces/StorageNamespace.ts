/**
 * Storage Namespace - Direct Walrus Storage Operations
 *
 * Simple wrapper around StorageService for direct Walrus access.
 * Delegates to existing storage managers:
 * - WalrusStorageManager (upload/download)
 * - QuiltBatchManager (batch operations)
 * - WalrusMetadataManager (metadata)
 * - BlobAttributesManager (dynamic fields)
 *
 * @module client/namespaces
 */

import type { ServiceContainer } from '../SimplePDWClient';

/**
 * Upload result
 */
export interface UploadResult {
  blobId: string;
  size: number;
  contentType?: string;
  metadata?: Record<string, any>;
}

/**
 * Quilt result (batch upload)
 */
export interface QuiltResult {
  quiltId: string;
  files: Array<{
    name: string;
    blobId: string;
    size: number;
  }>;
  totalSize: number;
}

/**
 * Blob metadata
 */
export interface BlobMetadata {
  [key: string]: string | number | boolean;
}

/**
 * File for batch upload
 */
export interface FileUpload {
  name: string;
  data: Uint8Array;
  contentType?: string;
}

/**
 * Storage statistics
 */
export interface StorageStats {
  totalBlobs: number;
  totalSize: number;
  blobsByCategory: Record<string, number>;
}

/**
 * Storage Namespace
 *
 * Handles direct Walrus storage operations
 */
export class StorageNamespace {
  constructor(private services: ServiceContainer) {}

  /**
   * Upload data to Walrus
   *
   * Delegates to StorageService.uploadBlob() (WalrusStorageManager)
   *
   * @param data - Data bytes to upload
   * @param metadata - Optional metadata
   * @returns Upload result with blob ID
   *
   * @example
   * ```typescript
   * const data = new TextEncoder().encode('Hello world');
   * const result = await pdw.storage.upload(data, {
   *   contentType: 'text/plain',
   *   category: 'document'
   * });
   * ```
   */
  async upload(data: Uint8Array, metadata?: BlobMetadata): Promise<UploadResult> {
    try {
      // Delegate to StorageService (uses WalrusStorageManager internally)
      const result = await this.services.storage.uploadBlob(
        data,
        {
          signer: this.services.config.signer,
          epochs: 3,
          deletable: true,
          metadata: metadata as any
        }
      );

      return {
        blobId: result.blobId,
        size: data.length,
        metadata
      };
    } catch (error) {
      throw new Error(`Upload failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * Download data from Walrus
   *
   * @param blobId - Blob ID to download
   * @returns Data bytes
   */
  async download(blobId: string): Promise<Uint8Array> {
    try {
      const result = await this.services.storage.retrieve(blobId);

      if (result instanceof Uint8Array) {
        return result;
      }

      // Convert string to Uint8Array if needed
      if (typeof result === 'string') {
        return new TextEncoder().encode(result);
      }

      throw new Error('Unexpected blob format');
    } catch (error) {
      throw new Error(`Download failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * Delete a blob (soft delete)
   *
   * Walrus blobs are immutable and cannot be truly deleted.
   * This marks the blob as deleted by setting a `deleted_at` attribute on-chain.
   * The blob data remains on Walrus but will be filtered out in queries.
   *
   * @param blobId - Blob ID to mark as deleted
   */
  async delete(blobId: string): Promise<void> {
    try {
      if (!blobId) {
        throw new Error('Blob ID is required');
      }

      // Mark as deleted by setting deleted_at attribute
      // This is a soft delete - the blob remains on Walrus but is marked as deleted
      await this.services.storage.updateBlobAttributes(
        blobId,
        {
          deleted_at: new Date().toISOString(),
          deleted_by: this.services.config.userAddress
        },
        this.services.config.signer
      );

      console.log(`Blob ${blobId} marked as deleted`);
    } catch (error) {
      throw new Error(`Delete failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * Upload multiple files as a Quilt (batch)
   *
   * @param files - Array of files to upload
   * @returns Quilt result with file mappings
   */
  async uploadBatch(files: FileUpload[]): Promise<QuiltResult> {
    try {
      // Use uploadMemoryBatch (StorageService has this, not uploadQuilt)
      const memories = files.map(f => ({
        content: new TextDecoder().decode(f.data),
        category: 'general',
        importance: 5,
        topic: f.name,
        embedding: [] as number[],
        encryptedContent: f.data,  // Use file data as encrypted content
        summary: ''
      }));

      const result = await this.services.storage.uploadMemoryBatch(
        memories,
        {
          signer: this.services.config.signer,
          epochs: 3,
          userAddress: this.services.config.userAddress
        }
      );

      return {
        quiltId: result.quiltId,
        files: result.files.map((f: any) => ({
          name: f.identifier,
          blobId: f.blobId,
          size: 0  // Size not available in result
        })),
        totalSize: files.reduce((sum, f) => sum + f.data.length, 0)
      };
    } catch (error) {
      throw new Error(`Batch upload failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * Download multiple files from a Quilt
   *
   * Retrieves all WalrusFiles from a quilt and downloads their content.
   * File names are extracted from identifiers or tags.
   *
   * @param quiltId - Quilt ID
   * @returns Array of files with name and data
   */
  async downloadBatch(quiltId: string): Promise<Array<{ name: string; data: Uint8Array }>> {
    try {
      if (!quiltId) {
        throw new Error('Quilt ID is required');
      }

      // Get all WalrusFile objects from quilt
      const files = await this.services.storage.getQuiltFiles(quiltId);

      if (!files || files.length === 0) {
        console.warn(`No files found in quilt ${quiltId}`);
        return [];
      }

      // Download each file in parallel
      const results = await Promise.all(
        files.map(async (file: any, index: number) => {
          try {
            // Extract name from identifier or tags
            let name = `file-${index}`;

            // Try to get identifier (filename)
            if (typeof file.getIdentifier === 'function') {
              const identifier = file.getIdentifier();
              if (identifier) {
                name = identifier;
              }
            }

            // Try to get name from tags as fallback
            if (name === `file-${index}` && typeof file.getTags === 'function') {
              const tags = await file.getTags();
              if (tags?.topic) {
                name = tags.topic;
              }
            }

            // Get blob content - WalrusFile should have blob reference
            let data: Uint8Array;

            // Try to read content directly from file if available
            if (typeof file.read === 'function') {
              data = await file.read();
            } else if (file.blobId) {
              // Fallback: retrieve via blobId
              const result = await this.services.storage.retrieve(file.blobId);
              data = result instanceof Uint8Array ? result : new TextEncoder().encode(String(result));
            } else if (file.contents) {
              // Direct contents access
              data = file.contents instanceof Uint8Array
                ? file.contents
                : new TextEncoder().encode(String(file.contents));
            } else {
              throw new Error(`Cannot extract content from file at index ${index}`);
            }

            return { name, data };
          } catch (fileError) {
            console.warn(`Failed to download file at index ${index}:`, fileError);
            // Return empty data for failed files instead of throwing
            return { name: `file-${index}-error`, data: new Uint8Array(0) };
          }
        })
      );

      // Filter out failed downloads (empty data)
      return results.filter(r => r.data.length > 0);
    } catch (error) {
      throw new Error(`Batch download failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * Set metadata for a blob
   *
   * @param blobId - Blob ID
   * @param metadata - Metadata to attach
   */
  async setMetadata(blobId: string, metadata: BlobMetadata): Promise<void> {
    try {
      // Use attachMetadataToBlob (correct method name)
      await this.services.storage.attachMetadataToBlob(
        blobId,
        metadata as any,
        this.services.config.signer
      );
    } catch (error) {
      throw new Error(`Set metadata failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * Get metadata for a blob
   *
   * @param blobId - Blob ID
   * @returns Blob metadata
   */
  async getMetadata(blobId: string): Promise<BlobMetadata> {
    try {
      // Use retrieveBlobMetadata (correct method name)
      const metadata = await this.services.storage.retrieveBlobMetadata(blobId);
      return metadata as BlobMetadata;
    } catch (error) {
      throw new Error(`Get metadata failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * List blobs for user
   *
   * @param filter - Optional filter
   * @returns Array of blob info
   */
  async listBlobs(filter?: { category?: string; limit?: number }): Promise<Array<{ blobId: string; metadata: BlobMetadata }>> {
    try {
      // Use searchByMetadata
      const results = await this.services.storage.searchByMetadata(
        this.services.config.userAddress,
        {} // MetadataSearchQuery - minimal params
      );

      return results.map((r: any) => ({
        blobId: r.blobId,
        metadata: r.metadata || {}
      }));
    } catch (error) {
      throw new Error(`List blobs failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * Get storage statistics
   *
   * Calculates total size from blob metadata (content_size field).
   *
   * @returns Storage stats
   */
  async getStats(): Promise<StorageStats> {
    try {
      // Get all blobs
      const blobs = await this.listBlobs({ limit: 1000 });

      const stats: StorageStats = {
        totalBlobs: blobs.length,
        totalSize: 0,
        blobsByCategory: {}
      };

      // Count by category and accumulate size
      blobs.forEach(b => {
        const category = b.metadata.category as string || 'general';
        stats.blobsByCategory[category] = (stats.blobsByCategory[category] || 0) + 1;

        // Sum up content sizes from metadata
        const size = Number(b.metadata.content_size || b.metadata.contentSize || b.metadata.size || 0);
        if (!isNaN(size)) {
          stats.totalSize += size;
        }
      });

      return stats;
    } catch (error) {
      throw new Error(`Get storage stats failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * Cleanup old or unused blobs
   *
   * Marks blobs as deleted if they meet cleanup criteria:
   * - Already marked as deleted (removes from active queries)
   * - Low importance and old (optional aggressive cleanup)
   *
   * Note: Walrus blobs cannot be truly deleted. This marks them
   * as deleted via attributes for filtering in queries.
   *
   * @param options - Cleanup options
   * @returns Number of blobs marked for cleanup
   */
  async cleanup(options?: {
    /** Remove blobs already marked as deleted from listings */
    removeDeleted?: boolean;
    /** Mark old, low-importance blobs as deleted */
    aggressiveCleanup?: boolean;
    /** Max age in days for aggressive cleanup (default: 90) */
    maxAgeDays?: number;
    /** Max importance for aggressive cleanup (default: 3) */
    maxImportance?: number;
  }): Promise<number> {
    try {
      const {
        removeDeleted = true,
        aggressiveCleanup = false,
        maxAgeDays = 90,
        maxImportance = 3
      } = options || {};

      let cleanedCount = 0;
      const blobs = await this.listBlobs({ limit: 1000 });

      for (const blob of blobs) {
        try {
          const metadata = blob.metadata;

          // Skip if already processed
          if (metadata.deleted_at) {
            continue;
          }

          // Aggressive cleanup: mark old, low-importance blobs
          if (aggressiveCleanup) {
            const importance = Number(metadata.importance) || 5;
            const createdAt = metadata.created_at
              ? new Date(metadata.created_at as string).getTime()
              : Date.now();
            const ageInDays = (Date.now() - createdAt) / (1000 * 60 * 60 * 24);

            if (importance <= maxImportance && ageInDays >= maxAgeDays) {
              await this.delete(blob.blobId);
              cleanedCount++;
              console.log(`Cleaned up old blob ${blob.blobId} (age: ${ageInDays.toFixed(0)} days, importance: ${importance})`);
            }
          }
        } catch (blobError) {
          console.warn(`Failed to process blob ${blob.blobId} during cleanup:`, blobError);
        }
      }

      if (cleanedCount > 0) {
        console.log(`Storage cleanup completed: ${cleanedCount} blobs marked for cleanup`);
      }

      return cleanedCount;
    } catch (error) {
      throw new Error(`Cleanup failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}
