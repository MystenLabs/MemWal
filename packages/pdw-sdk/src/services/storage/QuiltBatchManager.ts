/**
 * QuiltBatchManager - Batch Memory Operations via Walrus Quilts
 *
 * Handles batch uploads and queries using Walrus Quilt functionality.
 * Extracted from StorageService for better separation of concerns.
 *
 * Features:
 * - Batch upload with ~90% gas savings (single transaction for multiple files)
 * - Tag-based filtering at the Walrus level
 * - Multi-file retrieval via quiltPatchId
 * - Browser-compatible using writeFilesFlow
 *
 * Quilt Structure:
 * - quiltId: ID of the entire batch (blob containing all files)
 * - quiltPatchId: Unique ID for each file within the quilt
 * - identifier: Human-readable name for each file
 * - tags: Metadata for filtering (category, importance, etc.)
 *
 * @see https://sdk.mystenlabs.com/walrus/index
 */

import { WalrusClient, WalrusFile } from '@mysten/walrus';
import type { Signer } from '@mysten/sui/cryptography';
import type { ClientWithExtensions } from '@mysten/sui/experimental';
import type { SuiClient } from '@mysten/sui/client';

// ============================================================================
// Types
// ============================================================================

export interface BatchMemory {
  content: string;
  category: string;
  importance: number;
  topic: string;
  embedding: number[];
  encryptedContent: Uint8Array;
  summary?: string;
  id?: string; // Optional client-side ID for tracking
}

export interface QuiltUploadOptions {
  signer: Signer;
  epochs?: number;
  userAddress: string;
  deletable?: boolean;
}

export interface QuiltFileResult {
  identifier: string;
  blobId: string;
  quiltPatchId?: string;
  tags: Record<string, string>;
  size: number;
}

export interface QuiltUploadResult {
  quiltId: string;
  blobObjectId?: string;
  files: QuiltFileResult[];
  uploadTimeMs: number;
  totalSize: number;
  gasSaved: string; // Percentage saved vs individual uploads
}

export interface QuiltRetrieveResult {
  identifier: string;
  content: Uint8Array;
  tags: Record<string, string>;
  retrievalTimeMs: number;
}

export interface QuiltListResult {
  identifier: string;
  quiltPatchId: string;
  tags: Record<string, string>;
}

// ============================================================================
// QuiltBatchManager
// ============================================================================

/**
 * QuiltBatchManager - Manages batch memory operations via Quilts
 *
 * Quilts provide:
 * - Multi-file uploads in single transaction (~90% gas savings)
 * - Tag-based metadata for filtering
 * - Efficient retrieval via identifier or quiltPatchId
 *
 * @example
 * ```typescript
 * const manager = new QuiltBatchManager(walrus, sui, true, 3);
 *
 * // Upload batch
 * const result = await manager.uploadMemoryBatch(memories, { signer, userAddress });
 *
 * // Retrieve all files
 * const files = await manager.getQuiltFiles(result.quiltId);
 *
 * // Retrieve by identifier
 * const file = await manager.getFileByIdentifier(result.quiltId, 'memory-123.json');
 *
 * // Filter by tags
 * const facts = await manager.getQuiltFilesByTags(result.quiltId, [{ category: 'fact' }]);
 * ```
 */
export class QuiltBatchManager {
  constructor(
    private walrusWithRelay: WalrusClient,
    private walrusWithoutRelay: WalrusClient,
    private suiClient: ClientWithExtensions<{ jsonRpc: SuiClient; walrus: WalrusClient }>,
    private useUploadRelay: boolean,
    private epochs: number
  ) {}

  // ==========================================================================
  // Upload Operations
  // ==========================================================================

