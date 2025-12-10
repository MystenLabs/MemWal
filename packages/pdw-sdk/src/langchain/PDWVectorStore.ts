/**
 * PDWVectorStore - LangChain VectorStore implementation for Personal Data Wallet
 *
 * Integrates PDW's decentralized storage (Walrus) and vector search (HNSW) with LangChain.
 * Enables RAG workflows with memories stored on Sui blockchain and Walrus.
 *
 * Features:
 * - Decentralized vector storage on Walrus
 * - HNSW-powered similarity search (browser-compatible WebAssembly)
 * - Blockchain-backed ownership via Sui
 * - SEAL encryption for privacy (optional)
 * - Memory metadata and filtering
 *
 * @example
 * ```typescript
 * import { PDWVectorStore, PDWEmbeddings } from 'personal-data-wallet-sdk/langchain';
 * import { useCurrentAccount, useSuiClient } from '@mysten/dapp-kit';
 *
 * const embeddings = new PDWEmbeddings({ geminiApiKey });
 * const vectorStore = new PDWVectorStore(embeddings, {
 *   userAddress: account.address,
 *   packageId: '0x...',
 *   walrusAggregator: 'https://aggregator.walrus-testnet.walrus.space',
 * });
 *
 * // Add documents (requires Sui wallet signing)
 * await vectorStore.addDocuments([
 *   { pageContent: 'Hello world', metadata: { category: 'greeting' } }
 * ], { account, signAndExecute, client });
 *
 * // Search
 * const results = await vectorStore.similaritySearch('hi', 5);
 * ```
 */

import { VectorStore } from '@langchain/core/vectorstores';
import { Document } from '@langchain/core/documents';
import type { EmbeddingsInterface } from '@langchain/core/embeddings';
import type { Callbacks } from '@langchain/core/callbacks/manager';
import type { MaxMarginalRelevanceSearchOptions } from '@langchain/core/vectorstores';
import { ClientMemoryManager } from '../client/ClientMemoryManager';
import type { ClientMemoryManagerConfig } from '../client/ClientMemoryManager';
import { MemoryIndexService } from '../services/MemoryIndexService';
import type { MemorySearchQuery, MemorySearchResult } from '../services/MemoryIndexService';
import { StorageService } from '../services/StorageService';
import { EmbeddingService } from '../services/EmbeddingService';
import type { Transaction } from '@mysten/sui/transactions';
import type { SuiClient } from '@mysten/sui/client';

export interface PDWVectorStoreConfig {
  // Required
  userAddress: string;

  // Sui Configuration
  packageId: string;
  accessRegistryId?: string;
  network?: 'mainnet' | 'testnet' | 'devnet';

  // Walrus Configuration
  walrusPublisher?: string;
  walrusAggregator?: string;
  walrusNetwork?: 'testnet' | 'mainnet';

  // AI Configuration (for MemoryIndexService)
  geminiApiKey: string;
  embeddingModel?: string;
  embeddingDimensions?: number;

  // Vector Index Configuration
  maxElements?: number;
  efConstruction?: number;
  m?: number;

  // Memory Configuration
  defaultCategory?: string;
  defaultImportance?: number;
  encryptionEnabled?: boolean;

  // SEAL Configuration
  sealServerObjectIds?: string[];
}

export interface PDWAddDocumentOptions {
  // Sui wallet signing (required for adding documents)
  account: { address: string };
  signAndExecute: (params: { transaction: Transaction }, callbacks: {
    onSuccess: (result: any) => void;
    onError: (error: Error) => void;
  }) => void;
  client: SuiClient;

  // Optional memory metadata
  category?: string;
  importance?: number;
  tags?: string[];
  encrypt?: boolean;
  onProgress?: (status: string) => void;
}

/**
 * LangChain VectorStore implementation using Personal Data Wallet
 *
 * This class wraps PDW's ClientMemoryManager and MemoryIndexService to provide
 * a standard LangChain VectorStore interface while preserving all PDW features:
 * - Decentralized storage on Walrus
 * - Blockchain ownership via Sui
 * - SEAL encryption
 * - HNSW vector search
 */
export class PDWVectorStore extends VectorStore {
  private clientMemoryManager!: ClientMemoryManager;
  private memoryIndexService!: MemoryIndexService;
  private storageService!: StorageService;
  private embeddingService!: EmbeddingService;
  private config: PDWVectorStoreConfig;

  // Track document to blobId mapping
  private documentMapping = new Map<string, string>(); // blobId -> documentId

  constructor(
    embeddings: EmbeddingsInterface,
    config: PDWVectorStoreConfig
  ) {
    super(embeddings, {});
    this.config = config;

    // Initialize PDW services
    this.initializeServices();
  }

