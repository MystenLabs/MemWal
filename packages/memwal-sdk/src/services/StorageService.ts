/**
 * StorageService - Refactored with Manager Delegation
 *
 * This is a coordinator service that delegates to specialized managers:
 * - WalrusStorageManager: Core Walrus operations
 * - MemorySearchManager: Memory indexing and search
 * - KnowledgeGraphManager: Knowledge graph operations
 * - WalrusMetadataManager: Metadata operations
 * - QuiltBatchManager: Batch uploads
 * - BlobAttributesManager: Dynamic field operations
 *
 * Maintains full backward compatibility with original StorageService API.
 */

import { SuiClient, getFullnodeUrl } from '@mysten/sui/client';
import { Transaction } from '@mysten/sui/transactions';
import { WalrusClient, WalrusFile } from '@mysten/walrus';
import type { UnifiedSigner } from '../client/signers/UnifiedSigner';
import type { ClientWithExtensions } from '@mysten/sui/experimental';
import type { SealService } from '../infrastructure/seal/SealService';
import type { BatchService } from './BatchService';
import { PDWConfig } from '../core';
import { MemoryIndexService } from './MemoryIndexService';
import { EmbeddingService, type EmbeddingOptions } from './EmbeddingService';
import { GraphService, type KnowledgeGraph, type Entity, type Relationship, type GraphExtractionResult } from '../graph/GraphService';

// Import managers
import { WalrusStorageManager } from './storage/WalrusStorageManager';
import { MemorySearchManager } from './storage/MemorySearchManager';
import { KnowledgeGraphManager } from './storage/KnowledgeGraphManager';
import { WalrusMetadataManager } from './storage/WalrusMetadataManager';
import { QuiltBatchManager } from './storage/QuiltBatchManager';
import { BlobAttributesManager } from './storage/BlobAttributesManager';

// Re-export types for backward compatibility
export interface StorageServiceConfig extends PDWConfig {
  suiClient?: SuiClient;
  network?: 'testnet' | 'mainnet';
  maxFileSize?: number;
  timeout?: number;
  useUploadRelay?: boolean;
  epochs?: number;
  sealService?: SealService;
  batchService?: BatchService;
}

export interface MemoryMetadata {
  contentType: string;
  contentSize: number;
  contentHash: string;
  category: string;
  topic: string;
  importance: number;
  embeddingBlobId?: string;
  embeddingDimension: number;
  createdTimestamp: number;
  updatedTimestamp?: number;
  customMetadata?: Record<string, string>;
  isEncrypted?: boolean;
  encryptionType?: string;
}

export interface WalrusUploadResult {
  blobId: string;
  metadata: MemoryMetadata;
  embeddingBlobId?: string;
  isEncrypted: boolean;
  backupKey?: string;
  storageEpochs: number;
  uploadTimeMs: number;
}

export interface BlobUploadOptions {
  signer: UnifiedSigner;
  epochs?: number;
  deletable?: boolean;
  useUploadRelay?: boolean;
  encrypt?: boolean;
  metadata?: Record<string, string>;
}

export interface FileUploadOptions extends BlobUploadOptions {
  files: Array<{
    identifier: string;
    content: Uint8Array | string;
    tags?: Record<string, string>;
  }>;
}

export interface WalrusMemoryMetadata {
  content_type: string;
  content_size: string;
  category: string;
  topic: string;
  importance: string;
  embedding_dimensions: string;
  embedding_model: string;
  embedding_blob_id?: string;
  graph_entity_count: string;
  graph_relationship_count: string;
  graph_blob_id?: string;
  graph_entity_ids?: string;
  vector_id: string;
  vector_status: string;
  created_at: string;
  updated_at: string;
  deleted_at?: string;
  encrypted: string;
  encryption_type?: string;
  seal_identity?: string;
  [key: string]: string | undefined;
}

export interface WalrusMetadataOptions {
  attachMetadata?: boolean;
  walrusMetadata?: Partial<WalrusMemoryMetadata>;
  embeddingBlobId?: string;
  graphBlobId?: string;
  vectorId?: number;
  graphEntityIds?: string[];
}

export interface BlobUploadOptionsWithMetadata extends BlobUploadOptions, WalrusMetadataOptions {}