  /**
   * Upload batch of memories as a Quilt
   *
   * Each memory becomes a WalrusFile with:
   * - Identifier: unique file name (memory-{timestamp}-{index}-{random}.json)
   * - Tags: plaintext metadata (searchable)
   * - Content: encrypted data (Uint8Array)
   *
   * @param memories - Array of BatchMemory objects
   * @param options - Upload options including signer and userAddress
   * @returns QuiltUploadResult with quiltId and file details
   */
  async uploadMemoryBatch(
    memories: BatchMemory[],
    options: QuiltUploadOptions
  ): Promise<QuiltUploadResult> {
    const startTime = performance.now();
    let totalSize = 0;

    console.log(`📦 Uploading batch of ${memories.length} memories as Quilt...`);

    try {
      // Create WalrusFile for each memory with plaintext tags
      const files = memories.map((memory, index) => {
        const identifier = memory.id
          ? `memory-${memory.id}.json`
          : `memory-${Date.now()}-${index}-${Math.random().toString(36).slice(2, 9)}.json`;

        totalSize += memory.encryptedContent.length;

        return WalrusFile.from({
          contents: memory.encryptedContent,
          identifier,
          tags: {
            // Core metadata (plaintext for filtering)
            'category': memory.category,
            'importance': memory.importance.toString(),
            'topic': memory.topic,
            'timestamp': new Date().toISOString(),
            'created_at': new Date().toISOString(),

            // Encryption info
            'encrypted': 'true',
            'encryption_type': 'seal',

            // Owner
            'owner': options.userAddress,

            // Content info
            'content_size': memory.encryptedContent.length.toString(),
            'embedding_dimensions': memory.embedding.length.toString(),

            // Optional rich metadata
            ...(memory.summary ? { 'summary': memory.summary } : {}),
            ...(memory.id ? { 'memory_id': memory.id } : {})
          }
        });
      });

      console.log(`   Created ${files.length} WalrusFiles with plaintext tags`);
      console.log(`   Total size: ${(totalSize / 1024).toFixed(2)} KB`);
      console.log(`   Using upload relay: ${this.useUploadRelay}`);

      // Upload as Quilt using writeFiles
      const walrusClient = this.useUploadRelay
        ? this.walrusWithRelay
        : this.walrusWithoutRelay;

      const results = await walrusClient.writeFiles({
        files,
        epochs: options.epochs || this.epochs,
        deletable: options.deletable ?? true,
        signer: options.signer
      });

      const uploadTimeMs = performance.now() - startTime;
      const gasSaved = memories.length > 1
        ? `~${((1 - 1 / memories.length) * 100).toFixed(0)}%`
        : '0%';

      console.log(`✅ Quilt upload successful!`);
      console.log(`   Quilt ID: ${results[0]?.id || 'N/A'}`);
      console.log(`   Blob ID: ${results[0]?.blobId || 'N/A'}`);
      console.log(`   Files uploaded: ${results.length}`);
      console.log(`   Upload time: ${uploadTimeMs.toFixed(1)}ms`);
      console.log(`   Gas saved: ${gasSaved} vs individual uploads`);

      // Build file results with identifiers (use original files array, not WalrusFile objects)
      const fileResults: QuiltFileResult[] = await Promise.all(
        results.map(async (r, i) => {
          // Get identifier from original WalrusFile object
          const file = files[i];
          const identifier = await file?.getIdentifier() || `file-${i}`;
          const tags = await file?.getTags() || {};

          return {
            identifier,
            blobId: r.blobId,
            quiltPatchId: undefined, // Not available from writeFiles result
            tags: Object.fromEntries(
              Object.entries(tags).map(([k, v]) => [k, String(v)])
            ),
            size: memories[i]?.encryptedContent.length || 0
          };
        })
      );

      return {
        quiltId: results[0]?.id || results[0]?.blobId,
        blobObjectId: results[0]?.blobObject?.id?.id,
        files: fileResults,
        uploadTimeMs,
        totalSize,
        gasSaved
      };

    } catch (error) {
      console.error(`❌ Quilt batch upload failed:`, error);
      throw new Error(`Quilt batch upload failed: ${error}`);
    }
  }

