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
 * - Browser-compatible using writeFilesFlow (2 user signatures)
 *
 * Quilt Structure:
 * - quiltId: ID of the entire batch (blob containing all files)
 * - quiltPatchId: Unique ID for each file within the quilt
 * - identifier: Human-readable name for each file
 * - tags: Metadata for filtering (category, importance, etc.)
 *
 * Upload Flow (writeFilesFlow - works with DappKitSigner):
 * 1. encode() - Encode files into blob format (no signature)
 * 2. register() - Register blob on-chain (USER SIGNS - Transaction 1)
 * 3. upload() - Upload to Walrus storage nodes (no signature)
 * 4. certify() - Certify upload on-chain (USER SIGNS - Transaction 2)
 *
 * @see https://sdk.mystenlabs.com/walrus/index
 */

import { WalrusClient, WalrusFile } from '@mysten/walrus';
import type { ClientWithExtensions } from '@mysten/sui/experimental';
import type { SuiClient } from '@mysten/sui/client';
import type { UnifiedSigner } from '../../client/signers/UnifiedSigner';

// ============================================================================
// Types
// ============================================================================

/**
 * Input for batch memory upload
 */
export interface BatchMemory {
  content: string;
  category: string;
  importance: number;
  topic: string;
  embedding: number[];
  encryptedContent?: Uint8Array; // Optional - only when encryption is enabled
  encryptedEmbedding?: Uint8Array; // Optional - encrypted embedding for v2.2
  embeddingDimensions?: number; // Original embedding dimensions (when encrypted, embedding is [])
  memoryCapId?: string; // Capability ID for decryption (v2.2)
  keyId?: string; // Key ID (hex string) for decryption (v2.2)
  summary?: string;
  id?: string; // Optional client-side ID for tracking
}

/**
 * Memory package stored in Quilt as JSON
 * This format is consistent with regular memory storage
 */
export interface QuiltMemoryPackage {
  content: string;              // Plaintext content (empty if encrypted)
  embedding: number[];          // Vector embedding (empty array if encrypted)
  metadata: {
    category: string;
    importance: number;
    topic: string;
    memoryCapId?: string;       // Capability ID for decryption (v2.2)
    keyId?: string;             // Key ID for decryption (v2.2)
    [key: string]: unknown;
  };
  timestamp: number;
  version: string;              // Package format version: 2.0=plaintext, 2.1=content encrypted, 2.2=both encrypted
  encrypted?: boolean;          // Whether content is encrypted
  encryptedContent?: string;    // Base64-encoded encrypted content (if encrypted)
  encryptedEmbedding?: string;  // Base64-encoded encrypted embedding (if v2.2)
}

export interface QuiltUploadOptions {
  signer: UnifiedSigner;
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

/**
 * Result when retrieving a memory package from Quilt
 */
export interface QuiltMemoryRetrieveResult {
  identifier: string;
  memoryPackage: QuiltMemoryPackage;
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
   * Upload batch of memories as a Quilt using writeFilesFlow
   *
   * Uses the writeFilesFlow pattern which works with DappKitSigner:
   * 1. encode() - Encode files (no signature)
   * 2. register() - Register blob on-chain (USER SIGNS)
   * 3. upload() - Upload to storage nodes (no signature)
   * 4. certify() - Certify upload on-chain (USER SIGNS)
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

    console.log(`📦 Uploading batch of ${memories.length} memories as Quilt (writeFilesFlow)...`);