  private initializeServices() {
    // Initialize ClientMemoryManager
    const managerConfig: ClientMemoryManagerConfig = {
      packageId: this.config.packageId,
      accessRegistryId: this.config.accessRegistryId || '',
      walrusAggregator: this.config.walrusAggregator || 'https://aggregator.walrus-testnet.walrus.space',
      geminiApiKey: this.config.geminiApiKey,
      sealServerObjectIds: this.config.sealServerObjectIds,
      walrusNetwork: this.config.walrusNetwork || 'testnet',
      enableLocalIndexing: true,
    };

    this.clientMemoryManager = new ClientMemoryManager(managerConfig);

    // Initialize services
    this.embeddingService = new EmbeddingService({
      apiKey: this.config.geminiApiKey,
      model: this.config.embeddingModel || 'text-embedding-004',
      dimensions: this.config.embeddingDimensions || 768,
    });

    this.storageService = new StorageService({
      walrusPublisherUrl: this.config.walrusPublisher,
      walrusAggregatorUrl: this.config.walrusAggregator || 'https://aggregator.walrus-testnet.walrus.space',
      network: (this.config.network === 'devnet' ? 'testnet' : this.config.network) || 'testnet',
    });

    this.memoryIndexService = new MemoryIndexService(
      this.storageService,
      {
        maxElements: this.config.maxElements || 10000,
        dimension: this.config.embeddingDimensions || 768,
        efConstruction: this.config.efConstruction || 200,
        m: this.config.m || 16,
      }
    );

    // Connect embedding service to index service
    this.memoryIndexService.initialize(this.embeddingService, this.storageService);
  }

  /**
   * Create PDWVectorStore from documents (LangChain factory pattern)
   *
   * @param docs - Documents to add
   * @param embeddings - Embeddings interface
   * @param dbConfig - Combined config object containing both PDWVectorStoreConfig and PDWAddDocumentOptions
   */
  static async fromDocuments(
    docs: Document[],
    embeddings: EmbeddingsInterface,
    dbConfig: PDWVectorStoreConfig & { addOptions?: PDWAddDocumentOptions }
  ): Promise<PDWVectorStore> {
    const { addOptions, ...config } = dbConfig;
    const instance = new PDWVectorStore(embeddings, config as PDWVectorStoreConfig);

    if (addOptions) {
      await instance.addDocuments(docs, addOptions);
    }

    return instance;
  }

  /**
   * Create PDWVectorStore from texts (LangChain factory pattern)
   *
   * @param texts - Text strings to add
   * @param metadatas - Metadata for each text
   * @param embeddings - Embeddings interface
   * @param dbConfig - Combined config object containing both PDWVectorStoreConfig and PDWAddDocumentOptions
   */
  static async fromTexts(
    texts: string[],
    metadatas: object[] | object,
    embeddings: EmbeddingsInterface,
    dbConfig: PDWVectorStoreConfig & { addOptions?: PDWAddDocumentOptions }
  ): Promise<PDWVectorStore> {
    const docs = texts.map((text, i) => {
      const metadata = Array.isArray(metadatas) ? metadatas[i] : metadatas;
      return new Document({ pageContent: text, metadata });
    });
    return PDWVectorStore.fromDocuments(docs, embeddings, dbConfig);
  }

  /**
   * Add documents to the vector store
   *
   * This creates memories on Sui blockchain and stores them on Walrus.
   * Requires wallet signing via PDWAddDocumentOptions.
   */
  async addDocuments(
    documents: Document[],
    options?: PDWAddDocumentOptions
  ): Promise<string[]> {
    if (!options) {
      throw new Error(
        'PDWVectorStore.addDocuments requires options with wallet signing. ' +
        'Pass { account, signAndExecute, client } to sign transactions.'
      );
    }

    const blobIds: string[] = [];

    for (const doc of documents) {
      try {
        if (options.onProgress) {
          options.onProgress(`Creating memory: ${doc.pageContent.substring(0, 50)}...`);
        }

        // Create memory using ClientMemoryManager
        // This handles: embedding → encryption → Walrus upload → on-chain registration
        const blobId = await this.clientMemoryManager.createMemory({
          content: doc.pageContent,
          category: options.category || doc.metadata?.category || this.config.defaultCategory || 'general',
          account: options.account,
          signAndExecute: options.signAndExecute,
          client: options.client,
          onProgress: options.onProgress,
        });

        blobIds.push(blobId);
        this.documentMapping.set(blobId, doc.id || blobId);

        if (options.onProgress) {
          options.onProgress(`✅ Memory created: ${blobId}`);
        }
      } catch (error) {
        console.error(`Failed to add document:`, error);
        throw new Error(
          `Failed to add document: ${error instanceof Error ? error.message : String(error)}`
        );
      }
    }

    return blobIds;
  }

  /**
   * Add vectors directly to the store
   *
   * This is useful when you already have embeddings and want to avoid regenerating them.
   */
  async addVectors(
    vectors: number[][],
    documents: Document[],
    options?: PDWAddDocumentOptions
  ): Promise<string[]> {
    if (vectors.length !== documents.length) {
      throw new Error('Vectors and documents must have the same length');
    }

    // Note: Currently ClientMemoryManager generates embeddings internally
    // For now, we'll call addDocuments which will regenerate embeddings
    // TODO: Add support for passing pre-computed embeddings to ClientMemoryManager
    return this.addDocuments(documents, options);
  }