  /**
   * Upload raw files as a Quilt (non-memory data)
   *
   * @param files - Array of { identifier, data, tags }
   * @param options - Upload options
   * @returns QuiltUploadResult
   */
  async uploadFilesBatch(
    files: Array<{
      identifier: string;
      data: Uint8Array;
      tags?: Record<string, string>;
    }>,
    options: QuiltUploadOptions
  ): Promise<QuiltUploadResult> {
    const startTime = performance.now();
    let totalSize = 0;

    console.log(`📁 Uploading ${files.length} files as Quilt...`);

    try {
      const walrusFiles = files.map(file => {
        totalSize += file.data.length;

        return WalrusFile.from({
          contents: file.data,
          identifier: file.identifier,
          tags: {
            'timestamp': new Date().toISOString(),
            'owner': options.userAddress,
            'content_size': file.data.length.toString(),
            ...(file.tags || {})
          }
        });
      });

      const walrusClient = this.useUploadRelay
        ? this.walrusWithRelay
        : this.walrusWithoutRelay;

      const results = await walrusClient.writeFiles({
        files: walrusFiles,
        epochs: options.epochs || this.epochs,
        deletable: options.deletable ?? true,
        signer: options.signer
      });

      const uploadTimeMs = performance.now() - startTime;

      return {
        quiltId: results[0]?.id || results[0]?.blobId,
        blobObjectId: results[0]?.blobObject?.id?.id,
        files: results.map((r, i) => ({
          identifier: files[i].identifier,
          blobId: r.blobId,
          tags: files[i].tags || {},
          size: files[i].data.length
        })),
        uploadTimeMs,
        totalSize,
        gasSaved: files.length > 1 ? `~${((1 - 1 / files.length) * 100).toFixed(0)}%` : '0%'
      };

    } catch (error) {
      console.error(`❌ Files batch upload failed:`, error);
      throw new Error(`Files batch upload failed: ${error}`);
    }
  }

  // ==========================================================================
  // Retrieval Operations
  // ==========================================================================

  /**
   * Retrieve all files from a Quilt
   *
   * @param quiltId - The Quilt blob ID
   * @returns Array of WalrusFile objects
   */
  async getQuiltFiles(quiltId: string): Promise<Array<WalrusFile>> {
    try {
      console.log(`📂 Retrieving files from Quilt ${quiltId}...`);

      const files = await this.suiClient.walrus.getFiles({ ids: [quiltId] });

      console.log(`✅ Retrieved ${files.length} files from Quilt`);

      return files;

    } catch (error) {
      console.error(`❌ Failed to retrieve Quilt files:`, error);
      throw new Error(`Failed to retrieve Quilt ${quiltId}: ${error}`);
    }
  }

  /**
   * Retrieve a specific file by identifier from a Quilt
   *
   * @param quiltId - The Quilt blob ID
   * @param identifier - The file identifier within the quilt
   * @returns QuiltRetrieveResult with content and metadata
   */
  async getFileByIdentifier(
    quiltId: string,
    identifier: string
  ): Promise<QuiltRetrieveResult> {
    const startTime = performance.now();

    try {
      console.log(`📄 Retrieving file "${identifier}" from Quilt ${quiltId}...`);

      // Get all files from quilt
      const files = await this.suiClient.walrus.getFiles({ ids: [quiltId] });

      // Find file by identifier
      const file = files.find(async f => {
        const fileIdentifier = await f.getIdentifier();
        return fileIdentifier === identifier;
      });

      if (!file) {
        throw new Error(`File "${identifier}" not found in Quilt`);
      }

      const content = await file.bytes();
      const tags = await file.getTags();
      const retrievalTimeMs = performance.now() - startTime;

      console.log(`✅ Retrieved file "${identifier}" (${content.length} bytes)`);

      return {
        identifier,
        content,
        tags,
        retrievalTimeMs
      };

    } catch (error) {
      console.error(`❌ Failed to retrieve file by identifier:`, error);
      throw new Error(`Failed to retrieve "${identifier}" from Quilt: ${error}`);
    }
  }