export interface MetadataSearchQuery {
  query?: string;
  vector?: number[];
  filters?: {
    category?: string | string[];
    topic?: string | string[];
    importance?: { min?: number; max?: number };
    contentType?: string | string[];
    dateRange?: { start?: Date; end?: Date };
    tags?: string[];
    contentSize?: { min?: number; max?: number };
  };
  k?: number;
  threshold?: number;
  includeContent?: boolean;
  useCache?: boolean;
}

export interface MetadataSearchResult {
  blobId: string;
  content?: string | Uint8Array;
  metadata: MemoryMetadata;
  similarity: number;
  relevanceScore: number;
}

export interface IndexedMemoryEntry {
  blobId: string;
  vectorId: number;
  metadata: MemoryMetadata;
  vector: number[];
}

/**
 * StorageService - Refactored with Manager Delegation
 */
export class StorageService {
  // Managers
  private walrusStorage: WalrusStorageManager;
  private memorySearch: MemorySearchManager;
  private knowledgeGraph: KnowledgeGraphManager;
  private walrusMetadata: WalrusMetadataManager;
  private quiltBatch: QuiltBatchManager;
  private blobAttributes: BlobAttributesManager;

  // Legacy properties for backward compatibility
  private suiClient: ClientWithExtensions<{ jsonRpc: SuiClient; walrus: WalrusClient }>;
  private memoryIndexService?: MemoryIndexService;
  private embeddingService?: EmbeddingService;
  private graphService?: GraphService;

  constructor(private config: StorageServiceConfig) {
    // Initialize WalrusStorageManager
    this.walrusStorage = new WalrusStorageManager({
      suiClient: config.suiClient,
      network: config.network,
      maxFileSize: config.maxFileSize,
      timeout: config.timeout,
      useUploadRelay: config.useUploadRelay,
      epochs: config.epochs
    });

    // Initialize MemorySearchManager
    this.memorySearch = new MemorySearchManager();

    // Initialize KnowledgeGraphManager
    this.knowledgeGraph = new KnowledgeGraphManager();

    // Get SuiClient from WalrusStorageManager
    this.suiClient = this.walrusStorage.getSuiClient();

    // Initialize WalrusMetadataManager
    this.walrusMetadata = new WalrusMetadataManager(this.suiClient.jsonRpc);

    // Initialize QuiltBatchManager
    this.quiltBatch = new QuiltBatchManager(
      this.walrusStorage.getWalrusClient(true),
      this.walrusStorage.getWalrusClient(false),
      this.suiClient,
      config.useUploadRelay ?? true,
      config.epochs || 3
    );

    // Initialize BlobAttributesManager
    this.blobAttributes = new BlobAttributesManager(this.suiClient.jsonRpc);

    console.log('✅ StorageService initialized with manager delegation');
  }

  // ==================== INITIALIZATION METHODS ====================

  /**
   * Initialize memory indexing and search capabilities
   */
  initializeSearch(embeddingService: EmbeddingService, memoryIndexService?: MemoryIndexService) {
    this.embeddingService = embeddingService;
    this.memoryIndexService = memoryIndexService || new MemoryIndexService(this);

    this.memorySearch.initializeSearch(embeddingService, this.memoryIndexService);

    console.log('✅ StorageService: Memory indexing and search capabilities initialized');
  }

  /**
   * Initialize Knowledge Graph capabilities
   */
  async initializeKnowledgeGraph(graphConfig?: any) {
    this.graphService = await this.knowledgeGraph.initializeKnowledgeGraph(
      this.embeddingService,
      graphConfig
    );
    return this.graphService;
  }

  // ==================== CORE WALRUS OPERATIONS (Delegate to WalrusStorageManager) ====================