    try {
      // Create WalrusFile for each memory as JSON package
      // This format is consistent with regular memory storage
      const files = memories.map((memory, index) => {
        const identifier = memory.id
          ? `memory-${memory.id}.json`
          : `memory-${Date.now()}-${index}-${Math.random().toString(36).slice(2, 9)}.json`;

        const isEncrypted = !!memory.encryptedContent && memory.encryptedContent.length > 0;
        const hasEncryptedEmbedding = !!memory.encryptedEmbedding && memory.encryptedEmbedding.length > 0;
        const timestamp = Date.now();

        // Determine version based on encryption state
        // v2.2: both content AND embedding encrypted
        // v2.1: only content encrypted (embedding plaintext - legacy)
        // v2.0.0: no encryption (plaintext)
        const version = hasEncryptedEmbedding ? '2.2' : (isEncrypted ? '2.1' : '2.0.0');

        // Create memory package (JSON format - consistent with regular storage)
        const memoryPackage: QuiltMemoryPackage = {
          // Content: plaintext if not encrypted, empty if encrypted
          content: isEncrypted ? '' : memory.content,
          // Embedding: plaintext if not encrypted, empty array if encrypted
          embedding: hasEncryptedEmbedding ? [] : memory.embedding,
          metadata: {
            category: memory.category,
            importance: memory.importance,
            topic: memory.topic,
            ...(memory.summary ? { summary: memory.summary } : {}),
            ...(memory.id ? { memoryId: memory.id } : {}),
            // Store original embedding dimensions for decryption
            // Use embeddingDimensions field if available (when encrypted, embedding is [])
            ...(hasEncryptedEmbedding ? { embeddingDimensions: memory.embeddingDimensions || memory.embedding.length } : {}),
            // Capability-based encryption metadata (v2.2)
            ...(memory.memoryCapId ? { memoryCapId: memory.memoryCapId } : {}),
            ...(memory.keyId ? { keyId: memory.keyId } : {})
          },
          timestamp,
          version,
          encrypted: isEncrypted,
          // Store encrypted content as base64 for JSON compatibility
          ...(isEncrypted && memory.encryptedContent ? {
            encryptedContent: this.uint8ArrayToBase64(memory.encryptedContent)
          } : {}),
          // Store encrypted embedding as base64 (v2.2)
          ...(hasEncryptedEmbedding && memory.encryptedEmbedding ? {
            encryptedEmbedding: this.uint8ArrayToBase64(memory.encryptedEmbedding)
          } : {})
        };

        // Serialize to JSON and encode as bytes
        const jsonString = JSON.stringify(memoryPackage);
        const contents = new TextEncoder().encode(jsonString);
        totalSize += contents.length;

        // Diagnostic logging for debugging Quilt corruption issues
        console.log(`   📝 File ${index}: identifier=${identifier}`);
        console.log(`      JSON string length: ${jsonString.length} chars`);
        console.log(`      Encoded bytes: ${contents.length} bytes`);
        console.log(`      Last 50 chars of JSON: ...${jsonString.slice(-50)}`);
        console.log(`      Last 10 bytes (hex): ${Array.from(contents.slice(-10)).map(b => b.toString(16).padStart(2, '0')).join(' ')}`);

        return WalrusFile.from({
          contents,
          identifier,
          tags: {
            // Core metadata (plaintext for filtering without decryption)
            'content-type': 'application/json',
            'category': memory.category,
            'importance': memory.importance.toString(),
            'topic': memory.topic,
            'timestamp': new Date(timestamp).toISOString(),
            'created_at': new Date(timestamp).toISOString(),

            // Encryption info
            'encrypted': isEncrypted ? 'true' : 'false',
            'embedding-encrypted': hasEncryptedEmbedding ? 'true' : 'false',
            ...(isEncrypted ? { 'encryption_type': 'seal' } : {}),

            // Owner
            'owner': options.userAddress,

            // Content info
            'content_size': contents.length.toString(),
            // Use embeddingDimensions field if available (when encrypted, embedding is [])
            'embedding_dimensions': (memory.embeddingDimensions || memory.embedding.length).toString(),
            'package_version': version,

            // Optional rich metadata
            ...(memory.summary ? { 'summary': memory.summary } : {}),
            ...(memory.id ? { 'memory_id': memory.id } : {})
          }
        });
      });

      console.log(`   Created ${files.length} WalrusFiles with plaintext tags`);
      console.log(`   Total size: ${(totalSize / 1024).toFixed(2)} KB`);
      console.log(`   Using upload relay: ${this.useUploadRelay}`);

      // Use writeFilesFlow pattern (works with DappKitSigner)
      const walrusClient = this.useUploadRelay
        ? this.walrusWithRelay
        : this.walrusWithoutRelay;

      // Step 1: Create flow and encode files (no signature needed)
      console.log(`   Step 1/4: Encoding files...`);
      const flow = walrusClient.writeFilesFlow({ files });
      await flow.encode();
      console.log(`   ✓ Files encoded`);

      // Step 2: Register blob on-chain (USER SIGNS - Transaction 1)
      console.log(`   Step 2/4: Registering blob (requires signature)...`);
      const registerTx = flow.register({
        epochs: options.epochs || this.epochs,
        owner: options.userAddress,
        deletable: options.deletable ?? true
      });

      const registerResult = await options.signer.signAndExecuteTransaction(registerTx);
      console.log(`   ✓ Blob registered, digest: ${registerResult.digest}`);

      // Step 3: Upload to Walrus storage nodes (no signature needed)
      console.log(`   Step 3/4: Uploading to storage nodes...`);
      await flow.upload({ digest: registerResult.digest });
      console.log(`   ✓ Uploaded to storage nodes`);

      // Step 4: Certify upload on-chain (USER SIGNS - Transaction 2)
      console.log(`   Step 4/4: Certifying upload (requires signature)...`);
      const certifyTx = flow.certify();

      if (certifyTx) {
        const certifyResult = await options.signer.signAndExecuteTransaction(certifyTx);
        console.log(`   ✓ Upload certified, digest: ${certifyResult.digest}`);
      } else {
        console.log(`   ✓ No certification needed (already certified)`);
      }

      // Get uploaded files info from flow
      const uploadedFilesInfo = await flow.listFiles();

      const uploadTimeMs = performance.now() - startTime;
      const gasSaved = memories.length > 1
        ? `~${((1 - 1 / memories.length) * 100).toFixed(0)}%`
        : '0%';

      console.log(`✅ Quilt upload successful!`);
      console.log(`   Files uploaded: ${uploadedFilesInfo.length}`);
      console.log(`   Upload time: ${uploadTimeMs.toFixed(1)}ms`);
      console.log(`   Gas saved: ${gasSaved} vs individual uploads`);

      // Build file results using original WalrusFile objects for metadata
      // Use shared quiltId as blobId - SDK can only read via getBlob(quiltId).files()
      // Match files by identifier when reading
      const quiltId = uploadedFilesInfo[0]?.blobId || '';

      const fileResults: QuiltFileResult[] = await Promise.all(
        files.map(async (originalFile, i) => {
          const identifier = await originalFile.getIdentifier() || `file-${i}`;
          const tags = await originalFile.getTags() || {};
          const fileInfo = uploadedFilesInfo[i];

          // quiltPatchId is stored for reference but not used for retrieval
          const quiltPatchId = fileInfo?.id || '';

          console.log(`   File ${i}: identifier=${identifier}, quiltId=${quiltId.substring(0, 20)}...`);

          return {
            identifier,
            // Use shared quiltId as blobId - read via getBlob(quiltId).files()
            blobId: quiltId,
            quiltPatchId,
            tags: Object.fromEntries(
              Object.entries(tags).map(([k, v]) => [k, String(v)])
            ),
            size: memories[i]?.encryptedContent?.length || memories[i]?.content?.length || 0
          };
        })
      );

      return {
        quiltId,
        blobObjectId: undefined, // Not available from flow
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
   * Upload raw files as a Quilt using writeFilesFlow
   *
   * Uses the writeFilesFlow pattern which works with DappKitSigner:
   * 1. encode() - Encode files (no signature)
   * 2. register() - Register blob on-chain (USER SIGNS)
   * 3. upload() - Upload to storage nodes (no signature)
   * 4. certify() - Certify upload on-chain (USER SIGNS)
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

    console.log(`📁 Uploading ${files.length} files as Quilt (writeFilesFlow)...`);

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

      // Use writeFilesFlow pattern (works with DappKitSigner)
      const walrusClient = this.useUploadRelay
        ? this.walrusWithRelay
        : this.walrusWithoutRelay;

      // Step 1: Create flow and encode files (no signature needed)
      console.log(`   Step 1/4: Encoding files...`);
      const flow = walrusClient.writeFilesFlow({ files: walrusFiles });
      await flow.encode();
      console.log(`   ✓ Files encoded`);

      // Step 2: Register blob on-chain (USER SIGNS - Transaction 1)
      console.log(`   Step 2/4: Registering blob (requires signature)...`);
      const registerTx = flow.register({
        epochs: options.epochs || this.epochs,
        owner: options.userAddress,
        deletable: options.deletable ?? true
      });

      const registerResult = await options.signer.signAndExecuteTransaction(registerTx);
      console.log(`   ✓ Blob registered, digest: ${registerResult.digest}`);

      // Step 3: Upload to Walrus storage nodes (no signature needed)
      console.log(`   Step 3/4: Uploading to storage nodes...`);
      await flow.upload({ digest: registerResult.digest });
      console.log(`   ✓ Uploaded to storage nodes`);

      // Step 4: Certify upload on-chain (USER SIGNS - Transaction 2)
      console.log(`   Step 4/4: Certifying upload (requires signature)...`);
      const certifyTx = flow.certify();

      if (certifyTx) {
        const certifyResult = await options.signer.signAndExecuteTransaction(certifyTx);
        console.log(`   ✓ Upload certified, digest: ${certifyResult.digest}`);
      } else {
        console.log(`   ✓ No certification needed (already certified)`);
      }

      // Get uploaded files info from flow
      const uploadedFilesInfo = await flow.listFiles();

      const uploadTimeMs = performance.now() - startTime;

      console.log(`✅ Files batch upload successful!`);
      console.log(`   Files uploaded: ${uploadedFilesInfo.length}`);
      console.log(`   Upload time: ${uploadTimeMs.toFixed(1)}ms`);

      // Build file results using original WalrusFile objects for metadata
      // Use shared quiltId as blobId - SDK can only read via getBlob(quiltId).files()
      // Match files by identifier when reading
      const quiltId = uploadedFilesInfo[0]?.blobId || '';

      const fileResults: QuiltFileResult[] = await Promise.all(
        walrusFiles.map(async (originalFile, i) => {
          const identifier = await originalFile.getIdentifier() || files[i]?.identifier || `file-${i}`;
          const tags = await originalFile.getTags() || {};
          const fileInfo = uploadedFilesInfo[i];

          // quiltPatchId is stored for reference but not used for retrieval
          const quiltPatchId = fileInfo?.id || '';

          console.log(`   File ${i}: identifier=${identifier}, quiltId=${quiltId.substring(0, 20)}...`);

          return {
            identifier,
            // Use shared quiltId as blobId - read via getBlob(quiltId).files()
            blobId: quiltId,
            quiltPatchId,
            tags: Object.fromEntries(
              Object.entries(tags).map(([k, v]) => [k, String(v)])
            ),
            size: files[i]?.data.length || 0
          };
        })
      );

      return {
        quiltId,
        blobObjectId: undefined, // Not available from flow
        files: fileResults,
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
   * Uses getBlob().files() pattern which correctly parses Quilt structure
   * and returns individual files with their identifiers and tags.
   *
   * @param quiltId - The Quilt blob ID (shared blobId)
   * @returns Array of WalrusFile objects
   */
  async getQuiltFiles(quiltId: string): Promise<Array<WalrusFile>> {
    try {
      console.log(`📂 Retrieving files from Quilt ${quiltId}...`);

      // Try to parse as Quilt first (getBlob().files() returns ALL files in Quilt)
      // Fall back to getFiles() for regular blobs
      let files: WalrusFile[];
      try {
        const blob = await this.suiClient.walrus.getBlob({ blobId: quiltId });
        files = await blob.files();
        console.log(`✅ Retrieved ${files.length} files from Quilt`);
      } catch (quiltError: any) {
        // Not a Quilt - try as regular blob
        console.log(`📄 Not a Quilt format, fetching as regular blob...`);
        files = await this.suiClient.walrus.getFiles({ ids: [quiltId] });
        console.log(`✅ Retrieved ${files.length} file(s) as regular blob`);
      }

      return files;

    } catch (error) {
      console.error(`❌ Failed to retrieve Quilt files:`, error);
      throw new Error(`Failed to retrieve Quilt ${quiltId}: ${error}`);
    }
  }

  /**
   * Retrieve a specific file by identifier from a Quilt
   *
   * Uses getBlob().files() to get all files then matches by identifier.
   *
   * @param quiltId - The Quilt blob ID (shared blobId)
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

      // Get all files from the blob (Quilt or regular)
      const files = await this.getQuiltFiles(quiltId);

      // Find file by identifier
      let matchingFile: WalrusFile | undefined;
      for (const f of files) {
        const fileIdentifier = await f.getIdentifier();
        if (fileIdentifier === identifier) {
          matchingFile = f;
          break;
        }
      }

      if (!matchingFile) {
        throw new Error(`File "${identifier}" not found in Quilt`);
      }

      const content = await matchingFile.bytes();
      const tags = await matchingFile.getTags();
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
   * Uses getBlob().files() to correctly parse Quilt structure.
   *
   * @param quiltId - The Quilt blob ID (shared blobId)
   * @returns Array of QuiltListResult with identifiers and tags
   */
  async listQuiltPatches(quiltId: string): Promise<QuiltListResult[]> {
    try {
      console.log(`📋 Listing patches in Quilt ${quiltId}...`);

      // Get all files from the blob (Quilt or regular)
      const files = await this.getQuiltFiles(quiltId);

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
  // JSON Memory Package Retrieval
  // ==========================================================================

  /**
   * Retrieve a memory package as JSON from a Quilt
   *
   * Uses file.json() for efficient parsing (SDK handles it)
   *
   * @param quiltId - The Quilt blob ID
   * @param identifier - The file identifier within the quilt
   * @returns QuiltMemoryRetrieveResult with parsed memory package
   */
  async getMemoryPackage(
    quiltId: string,
    identifier: string
  ): Promise<QuiltMemoryRetrieveResult> {
    const startTime = performance.now();

    try {
      console.log(`📄 Retrieving memory package "${identifier}" from Quilt ${quiltId}...`);

      // Get all files from the blob
      const files = await this.getQuiltFiles(quiltId);

      // Find file by identifier
      let matchingFile: WalrusFile | undefined;
      for (const f of files) {
        const fileIdentifier = await f.getIdentifier();
        if (fileIdentifier === identifier) {
          matchingFile = f;
          break;
        }
      }

      if (!matchingFile) {
        throw new Error(`File "${identifier}" not found in Quilt`);
      }

      const tags = await matchingFile.getTags();
      let memoryPackage: QuiltMemoryPackage;

      try {
        // Parse directly as JSON (SDK handles it!)
        memoryPackage = await matchingFile.json() as QuiltMemoryPackage;
      } catch (parseError) {
        // Try partial recovery for truncated JSON
        console.warn(`⚠️ JSON parse failed for "${identifier}", attempting recovery...`);
        const bytes = await matchingFile.bytes();
        const recovered = this.tryRecoverTruncatedPackage(bytes);
        if (recovered) {
          console.log(`🔧 Partially recovered "${identifier}" (encryptedContent may be corrupted)`);
          memoryPackage = recovered;
        } else {
          throw parseError;
        }
      }

      const retrievalTimeMs = performance.now() - startTime;

      console.log(`✅ Retrieved memory package "${identifier}" (${retrievalTimeMs.toFixed(1)}ms)`);

      return {
        identifier,
        memoryPackage,
        tags,
        retrievalTimeMs
      };

    } catch (error) {
      console.error(`❌ Failed to retrieve memory package:`, error);
      throw new Error(`Failed to retrieve memory package "${identifier}": ${error}`);
    }
  }

  /**
   * Retrieve all memory packages from a Quilt as JSON
   *
   * @param quiltId - The Quilt blob ID
   * @returns Array of memory packages with metadata
   */
  async getAllMemoryPackages(quiltId: string): Promise<QuiltMemoryRetrieveResult[]> {
    const startTime = performance.now();

    try {
      console.log(`📂 Retrieving all memory packages from Quilt ${quiltId}...`);

      const files = await this.getQuiltFiles(quiltId);
      const results: QuiltMemoryRetrieveResult[] = [];

      for (const file of files) {
        const identifier = await file.getIdentifier() || 'unknown';
        const tags = await file.getTags();

        try {
          // Parse as JSON
          const memoryPackage = await file.json() as QuiltMemoryPackage;
          results.push({
            identifier,
            memoryPackage,
            tags,
            retrievalTimeMs: 0 // Individual timing not tracked in batch
          });
        } catch (parseError) {
          console.warn(`⚠️ Failed to parse "${identifier}" as JSON:`, parseError);

          // Try partial recovery for truncated JSON
          try {
            const bytes = await file.bytes();
            const recoveredPackage = this.tryRecoverTruncatedPackage(bytes);
            if (recoveredPackage) {
              console.log(`🔧 Partially recovered "${identifier}" (encryptedContent truncated)`);
              results.push({
                identifier,
                memoryPackage: recoveredPackage,
                tags,
                retrievalTimeMs: 0
              });
            }
          } catch {
            // Skip files that can't be recovered
            console.warn(`❌ Could not recover "${identifier}"`);
          }
        }
      }

      const totalTimeMs = performance.now() - startTime;
      console.log(`✅ Retrieved ${results.length} memory packages (${totalTimeMs.toFixed(1)}ms)`);

      return results;

    } catch (error) {
      console.error(`❌ Failed to retrieve memory packages:`, error);
      throw new Error(`Failed to retrieve memory packages from Quilt ${quiltId}: ${error}`);
    }
  }

  /**
   * Find a specific memory in a Quilt using multiple matching strategies
   *
   * Strategies (in order of priority):
   * 1. Match by tags['memory_id'] === memoryId
   * 2. Match by identifier === `memory-${memoryId}.json`
   * 3. Match by JSON metadata.memoryId === memoryId
   * 4. Fallback to index-based matching (if fileIndex provided)
   *
   * @param quiltId - The Quilt blob ID
   * @param memoryId - The memory ID (usually vectorId) to find
   * @param fileIndex - Optional fallback index if other strategies fail
   * @returns The matching memory package result, or null if not found
   */
  async findMemoryInQuilt(
    quiltId: string,
    memoryId: string,
    fileIndex?: number
  ): Promise<QuiltMemoryRetrieveResult | null> {
    const startTime = performance.now();

    try {
      console.log(`🔍 Finding memory "${memoryId}" in Quilt ${quiltId.substring(0, 20)}...`);

      const files = await this.getQuiltFiles(quiltId);
      let matchedFile: WalrusFile | undefined;
      let matchStrategy: string = '';

      // Strategy 1: Match by tags['memory_id']
      for (const f of files) {
        const tags = await f.getTags();
        if (tags?.['memory_id'] === memoryId) {
          matchedFile = f;
          matchStrategy = 'memory_id tag';
          break;
        }
      }

      // Strategy 2: Match by identifier pattern "memory-{memoryId}.json"
      if (!matchedFile) {
        for (const f of files) {
          const identifier = await f.getIdentifier();
          if (identifier === `memory-${memoryId}.json`) {
            matchedFile = f;
            matchStrategy = 'identifier pattern';
            break;
          }
        }
      }

      // Strategy 3: Parse JSON to find matching metadata.memoryId
      if (!matchedFile) {
        for (const f of files) {
          try {
            const json = await f.json() as QuiltMemoryPackage;
            if (json?.metadata?.memoryId === memoryId) {
              matchedFile = f;
              matchStrategy = 'JSON metadata.memoryId';
              break;
            }
          } catch {
            // Not valid JSON, continue
          }
        }
      }

      // Strategy 4: Fallback to index-based matching
      if (!matchedFile && fileIndex !== undefined && fileIndex < files.length) {
        matchedFile = files[fileIndex];
        matchStrategy = `index fallback (${fileIndex})`;
      }

      if (!matchedFile) {
        console.log(`❌ Memory "${memoryId}" not found in Quilt (${files.length} files)`);
        return null;
      }

      const identifier = await matchedFile.getIdentifier() || 'unknown';
      const tags = await matchedFile.getTags();

      let memoryPackage: QuiltMemoryPackage;
      try {
        memoryPackage = await matchedFile.json() as QuiltMemoryPackage;
      } catch (parseError) {
        // Try recovery for truncated JSON
        const bytes = await matchedFile.bytes();
        const recovered = this.tryRecoverTruncatedPackage(bytes);
        if (recovered) {
          memoryPackage = recovered;
        } else {
          throw parseError;
        }
      }

      const retrievalTimeMs = performance.now() - startTime;
      console.log(`✅ Found memory "${memoryId}" via ${matchStrategy} (${identifier}) in ${retrievalTimeMs.toFixed(1)}ms`);

      return {
        identifier,
        memoryPackage,
        tags,
        retrievalTimeMs
      };

    } catch (error) {
      console.error(`❌ Failed to find memory in Quilt:`, error);
      throw new Error(`Failed to find memory "${memoryId}" in Quilt ${quiltId}: ${error}`);
    }
  }

  /**
   * Get memory content from a Quilt file
   *
   * Handles both encrypted and unencrypted content:
   * - Unencrypted: Returns content directly from package
   * - Encrypted: Returns decrypted content if sessionKey provided, otherwise throws
   *
   * @param quiltId - The Quilt blob ID
   * @param identifier - The file identifier
   * @param sessionKey - Optional session key for encrypted content
   * @returns Memory content as string
   */
  async getMemoryContent(
    quiltId: string,
    identifier: string,
    decryptFn?: (encryptedBase64: string) => Promise<string>
  ): Promise<string> {
    const result = await this.getMemoryPackage(quiltId, identifier);
    const pkg = result.memoryPackage;

    if (!pkg.encrypted) {
      // Not encrypted - return content directly
      return pkg.content;
    }

    if (!pkg.encryptedContent) {
      throw new Error('Memory is marked as encrypted but no encrypted content found');
    }

    if (!decryptFn) {
      throw new Error('Memory is encrypted. Provide decryptFn to decrypt content.');
    }

    // Decrypt using provided function
    return await decryptFn(pkg.encryptedContent);
  }

  // ==========================================================================
  // Utility Methods
  // ==========================================================================

  /**
   * Try to recover a partially truncated memory package
   *
   * Handles cases where JSON was truncated (e.g., in the middle of encryptedContent)
   * by extracting metadata and marking the encrypted content as corrupted.
   *
   * @param bytes - Raw bytes of the file
   * @returns Recovered QuiltMemoryPackage or null if recovery fails
   */
  private tryRecoverTruncatedPackage(bytes: Uint8Array): QuiltMemoryPackage | null {
    try {
      const rawString = new TextDecoder().decode(bytes);

      // Find and trim trailing null bytes
      let lastValidIndex = rawString.length - 1;
      while (lastValidIndex >= 0 && rawString.charCodeAt(lastValidIndex) === 0) {
        lastValidIndex--;
      }

      const trimmedString = rawString.slice(0, lastValidIndex + 1);

      // First try to parse as-is (maybe nulls were the only issue)
      try {
        return JSON.parse(trimmedString) as QuiltMemoryPackage;
      } catch {
        // Continue to partial recovery
      }

      // Look for encryptedContent field - data likely truncated there
      const encryptedIdx = trimmedString.indexOf('"encryptedContent":"');
      if (encryptedIdx > 0) {
        // Extract everything before encryptedContent
        const beforeEncrypted = trimmedString.slice(0, encryptedIdx);
        // Remove trailing comma and close the object
        const cleanedJson = beforeEncrypted.replace(/,\s*$/, '') + '}';

        try {
          const partialPackage = JSON.parse(cleanedJson);
          return {
            ...partialPackage,
            encrypted: true,
            encryptedContent: '[CORRUPTED - data truncated during storage]'
          } as QuiltMemoryPackage;
        } catch {
          // Partial extraction failed
        }
      }

      // Try to find the last complete JSON object by looking for closing brace
      // This handles cases where truncation happened elsewhere
      for (let i = trimmedString.length - 1; i >= 0; i--) {
        if (trimmedString[i] === '}') {
          try {
            const candidate = trimmedString.slice(0, i + 1);
            return JSON.parse(candidate) as QuiltMemoryPackage;
          } catch {
            // This position doesn't form valid JSON, try earlier
            continue;
          }
        }
      }

      return null;
    } catch {
      return null;
    }
  }

  /**
   * Convert Uint8Array to base64 string
   */
  private uint8ArrayToBase64(bytes: Uint8Array): string {
    // Use Buffer in Node.js, btoa in browser
    if (typeof Buffer !== 'undefined') {
      return Buffer.from(bytes).toString('base64');
    }
    // Browser fallback
    let binary = '';
    for (let i = 0; i < bytes.length; i++) {
      binary += String.fromCharCode(bytes[i]);
    }
    return btoa(binary);
  }

  /**
   * Convert base64 string to Uint8Array
   */
  private base64ToUint8Array(base64: string): Uint8Array {
    // Use Buffer in Node.js, atob in browser
    if (typeof Buffer !== 'undefined') {
      return new Uint8Array(Buffer.from(base64, 'base64'));
    }
    // Browser fallback
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i);
    }
    return bytes;
  }

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

  /**
   * Get base64 converter (for external use)
   */
  getBase64Utils() {
    return {
      encode: this.uint8ArrayToBase64.bind(this),
      decode: this.base64ToUint8Array.bind(this)
    };
  }
}