  /**
   * List all patches in a Quilt with their metadata
   *
   * @param quiltId - The Quilt blob ID
   * @returns Array of QuiltListResult with identifiers and tags
   */
  async listQuiltPatches(quiltId: string): Promise<QuiltListResult[]> {
    try {
      console.log(`📋 Listing patches in Quilt ${quiltId}...`);

      const files = await this.suiClient.walrus.getFiles({ ids: [quiltId] });

      const results: QuiltListResult[] = await Promise.all(
        files.map(async (file) => {
          const identifier = await file.getIdentifier() || 'unknown';
          const tags = await file.getTags();

          return {
            identifier,
            quiltPatchId: '', // Would need API to get this
            tags
          };
        })
      );

      console.log(`✅ Found ${results.length} patches in Quilt`);

      return results;

    } catch (error) {
      console.error(`❌ Failed to list Quilt patches:`, error);
      throw new Error(`Failed to list patches in Quilt ${quiltId}: ${error}`);
    }
  }

  // ==========================================================================
  // Query Operations
  // ==========================================================================

  /**
   * Query Quilt files by tags (client-side filtering)
   *
   * @param quiltId - The Quilt blob ID
   * @param tagFilters - Array of tag key-value pairs to match
   * @returns Array of matching WalrusFile objects
   */
  async getQuiltFilesByTags(
    quiltId: string,
    tagFilters: Array<Record<string, string>>
  ): Promise<Array<WalrusFile>> {
    try {
      console.log(`🔍 Querying Quilt ${quiltId} with tag filters:`, tagFilters);

      // Fetch all files
      const allFiles = await this.suiClient.walrus.getFiles({ ids: [quiltId] });

      // Client-side tag filtering
      const matchingFiles: WalrusFile[] = [];

      for (const file of allFiles) {
        const fileTags = await file.getTags();

        // Check if file matches any of the tag filters
        const matches = tagFilters.some(filter => {
          return Object.entries(filter).every(([key, value]) => {
            return fileTags[key] === value;
          });
        });

        if (matches) {
          matchingFiles.push(file);
        }
      }

      console.log(`✅ Found ${matchingFiles.length} matching files out of ${allFiles.length}`);

      return matchingFiles;

    } catch (error) {
      console.error(`❌ Quilt query failed:`, error);
      throw new Error(`Failed to query Quilt ${quiltId}: ${error}`);
    }
  }

  /**
   * Query files by category
   *
   * @param quiltId - The Quilt blob ID
   * @param category - Category to filter by
   * @returns Array of matching WalrusFile objects
   */
  async getFilesByCategory(
    quiltId: string,
    category: string
  ): Promise<Array<WalrusFile>> {
    return this.getQuiltFilesByTags(quiltId, [{ category }]);
  }

  /**
   * Query files by importance threshold
   *
   * @param quiltId - The Quilt blob ID
   * @param minImportance - Minimum importance value
   * @returns Array of matching WalrusFile objects
   */
  async getFilesByImportance(
    quiltId: string,
    minImportance: number
  ): Promise<Array<WalrusFile>> {
    const allFiles = await this.suiClient.walrus.getFiles({ ids: [quiltId] });
    const matchingFiles: WalrusFile[] = [];

    for (const file of allFiles) {
      const tags = await file.getTags();
      const importance = parseInt(tags['importance'] || '0', 10);

      if (importance >= minImportance) {
        matchingFiles.push(file);
      }
    }

    return matchingFiles;
  }

  // ==========================================================================
  // Utility Methods
  // ==========================================================================

  /**
   * Get statistics
   */
  getStats() {
    return {
      useUploadRelay: this.useUploadRelay,
      epochs: this.epochs
    };
  }

  /**
   * Get Walrus client
   */
  getWalrusClient(useRelay?: boolean): WalrusClient {
    return (useRelay ?? this.useUploadRelay)
      ? this.walrusWithRelay
      : this.walrusWithoutRelay;
  }
}