  /**
   * Upload single blob using writeBlobFlow pattern
   */
  async uploadBlob(
    data: Uint8Array,
    options: BlobUploadOptions
  ): Promise<WalrusUploadResult> {
    const result = await this.walrusStorage.uploadBlob(data, options);

    // Convert to legacy format
    const metadata: MemoryMetadata = {
      contentType: options.metadata?.['content-type'] || 'application/octet-stream',
      contentSize: result.contentSize,
      contentHash: result.blobId, // Walrus blob_id serves as content hash
      category: options.metadata?.category || 'default',
      topic: options.metadata?.topic || '',
      importance: parseInt(options.metadata?.importance || '5'),
      embeddingDimension: parseInt(options.metadata?.['embedding-dimensions'] || '0'),
      createdTimestamp: Date.now(),
      customMetadata: options.metadata,
      isEncrypted: result.isEncrypted,
      encryptionType: result.isEncrypted ? 'seal' : undefined,
    };

    // Handle metadata attachment if requested
    if ((options as BlobUploadOptionsWithMetadata).attachMetadata && result.blobObjectId) {
      const metadataOptions = options as BlobUploadOptionsWithMetadata;
      const walrusMetadata = this.buildWalrusMetadata(
        result.contentSize,
        {
          category: metadata.category,
          topic: metadata.topic,
          importance: metadata.importance,
          embeddingBlobId: metadataOptions.embeddingBlobId,
          graphBlobId: metadataOptions.graphBlobId,
          graphEntityIds: metadataOptions.graphEntityIds,
          vectorId: metadataOptions.vectorId,
          isEncrypted: result.isEncrypted,
          encryptionType: metadata.encryptionType,
          sealIdentity: options.metadata?.['seal-identity'],
          customFields: options.metadata,
        }
      );

      // Attach as attributes
      try {
        const attributes: Record<string, string> = {
          memory_category: walrusMetadata.category,
          memory_topic: walrusMetadata.topic,
          memory_importance: walrusMetadata.importance,
          memory_encrypted: walrusMetadata.encrypted,
          memory_encryption_type: walrusMetadata.encryption_type || 'none',
          memory_content_size: walrusMetadata.content_size,
          memory_created_at: walrusMetadata.created_at,
        };

        if (walrusMetadata.vector_id) {
          attributes.memory_vector_id = walrusMetadata.vector_id;
        }
        if (walrusMetadata.embedding_blob_id) {
          attributes.memory_embedding_blob_id = walrusMetadata.embedding_blob_id;
        }
        if (walrusMetadata.graph_blob_id) {
          attributes.memory_graph_blob_id = walrusMetadata.graph_blob_id;
        }
        if (walrusMetadata.seal_identity) {
          attributes.memory_seal_identity = walrusMetadata.seal_identity;
        }

        await this.blobAttributes.setBlobAttributes(
          result.blobObjectId,
          attributes,
          options.signer
        );
      } catch (error) {
        console.warn('⚠️  Failed to attach metadata (non-fatal):', error);
      }
    }

    return {
      blobId: result.blobId,
      metadata,
      isEncrypted: result.isEncrypted,
      storageEpochs: result.storageEpochs,
      uploadTimeMs: result.uploadTimeMs,
    };
  }

  /**
   * Upload memory package with SEAL encrypted content
   */
  async uploadMemoryPackage(
    memoryData: {
      content: string;
      embedding: number[];
      metadata: Record<string, any>;
      encryptedContent?: Uint8Array;
      encryptionType?: string;
      identity?: string;
    },
    options: BlobUploadOptions
  ): Promise<WalrusUploadResult> {
    let dataToUpload: Uint8Array;
    let storageApproach: 'direct-binary' | 'json-package';
    let uploadMetadata: Record<string, string>;

    if (memoryData.encryptedContent && memoryData.encryptedContent instanceof Uint8Array) {
      // Direct binary storage for SEAL encrypted data
      dataToUpload = memoryData.encryptedContent;
      storageApproach = 'direct-binary';

      uploadMetadata = {
        'content-type': 'application/octet-stream',
        'encryption-type': memoryData.encryptionType || 'seal-real',
        'context-id': `memory-${memoryData.identity || 'unknown'}`,
        'app-id': 'pdw-sdk',
        'encrypted': 'true',
        'seal-identity': memoryData.identity || '',
        'version': '1.0',
        'category': memoryData.metadata.category || 'memory',
        'created-at': new Date().toISOString(),
        'original-content-type': 'text/plain',
        'embedding-dimensions': memoryData.embedding.length.toString(),
        'metadata-title': memoryData.metadata.title || '',
        'metadata-tags': JSON.stringify(memoryData.metadata.tags || []),
        'storage-approach': storageApproach
      };
    } else {
      // JSON package storage
      storageApproach = 'json-package';

      const memoryPackage = {
        content: memoryData.content,
        embedding: memoryData.embedding,
        metadata: memoryData.metadata,
        encrypted: memoryData.encryptedContent ? {
          encryptedContent: memoryData.encryptedContent,
          encryptionType: memoryData.encryptionType,
          identity: memoryData.identity,
          timestamp: Date.now()
        } : null,
        timestamp: Date.now(),
        version: '1.0'
      };

      const payloadString = JSON.stringify(memoryPackage);
      dataToUpload = new TextEncoder().encode(payloadString);

      uploadMetadata = {
        'content-type': 'application/json',
        'encryption-type': memoryData.encryptionType || 'none',
        'context-id': `memory-${memoryData.identity || 'unknown'}`,
        'app-id': 'pdw-sdk',
        'encrypted': memoryData.encryptionType?.includes('seal') ? 'true' : 'false',
        'version': '1.0',
        'category': memoryData.metadata.category || 'memory',
        'created-at': new Date().toISOString(),
        'storage-approach': storageApproach
      };
    }

    const result = await this.uploadBlob(dataToUpload, {
      ...options,
      metadata: uploadMetadata
    });

    return {
      ...result,
      metadata: {
        ...result.metadata,
        customMetadata: {
          ...result.metadata.customMetadata,
          'storage-approach': storageApproach
        }
      }
    };
  }