  /**
   * Similarity search with score (core LangChain method)
   */
  async similaritySearchVectorWithScore(
    query: number[],
    k: number,
    filter?: Record<string, any>
  ): Promise<[Document, number][]> {
    // Build search query for MemoryIndexService
    const searchQuery: MemorySearchQuery = {
      vector: query,
      userAddress: this.config.userAddress,
      k: k || 5,
      threshold: filter?.minSimilarity || 0.0,
      categories: filter?.category ? [filter.category] : filter?.categories,
      tags: filter?.tags,
      dateRange: filter?.dateRange,
      importanceRange: filter?.importanceRange,
      includeContent: false, // Don't fetch content by default (can be slow with decryption)
    };

    // Search using MemoryIndexService
    const results = await this.memoryIndexService.searchMemories(searchQuery);

    // Convert to LangChain format
    return results.map((result: MemorySearchResult) => {
      // Use metadata topic as pageContent if content not included
      const pageContent = result.metadata?.topic || result.metadata?.category || '';

      const doc = new Document({
        pageContent,
        metadata: {
          ...result.metadata,
          blobId: result.blobId,
          memoryId: result.memoryId,
          similarity: result.similarity,
          relevanceScore: result.relevanceScore,
        },
      });

      return [doc, result.similarity] as [Document, number];
    });
  }

  /**
   * Similarity search (standard LangChain method)
   */
  async similaritySearch(
    query: string,
    k: number = 5,
    filter?: Record<string, any>
  ): Promise<Document[]> {
    const resultsWithScore = await this.similaritySearchWithScore(query, k, filter);
    return resultsWithScore.map(([doc]) => doc);
  }

  /**
   * Similarity search with score using query string
   */
  async similaritySearchWithScore(
    query: string,
    k: number = 5,
    filter?: Record<string, any>
  ): Promise<[Document, number][]> {
    // Generate query embedding
    const embedding = await this.embeddings.embedQuery(query);
    return this.similaritySearchVectorWithScore(embedding, k, filter);
  }

  /**
   * Delete documents by IDs (blob IDs)
   */
  async delete(params: { ids: string[] }): Promise<void> {
    for (const blobId of params.ids) {
      try {
        // Remove from memory index
        // Note: This doesn't delete from Walrus or blockchain
        // Those are immutable - we just remove from local index
        await this.memoryIndexService.removeMemory(this.config.userAddress, blobId);
        this.documentMapping.delete(blobId);
      } catch (error) {
        console.error(`Failed to delete document ${blobId}:`, error);
      }
    }
  }

  /**
   * Maximum marginal relevance search
   * Finds documents that are similar to the query but diverse from each other
   */
  async maxMarginalRelevanceSearch(
    query: string,
    options: MaxMarginalRelevanceSearchOptions<this["FilterType"]>,
    _callbacks?: Callbacks
  ): Promise<Document[]> {
    const k = options.k ?? 4;
    const fetchK = options.fetchK ?? 20;
    const lambda = options.lambda ?? 0.5;

    // Generate query embedding
    const queryEmbedding = await this.embeddings.embedQuery(query);

    // Handle filter (can be string or object from base class)
    const filterObj = typeof options.filter === 'object' && options.filter !== null
      ? options.filter as Record<string, any>
      : {};

    // Fetch more results than needed
    const searchQuery: MemorySearchQuery = {
      vector: queryEmbedding,
      userAddress: this.config.userAddress,
      k: fetchK,
      threshold: filterObj.minSimilarity || 0.0,
      categories: filterObj.categories,
      tags: filterObj.tags,
      includeContent: false,
      diversityFactor: 1 - lambda, // Higher diversity factor = more diverse results
    };

    const results = await this.memoryIndexService.searchMemories(searchQuery);

    // Convert to documents and apply MMR
    const documents = results.slice(0, k).map((result: MemorySearchResult) => {
      const pageContent = result.metadata?.topic || result.metadata?.category || '';

      return new Document({
        pageContent,
        metadata: {
          ...result.metadata,
          blobId: result.blobId,
          memoryId: result.memoryId,
          similarity: result.similarity,
          relevanceScore: result.relevanceScore,
        },
      });
    });

    return documents;
  }

  /**
   * Get statistics about the vector store
   */
  async getStats(): Promise<{
    totalMemories: number;
    categoryCounts: Record<string, number>;
    importanceDistribution: Record<number, number>;
    averageImportance: number;
    oldestMemory: Date | null;
    newestMemory: Date | null;
    indexSize: number;
  }> {
    return this.memoryIndexService.getIndexStats(this.config.userAddress);
  }

  /**
   * Clear all memories for the current user
   * Note: This only clears the local index, not blockchain or Walrus
   */
  async clear(): Promise<void> {
    await this.memoryIndexService.clearUserIndex(this.config.userAddress);
    this.documentMapping.clear();
  }

  // Required by VectorStore abstract class
  _vectorstoreType(): string {
    return 'pdw';
  }
}