  /**
   * Retrieve blob by ID directly from Walrus
   */
  async getBlob(blobId: string): Promise<Uint8Array> {
    return this.walrusStorage.getBlob(blobId);
  }

  /**
   * Retrieve blob with detailed logging
   */
  async retrieveFromWalrusOnly(blobId: string): Promise<{
    content: Uint8Array;
    source: 'walrus';
    retrievalTime: number;
    blobSize: number;
  }> {
    return this.walrusStorage.retrieveBlob(blobId);
  }

  /**
   * Retrieve memory package from Walrus with format detection
   */
  async retrieveMemoryPackage(blobId: string): Promise<{
    content: Uint8Array;
    storageApproach: 'direct-binary' | 'json-package' | 'unknown';
    metadata: MemoryMetadata;
    memoryPackage?: any;
    isEncrypted: boolean;
    source: 'walrus';
    retrievalTime: number;
  }> {
    const startTime = Date.now();
    const content = await this.getBlob(blobId);

    let storageApproach: 'direct-binary' | 'json-package' | 'unknown' = 'unknown';
    let memoryPackage: any = null;
    let isEncrypted = false;

    // Try to parse as JSON
    try {
      const contentString = new TextDecoder().decode(content);
      memoryPackage = JSON.parse(contentString);

      if (memoryPackage.version && memoryPackage.content && memoryPackage.embedding) {
        storageApproach = 'json-package';
        isEncrypted = false;
      }
    } catch (parseError) {
      // Not JSON - likely binary SEAL data
      const isBinary = content.some(byte => byte < 32 && byte !== 9 && byte !== 10 && byte !== 13);
      const hasHighBytes = content.some(byte => byte > 127);

      if (isBinary || hasHighBytes || content.length > 50) {
        storageApproach = 'direct-binary';
        isEncrypted = true;
      }
    }

    const metadata: MemoryMetadata = {
      contentType: storageApproach === 'json-package' ? 'application/json' : 'application/octet-stream',
      contentSize: content.length,
      contentHash: '',
      category: memoryPackage?.metadata?.category || 'unknown',
      topic: memoryPackage?.metadata?.topic || 'unknown',
      importance: memoryPackage?.metadata?.importance || 0,
      embeddingDimension: memoryPackage?.embedding?.length || 0,
      createdTimestamp: memoryPackage?.timestamp || Date.now(),
      isEncrypted,
      encryptionType: isEncrypted ? 'seal-real' : undefined
    };

    return {
      content,
      storageApproach,
      metadata,
      memoryPackage,
      isEncrypted,
      source: 'walrus' as const,
      retrievalTime: Date.now() - startTime
    };
  }

  // ==================== MEMORY SEARCH OPERATIONS (Delegate to MemorySearchManager) ====================

  /**
   * Upload with automatic memory indexing
   */
  async uploadWithIndexing(
    content: string | Uint8Array,
    metadata: MemoryMetadata,
    userAddress: string,
    options: BlobUploadOptions
  ): Promise<WalrusUploadResult & { vectorId: number }> {
    if (!this.embeddingService || !this.memoryIndexService) {
      throw new Error('Search capabilities not initialized. Call initializeSearch() first.');
    }

    const uploadResult = await this.upload(content, metadata, options);

    let textContent: string;
    if (content instanceof Uint8Array) {
      textContent = `${metadata.category} ${metadata.topic || ''} ${JSON.stringify(metadata.customMetadata || {})}`.trim();
    } else {
      textContent = content;
    }

    const memoryId = `memory_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    const indexResult = await this.memorySearch.indexMemory(
      userAddress,
      memoryId,
      uploadResult.blobId,
      textContent,
      metadata
    );

    return {
      ...uploadResult,
      vectorId: indexResult.vectorId
    };
  }

  /**
   * Search memories by metadata
   */
  async searchByMetadata(
    userAddress: string,
    searchQuery: MetadataSearchQuery
  ): Promise<MetadataSearchResult[]> {
    return this.memorySearch.searchByMetadata(userAddress, searchQuery);
  }

  /**
   * Get all indexed memories for a user
   */
  async getUserMemoriesWithMetadata(
    userAddress: string,
    filters?: MetadataSearchQuery['filters']
  ): Promise<MetadataSearchResult[]> {
    return this.memorySearch.getUserMemoriesWithMetadata(userAddress, filters);
  }

  /**
   * Search by category
   */
  async searchByCategory(
    userAddress: string,
    category: string,
    additionalFilters?: Omit<MetadataSearchQuery['filters'], 'category'>
  ): Promise<MetadataSearchResult[]> {
    return this.memorySearch.searchByCategory(userAddress, category, additionalFilters);
  }

  /**
   * Search by time range
   */
  async searchByTimeRange(
    userAddress: string,
    startDate: Date,
    endDate: Date,
    additionalFilters?: Omit<MetadataSearchQuery['filters'], 'dateRange'>
  ): Promise<MetadataSearchResult[]> {
    return this.memorySearch.searchByTimeRange(userAddress, startDate, endDate, additionalFilters);
  }

  // ==================== KNOWLEDGE GRAPH OPERATIONS (Delegate to KnowledgeGraphManager) ====================

  /**
   * Upload with full indexing (HNSW + knowledge graph)
   */
  async uploadWithFullIndexing(
    content: string | Uint8Array,
    metadata: MemoryMetadata,
    userAddress: string,
    options: BlobUploadOptions
  ): Promise<WalrusUploadResult & { vectorId: number; graphExtracted: boolean }> {
    const result = await this.uploadWithIndexing(content, metadata, userAddress, options);

    let graphExtracted = false;

    if (this.graphService && typeof content === 'string') {
      try {
        const extractionResult = await this.knowledgeGraph.extractKnowledgeGraph(
          content,
          result.blobId,
          { confidenceThreshold: 0.6 }
        );

        if (extractionResult.confidence > 0.5) {
          this.knowledgeGraph.addToUserGraph(
            userAddress,
            extractionResult.entities,
            extractionResult.relationships,
            result.blobId
          );
          graphExtracted = true;
        }
      } catch (error) {
        console.warn('⚠️ Knowledge graph extraction failed:', error);
      }
    }

    return {
      ...result,
      graphExtracted
    };
  }

  /**
   * Extract knowledge graph from content
   */
  async extractKnowledgeGraph(
    content: string,
    memoryId: string,
    options: {
      confidenceThreshold?: number;
      includeEmbeddings?: boolean;
    } = {}
  ): Promise<GraphExtractionResult> {
    return this.knowledgeGraph.extractKnowledgeGraph(content, memoryId, options);
  }

  /**
   * Extract knowledge graph and store in user's graph
   *
   * Combines extraction and storage in one operation.
   * Used by memory.create() pipeline.
   */
  async extractAndStoreKnowledgeGraph(
    content: string,
    memoryId: string,
    userAddress: string,
    options: {
      confidenceThreshold?: number;
      includeEmbeddings?: boolean;
    } = {}
  ): Promise<GraphExtractionResult> {
    // Extract entities and relationships
    const result = await this.knowledgeGraph.extractKnowledgeGraph(content, memoryId, options);

    // Store in user's graph if extraction was successful
    if (result.confidence > 0.5 && (result.entities.length > 0 || result.relationships.length > 0)) {
      try {
        // Ensure user graph exists
        await this.knowledgeGraph.getUserKnowledgeGraph(userAddress);

        // Add to user's graph
        this.knowledgeGraph.addToUserGraph(
          userAddress,
          result.entities,
          result.relationships,
          memoryId
        );
      } catch (storeError) {
        console.warn('Failed to store knowledge graph:', storeError);
        // Don't throw - extraction was successful, storage is optional
      }
    }

    return result;
  }

  /**
   * Search knowledge graph
   */
  async searchKnowledgeGraph(
    userAddress: string,
    query: {
      keywords?: string[];
      entityTypes?: string[];
      relationshipTypes?: string[];
      searchText?: string;
      maxHops?: number;
      limit?: number;
    }
  ) {
    return this.knowledgeGraph.searchKnowledgeGraph(userAddress, query);
  }

  /**
   * Find related entities
   */
  async findRelatedEntities(
    userAddress: string,
    seedEntityIds: string[],
    options: {
      maxHops?: number;
      relationshipTypes?: string[];
      includeWeights?: boolean;
    } = {}
  ) {
    return this.knowledgeGraph.findRelatedEntities(userAddress, seedEntityIds, options);
  }

  /**
   * Batch extract knowledge graphs
   */
  async extractKnowledgeGraphBatch(
    memories: Array<{ id: string; content: string }>,
    userAddress: string,
    options: {
      batchSize?: number;
      delayMs?: number;
      confidenceThreshold?: number;
    } = {}
  ): Promise<GraphExtractionResult[]> {
    return this.knowledgeGraph.extractKnowledgeGraphBatch(memories, userAddress, options);
  }

  /**
   * Get user's knowledge graph
   */
  async getUserKnowledgeGraph(userAddress: string): Promise<KnowledgeGraph> {
    return this.knowledgeGraph.getUserKnowledgeGraph(userAddress);
  }

  /**
   * Save knowledge graph to Walrus
   */
  async saveKnowledgeGraphToWalrus(userAddress: string): Promise<string | null> {
    const graph = await this.knowledgeGraph.getUserKnowledgeGraph(userAddress);

    if (!this.knowledgeGraph.isGraphDirty(userAddress)) {
      return null;
    }

    try {
      const graphData = this.knowledgeGraph.serializeGraph(userAddress);
      if (!graphData) return null;

      const graphBytes = new TextEncoder().encode(graphData);

      console.log(`💾 Saving knowledge graph for user ${userAddress} to Walrus...`);
      console.log(`📊 Graph size: ${graph.entities.length} entities, ${graph.relationships.length} relationships`);

      this.knowledgeGraph.markGraphAsSaved(userAddress);

      return `graph_${userAddress}_${Date.now()}`;
    } catch (error) {
      console.error('❌ Failed to save knowledge graph:', error);
      throw error;
    }
  }

  /**
   * Start background graph persistence
   */
  startGraphPersistence(intervalMs: number = 5 * 60 * 1000) {
    if (!this.graphService) {
      console.warn('Knowledge Graph not initialized - skipping persistence setup');
      return;
    }

    console.log(`🔄 Starting knowledge graph auto-persistence (every ${intervalMs / 1000}s)`);

    setInterval(async () => {
      const users = this.knowledgeGraph.getCachedUsers();
      for (const userAddress of users) {
        if (this.knowledgeGraph.isGraphDirty(userAddress)) {
          try {
            const blobId = await this.saveKnowledgeGraphToWalrus(userAddress);
            if (blobId) {
              console.log(`💾 Auto-saved knowledge graph for ${userAddress}: ${blobId}`);
            }
          } catch (error) {
            console.error(`Failed to auto-save knowledge graph for ${userAddress}:`, error);
          }
        }
      }
    }, intervalMs);
  }

  /**
   * Get graph statistics
   */
  getGraphStatistics(userAddress: string) {
    return this.knowledgeGraph.getGraphStatistics(userAddress);
  }

  /**
   * Get knowledge graph analytics
   */
  getKnowledgeGraphAnalytics(userAddress: string) {
    return this.knowledgeGraph.getKnowledgeGraphAnalytics(userAddress);
  }

  // ==================== QUILT BATCH OPERATIONS (Delegate to QuiltBatchManager) ====================

  /**
   * Upload multiple memories as a Quilt
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
    }>,
    options: {
      signer: UnifiedSigner;
      epochs?: number;
      userAddress: string;
    }
  ): Promise<{
    quiltId: string;
    files: Array<{ identifier: string; blobId: string }>;
    uploadTimeMs: number;
  }> {
    return this.quiltBatch.uploadMemoryBatch(memories, options);
  }

  /**
   * Retrieve all files from a Quilt
   */
  async getQuiltFiles(quiltId: string): Promise<Array<WalrusFile>> {
    return this.quiltBatch.getQuiltFiles(quiltId);
  }

  /**
   * Query Quilt files by tags
   */
  async getQuiltFilesByTags(
    quiltId: string,
    tagFilters: Array<Record<string, string>>
  ): Promise<Array<WalrusFile>> {
    return this.quiltBatch.getQuiltFilesByTags(quiltId, tagFilters);
  }

  /**
   * Upload raw files as a Quilt (non-memory data)
   */
  async uploadFilesBatch(
    files: Array<{
      identifier: string;
      data: Uint8Array;
      tags?: Record<string, string>;
    }>,
    options: {
      signer: UnifiedSigner;
      epochs?: number;
      userAddress: string;
    }
  ): Promise<{
    quiltId: string;
    files: Array<{ identifier: string; blobId: string }>;
    uploadTimeMs: number;
    totalSize: number;
    gasSaved: string;
  }> {
    return this.quiltBatch.uploadFilesBatch(files, options);
  }

  /**
   * Retrieve a specific file by identifier from a Quilt
   */
  async getFileByIdentifier(
    quiltId: string,
    identifier: string
  ): Promise<{
    identifier: string;
    content: Uint8Array;
    tags: Record<string, string>;
    retrievalTimeMs: number;
  }> {
    return this.quiltBatch.getFileByIdentifier(quiltId, identifier);
  }

  /**
   * Query files by category from a Quilt
   */
  async getFilesByCategory(
    quiltId: string,
    category: string
  ): Promise<Array<WalrusFile>> {
    return this.quiltBatch.getFilesByCategory(quiltId, category);
  }

  /**
   * Query files by importance threshold from a Quilt
   */
  async getFilesByImportance(
    quiltId: string,
    minImportance: number
  ): Promise<Array<WalrusFile>> {
    return this.quiltBatch.getFilesByImportance(quiltId, minImportance);
  }

  /**
   * List all patches in a Quilt with their metadata
   */
  async listQuiltPatches(quiltId: string): Promise<Array<{
    identifier: string;
    quiltPatchId: string;
    tags: Record<string, string>;
  }>> {
    return this.quiltBatch.listQuiltPatches(quiltId);
  }

  /**
   * Get all memory packages from a Quilt as JSON
   * Used for indexing Quilt memories into local HNSW index
   */
  async getAllMemoryPackages(quiltId: string) {
    return this.quiltBatch.getAllMemoryPackages(quiltId);
  }

  /**
   * Get the QuiltBatchManager instance for advanced operations
   */
  get quiltBatchManager(): QuiltBatchManager {
    return this.quiltBatch;
  }

  // ==================== BLOB ATTRIBUTES (Delegate to BlobAttributesManager) ====================

  /**
   * Set attributes on a Blob object
   */
  async setBlobAttributes(
    blobObjectId: string,
    attributes: Record<string, string>,
    signer: UnifiedSigner
  ): Promise<string> {
    return this.blobAttributes.setBlobAttributes(blobObjectId, attributes, signer);
  }

  /**
   * Get attributes from a Blob object
   */
  async getBlobAttributes(
    blobObjectId: string,
    attributeKeys?: string[]
  ): Promise<Record<string, string>> {
    return this.blobAttributes.getBlobAttributes(blobObjectId, attributeKeys);
  }

  /**
   * Update blob attributes
   */
  async updateBlobAttributes(
    blobObjectId: string,
    attributes: Record<string, string>,
    signer: UnifiedSigner
  ): Promise<string> {
    return this.blobAttributes.updateBlobAttributes(blobObjectId, attributes, signer);
  }

  /**
   * Remove blob attributes
   */
  async removeBlobAttributes(
    blobObjectId: string,
    attributeKeys: string[],
    signer: UnifiedSigner
  ): Promise<string> {
    return this.blobAttributes.removeBlobAttributes(blobObjectId, attributeKeys, signer);
  }

  /**
   * Query memories by attributes
   */
  async queryMemoriesByAttributes(
    filters: Record<string, string>,
    owner: string,
    walrusPackageId: string
  ): Promise<Array<{
    blobObjectId: string;
    blobId: string;
    attributes: Record<string, string>;
  }>> {
    return this.blobAttributes.queryMemoriesByAttributes(filters, owner, walrusPackageId);
  }

  // ==================== METADATA OPERATIONS (Delegate to WalrusMetadataManager) ====================

  /**
   * Build Walrus metadata structure
   */
  private buildWalrusMetadata(
    contentSize: number,
    options: {
      category?: string;
      topic?: string;
      importance?: number;
      embedding?: number[];
      embeddingBlobId?: string;
      graphBlobId?: string;
      graphEntityIds?: string[];
      graphEntityCount?: number;
      graphRelationshipCount?: number;
      vectorId?: number;
      isEncrypted?: boolean;
      encryptionType?: string;
      sealIdentity?: string;
      customFields?: Record<string, string>;
    }
  ): WalrusMemoryMetadata {
    return this.walrusMetadata.buildWalrusMetadata(contentSize, options);
  }

  /**
   * Attach metadata to a Blob object
   */
  async attachMetadataToBlob(
    blobId: string,
    metadata: WalrusMemoryMetadata,
    signer: UnifiedSigner
  ): Promise<{ digest: string; effects: any }> {
    const walrusPackageId = this.config.network === 'mainnet'
      ? '0x<mainnet-walrus-package-id>'
      : '0x<testnet-walrus-package-id>';

    return this.walrusMetadata.attachMetadataToBlob(blobId, metadata, signer, walrusPackageId);
  }

  /**
   * Retrieve metadata from a Blob object
   */
  async retrieveBlobMetadata(blobObjectId: string): Promise<WalrusMemoryMetadata | null> {
    return this.walrusMetadata.retrieveBlobMetadata(blobObjectId);
  }

  // ==================== ANALYTICS AND STATS ====================

  /**
   * Get search analytics
   */
  getSearchAnalytics(userAddress: string) {
    return this.memorySearch.getSearchAnalytics(userAddress);
  }

  /**
   * Get storage statistics
   */
  async getStats() {
    const memoryStats = await this.memorySearch.getServiceStats();

    return {
      network: this.config.network || 'testnet',
      useUploadRelay: this.config.useUploadRelay ?? true,
      epochs: this.config.epochs || 3,
      hasEncryption: !!this.config.sealService,
      hasBatching: !!this.config.batchService,
      hasSearch: !!(this.embeddingService && this.memoryIndexService),
      indexedUsers: memoryStats?.totalUsers || 0,
      totalIndexedMemories: memoryStats?.totalMemories || 0,
      memoryIndexStats: memoryStats
    };
  }

  // ==================== COMPATIBILITY METHODS ====================

  /**
   * Legacy upload method for backward compatibility
   */
  async upload(
    content: Uint8Array | string,
    metadata: MemoryMetadata,
    options?: Partial<BlobUploadOptions>
  ): Promise<WalrusUploadResult> {
    const data = typeof content === 'string' ? new TextEncoder().encode(content) : content;

    const uploadOptions: BlobUploadOptions = {
      signer: options?.signer!,
      epochs: options?.epochs ?? this.config.epochs ?? 3,
      deletable: options?.deletable ?? true,
      useUploadRelay: options?.useUploadRelay,
      encrypt: options?.encrypt,
      metadata: {
        'content-type': metadata.contentType,
        'category': metadata.category,
        'topic': metadata.topic,
        'importance': metadata.importance.toString(),
        ...(options?.metadata || {})
      }
    };

    return this.uploadBlob(data, uploadOptions);
  }

  /**
   * Legacy retrieve method for backward compatibility
   */
  async retrieve(blobId: string): Promise<{
    content: Uint8Array;
    metadata: MemoryMetadata;
  }> {
    const result = await this.retrieveMemoryPackage(blobId);

    return {
      content: result.content,
      metadata: result.metadata
    };
  }

  /**
   * Legacy list method (not implemented)
   */
  async list(filter?: any): Promise<Array<{
    blobId: string;
    metadata: MemoryMetadata
  }>> {
    console.warn('StorageService.list() not yet implemented - requires metadata storage');
    return [];
  }
}
