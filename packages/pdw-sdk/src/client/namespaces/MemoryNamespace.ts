/**
 * Memory Namespace - Complete Memory CRUD Operations
 *
 * Provides simple API for creating, reading, updating, and deleting memories
 * without React hooks or UI dependencies.
 *
 * @module client/namespaces
 */

import type { ServiceContainer } from '../SimplePDWClient';

/**
 * Memory object returned by operations
 */
export interface Memory {
  id: string;
  content: string;
  category?: string;
  importance?: number;
  topic?: string;
  blobId: string;
  vectorId?: number;
  embedding?: number[];
  metadata?: Record<string, any>;
  encrypted?: boolean;
  createdAt: number;
  updatedAt?: number;
}

/**
 * Options for creating a memory
 */
export interface CreateMemoryOptions {
  category?: 'fact' | 'preference' | 'todo' | 'note' | 'general';
  importance?: number; // 1-10
  topic?: string;
  metadata?: Record<string, any>;
  onProgress?: (stage: string, percent: number) => void;
}

/**
 * Options for updating a memory
 */
export interface UpdateMemoryOptions {
  /** New content (will upload new blob to Walrus) */
  content?: string;
  /** New category */
  category?: string;
  /** New importance (1-10) */
  importance?: number;
  /** New topic */
  topic?: string;
  /** New embedding blob ID */
  embeddingBlobId?: string;
  /** New content hash */
  contentHash?: string;
  /** New content size */
  contentSize?: number;
  /** Additional metadata */
  metadata?: Record<string, any>;
}

/**
 * Options for listing memories
 */
export interface ListMemoryOptions {
  category?: string;
  limit?: number;
  offset?: number;
  sortBy?: 'date' | 'importance' | 'relevance';
  order?: 'asc' | 'desc';
}

/**
 * Memory context with related memories
 */
export interface MemoryContext {
  memory: Memory;
  related: Memory[];
  entities?: Array<{
    id: string;
    name: string;
    type: string;
  }>;
  relationships?: Array<{
    source: string;
    target: string;
    type: string;
  }>;
}

/**
 * Memory Namespace
 *
 * Handles all memory CRUD operations
 */
export class MemoryNamespace {
  constructor(private services: ServiceContainer) {}

  /**
   * Create a new memory with automatic processing
   *
   * Pipeline:
   * 1. Auto-classify content (if classifier enabled and category not provided)
   * 2. Generate embedding (if AI enabled)
   * 3. Encrypt content (if encryption enabled)
   * 4. Upload to Walrus
   * 5. Register on Sui blockchain
   * 6. Index locally (if enabled)
   * 7. Extract knowledge graph (if enabled)
   *
   * @param content - Text content to save
   * @param options - Optional metadata and callbacks
   * @returns Created memory with ID and blob ID
   *
   * @example
   * ```typescript
   * // Auto-classify and extract knowledge graph automatically
   * const memory = await pdw.memory.create('I love TypeScript', {
   *   importance: 8,
   *   onProgress: (stage, percent) => console.log(stage, percent)
   * });
   *
   * // Provide category to skip auto-classify
   * const memory = await pdw.memory.create('Meeting at 3pm', {
   *   category: 'todo'
   * });
   * ```
   */
  async create(content: string, options: CreateMemoryOptions = {}): Promise<Memory> {
    const { importance = 5, topic, metadata, onProgress } = options;
    let category: string = options.category || 'general';

    try {
      // Validate content
      if (!content || content.trim().length === 0) {
        throw new Error('Content cannot be empty');
      }

      // Validate importance
      if (importance < 1 || importance > 10) {
        throw new Error('Importance must be between 1 and 10');
      }

      onProgress?.('analyzing', 5);

      // 1. Auto-classify if category not provided
      if (!options.category && this.services.classifier) {
        onProgress?.('classifying', 10);
        try {
          const classifiedCategory = await this.services.classifier.classifyContent(content);
          category = classifiedCategory || 'general';
          console.log(`Auto-classified as: ${category}`);
        } catch (classifyError) {
          console.warn('Auto-classification failed, using default category:', classifyError);
        }
      }

      // 2. Generate embedding
      let embedding: number[] | undefined;
      if (this.services.embedding) {
        onProgress?.('generating embedding', 20);
        const embResult = await this.services.embedding.embedText({
          text: content
        });
        embedding = embResult.vector;
      }

      // 3. Encrypt (if enabled)
      let encryptedContent: Uint8Array | undefined;
      if (this.services.config.features.enableEncryption && this.services.encryption) {
        onProgress?.('encrypting', 50);
        try {
          const contentBytes = new TextEncoder().encode(content);
          const encryptResult = await this.services.encryption.encrypt(
            contentBytes,
            this.services.config.userAddress,
            2 // threshold: require 2 key servers for decryption
          );
          encryptedContent = encryptResult.encryptedObject;
        } catch (error) {
          console.warn('SEAL encryption failed, storing unencrypted:', error);
          // Continue without encryption if it fails
        }
      }

      // 4. Upload to Walrus
      onProgress?.('uploading to Walrus', 40);
      const uploadResult = await this.services.storage.uploadMemoryPackage(
        {
          content,
          embedding: embedding || [],
          metadata: {
            category,
            importance,
            topic: topic || '',
            ...metadata
          },
          encryptedContent,
          identity: this.services.config.userAddress
        },
        {
          signer: this.services.config.signer.getSigner(),
          epochs: 3,
          deletable: true,
          metadata: {
            'category': category,
            'importance': importance.toString(),
            'topic': topic || ''
          }
        }
      );

      // 5. Register on-chain (create Memory object on Sui)
      onProgress?.('registering on blockchain', 60);
      let memoryObjectId: string | undefined;
      // Use modulo to keep vectorId within u32 range (max 4,294,967,295)
      const vectorId = Date.now() % 4294967295;

      if (this.services.tx) {
        try {
          console.log('🔨 Building on-chain transaction...');
          const tx = this.services.tx.buildCreateMemoryRecordLightweight({
            category,
            vectorId,
            blobId: uploadResult.blobId,
            blobObjectId: '', // Optional: Walrus blob object ID if available
            importance
          });

          // SerialTransactionExecutor handles gas coin management and prevents equivocation
          // No manual retry needed - executor caches object versions automatically
          console.log('📤 Executing on-chain transaction (via SerialTransactionExecutor)...');
          const txResult = await this.services.tx.executeTransaction(
            tx,
            this.services.config.signer.getSigner()
          );

          console.log('📋 Transaction result:', txResult.status, txResult.digest);

          if (txResult.status === 'success') {
            // Get created Memory object ID
            const memoryObject = txResult.createdObjects?.find(
              (obj: any) => obj.objectType?.includes('::memory::Memory')
            );
            memoryObjectId = memoryObject?.objectId;
            console.log('✅ Memory registered on-chain:', memoryObjectId);
          } else {
            console.warn('❌ Failed to register memory on-chain:', txResult.error);
          }
        } catch (txError: any) {
          console.warn('❌ On-chain registration failed:', txError.message);
        }
      } else {
        console.log('TransactionService not available, skipping on-chain registration');
      }

      // 6. Index locally (if enabled)
      // NOTE: We do NOT store content in index metadata to prevent data leakage
      // when index is saved to Walrus. Content should be retrieved from encrypted
      // Walrus blob using blobId when needed.
      if (this.services.vector && embedding) {
        onProgress?.('indexing vector', 80);
        const spaceId = this.services.config.userAddress;

        // Index metadata - NO content field for privacy
        const indexMetadata = {
          ...metadata,
          blobId: uploadResult.blobId,
          memoryObjectId,
          category,
          importance,
          topic: topic || '',
          timestamp: Date.now()
        };

        // Auto-create index if it doesn't exist
        try {
          await this.services.vector.addVector(spaceId, vectorId, embedding, indexMetadata);
        } catch (error: any) {
          if (error.message?.includes('not found')) {
            // Index doesn't exist, create it first
            await this.services.vector.createIndex(spaceId, embedding.length);
            await this.services.vector.addVector(spaceId, vectorId, embedding, indexMetadata);
          } else {
            throw error;
          }
        }
      }

      // 7. Extract knowledge graph (if enabled)
      if (this.services.config.features.enableKnowledgeGraph) {
        onProgress?.('extracting knowledge graph', 95);
        try {
          const graphResult = await this.services.storage.extractAndStoreKnowledgeGraph(
            content,
            uploadResult.blobId,
            this.services.config.userAddress
          );
          console.log(`Knowledge graph extracted: ${graphResult.entities.length} entities, ${graphResult.relationships.length} relationships`);
        } catch (graphError) {
          console.warn('Knowledge graph extraction failed:', graphError);
          // Continue without failing - graph extraction is optional
        }
      }

      onProgress?.('complete', 100);

      return {
        id: memoryObjectId || uploadResult.blobId,
        content,
        category,
        importance,
        topic,
        blobId: uploadResult.blobId,
        vectorId,
        embedding,
        metadata: {
          category,
          importance,
          topic,
          ...metadata
        },
        encrypted: !!encryptedContent,
        createdAt: Date.now()
      };
    } catch (error) {
      throw new Error(`Failed to create memory: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * Get a memory by ID
   *
   * @param memoryId - Memory ID (blob ID)
   * @returns Memory with full metadata
   */
  async get(memoryId: string): Promise<Memory> {
    try {
      const memoryPackage = await this.services.storage.retrieveMemoryPackage(memoryId);

      if (memoryPackage.storageApproach === 'json-package' && memoryPackage.memoryPackage) {
        return {
          id: memoryId,
          content: memoryPackage.memoryPackage.content,
          embedding: memoryPackage.memoryPackage.embedding,
          metadata: memoryPackage.memoryPackage.metadata,
          category: memoryPackage.memoryPackage.metadata?.category,
          importance: memoryPackage.memoryPackage.metadata?.importance,
          topic: memoryPackage.memoryPackage.metadata?.topic,
          blobId: memoryId,
          encrypted: memoryPackage.isEncrypted,
          createdAt: memoryPackage.memoryPackage.timestamp
        };
      }

      throw new Error('Memory not found or invalid format');
    } catch (error) {
      throw new Error(`Failed to get memory: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * Update memory record on-chain
   *
   * Updates memory object fields via Sui transaction. Only non-empty/non-zero
   * values will be updated.
   *
   * If content is provided, a new blob will be uploaded to Walrus and
   * the blob_id will be updated on-chain.
   *
   * @param memoryId - Memory object ID on Sui
   * @param updates - Fields to update
   * @returns Updated memory object
   *
   * @example
   * ```typescript
   * // Update importance and topic
   * const updated = await pdw.memory.update(memoryId, {
   *   importance: 9,
   *   topic: 'programming'
   * });
   *
   * // Update content (creates new Walrus blob)
   * const updated = await pdw.memory.update(memoryId, {
   *   content: 'Updated content here'
   * });
   * ```
   */
  async update(memoryId: string, updates: UpdateMemoryOptions): Promise<Memory> {
    try {
      // Get current memory for comparison
      const current = await this.get(memoryId);

      let newBlobId = '';
      let newEmbeddingBlobId = updates.embeddingBlobId || '';
      let newContentHash = updates.contentHash || '';
      let newContentSize = updates.contentSize || 0;

      // If content is provided, upload new blob to Walrus
      if (updates.content) {
        // Generate new embedding if AI is enabled
        let embedding: number[] | undefined;
        if (this.services.embedding) {
          const embResult = await this.services.embedding.embedText({
            text: updates.content
          });
          embedding = embResult.vector;
        }

        // Upload new content to Walrus
        const uploadResult = await this.services.storage.uploadMemoryPackage(
          {
            content: updates.content,
            embedding: embedding || [],
            metadata: {
              category: updates.category || current.category,
              importance: updates.importance || current.importance,
              topic: updates.topic || current.topic,
              ...updates.metadata
            },
            identity: this.services.config.userAddress
          },
          {
            signer: this.services.config.signer.getSigner(),
            epochs: 3,
            deletable: true
          }
        );

        newBlobId = uploadResult.blobId;
        newContentSize = updates.content.length;
        newContentHash = uploadResult.blobId; // blob_id is content-addressed
      }

      // Build and execute update transaction
      const tx = this.services.tx!.buildUpdateMemoryRecord({
        memoryId,
        newBlobId,
        newCategory: updates.category || '',
        newTopic: updates.topic || '',
        newImportance: updates.importance || 0,
        newEmbeddingBlobId,
        newContentHash,
        newContentSize
      });

      // Execute transaction
      const result = await this.services.tx!.executeTransaction(
        tx,
        this.services.config.signer.getSigner()
      );

      if (result.status !== 'success') {
        throw new Error(result.error || 'Transaction failed');
      }

      // Update local vector index if needed
      if (this.services.vector && updates.content && this.services.embedding) {
        const embResult = await this.services.embedding.embedText({
          text: updates.content
        });
        await this.services.vector.addVector(
          this.services.config.userAddress,
          current.vectorId || Date.now(),
          embResult.vector,
          { ...current.metadata, ...updates.metadata }
        );
      }

      return {
        ...current,
        content: updates.content || current.content,
        category: updates.category || current.category,
        importance: updates.importance || current.importance,
        topic: updates.topic || current.topic,
        blobId: newBlobId || current.blobId,
        metadata: {
          ...current.metadata,
          ...updates.metadata
        },
        updatedAt: Date.now()
      };
    } catch (error) {
      throw new Error(`Failed to update memory: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * Delete a memory
   *
   * Removes from:
   * - Local vector index
   * - Blockchain records (marks as deleted)
   * Note: Walrus blobs are immutable, can only be marked as deleted
   *
   * @param memoryId - Memory ID to delete
   */
  async delete(memoryId: string): Promise<void> {
    try {
      // Build and execute delete transaction on blockchain
      const tx = await this.services.memory.tx.deleteMemory(memoryId);
      const signer = this.services.config.signer?.getSigner?.() || this.services.config.signer;
      await (signer as any).signAndExecuteTransaction({
        transaction: tx,
      });

      // Remove from local vector index if it exists
      if (this.services.memoryIndex) {
        try {
          await this.services.memoryIndex.removeMemory(
            this.services.config.userAddress,
            memoryId
          );
        } catch (indexError) {
          console.warn(`Failed to remove memory ${memoryId} from local index:`, indexError);
          // Don't fail the delete if index removal fails
        }
      }
    } catch (error) {
      throw new Error(`Failed to delete memory: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * List user memories with pagination
   *
   * @param options - Filter and pagination options
   * @returns Array of memories
   */
  async list(options: ListMemoryOptions = {}): Promise<Memory[]> {
    try {
      const {
        category,
        limit = 50,
        offset = 0,
        sortBy = 'date',
        order = 'desc'
      } = options;

      // Get memories from blockchain using ViewService (direct Sui query)
      // This doesn't require backend API
      const viewService = this.services.viewService;
      if (!viewService) {
        throw new Error('ViewService not available');
      }

      const response = await viewService.getUserMemories(
        this.services.config.userAddress,
        { limit, category }
      );
      const memories = response.data;

      // Filter by category if provided
      let filtered = memories;
      if (category) {
        filtered = memories.filter((m: any) =>
          m.metadata?.category === category ||
          m.fields?.category === category
        );
      }

      // Sort
      const sorted = [...filtered].sort((a: any, b: any) => {
        if (sortBy === 'date') {
          const aTime = a.timestamp || a.createdAt || 0;
          const bTime = b.timestamp || b.createdAt || 0;
          return order === 'desc' ? bTime - aTime : aTime - bTime;
        } else if (sortBy === 'importance') {
          const aImp = a.importance || a.metadata?.importance || 5;
          const bImp = b.importance || b.metadata?.importance || 5;
          return order === 'desc' ? bImp - aImp : aImp - bImp;
        }
        return 0;
      });

      // Paginate
      const paginated = sorted.slice(offset, offset + limit);

      // Convert to Memory format
      return paginated.map((m: any) => ({
        id: m.id || m.blobId,
        content: m.content || '',
        category: m.category || m.metadata?.category,
        importance: m.importance || m.metadata?.importance,
        topic: m.topic || m.metadata?.topic,
        blobId: m.blobId || m.id,
        metadata: m.metadata,
        encrypted: m.encrypted || false,
        createdAt: m.timestamp || m.createdAt || Date.now()
      }));
    } catch (error) {
      throw new Error(`Failed to list memories: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * Create multiple memories in batch using Walrus Quilt
   *
   * Uses Walrus SDK's writeFiles() which automatically batches small blobs
   * into a single Quilt transaction, providing ~90% gas savings.
   *
   * Pipeline (batched):
   * 1. Auto-classify all contents (if classifier enabled)
   * 2. Generate embeddings for all contents (parallel)
   * 3. Encrypt all contents (if encryption enabled)
   * 4. Batch upload to Walrus as Quilt (single transaction!)
   * 5. Register on Sui blockchain (batched PTB)
   * 6. Index locally (batch add to vector index)
   *
   * @param contents - Array of content strings
   * @param options - Shared options for all memories
   * @returns Array of created memories
   *
   * @example
   * ```typescript
   * // Create multiple memories efficiently with Quilt
   * const memories = await pdw.memory.createBatch([
   *   'I love TypeScript',
   *   'Meeting at 3pm tomorrow',
   *   'Remember to buy milk'
   * ], {
   *   category: 'note',
   *   importance: 5
   * });
   * // All 3 memories uploaded in 1 transaction!
   * ```
   */
  async createBatch(
    contents: string[],
    options: CreateMemoryOptions = {}
  ): Promise<Memory[]> {
    const { importance = 5, topic, metadata, onProgress } = options;

    // For single item, use regular create()
    if (contents.length === 1) {
      const memory = await this.create(contents[0], options);
      return [memory];
    }

    try {
      onProgress?.('preparing batch', 5);

      // Step 1: Auto-classify all contents (parallel)
      const categories: string[] = [];
      if (!options.category && this.services.classifier) {
        onProgress?.('classifying', 10);
        const classifyPromises = contents.map(async (content) => {
          try {
            return await this.services.classifier!.classifyContent(content) || 'general';
          } catch {
            return 'general';
          }
        });
        const classifiedCategories = await Promise.all(classifyPromises);
        categories.push(...classifiedCategories);
      } else {
        categories.push(...contents.map(() => options.category || 'general'));
      }

      // Step 2: Generate embeddings (parallel)
      onProgress?.('generating embeddings', 20);
      const embeddings: number[][] = [];
      if (this.services.embedding) {
        const embeddingPromises = contents.map(content =>
          this.services.embedding!.embedText({ text: content }).then(r => r.vector)
        );
        const embeddingResults = await Promise.all(embeddingPromises);
        embeddings.push(...embeddingResults);
      }

      // Step 3: Encrypt all contents (parallel, if enabled)
      onProgress?.('encrypting', 35);
      const encryptedContents: (Uint8Array | undefined)[] = [];
      if (this.services.config.features.enableEncryption && this.services.encryption) {
        const encryptPromises = contents.map(async (content) => {
          try {
            const contentBytes = new TextEncoder().encode(content);
            const result = await this.services.encryption!.encrypt(
              contentBytes,
              this.services.config.userAddress,
              2
            );
            return result.encryptedObject;
          } catch {
            return undefined;
          }
        });
        const encryptResults = await Promise.all(encryptPromises);
        encryptedContents.push(...encryptResults);
      } else {
        encryptedContents.push(...contents.map(() => undefined));
      }

      // Step 4: Batch upload to Walrus using Quilt (single transaction!)
      onProgress?.('uploading to Walrus (Quilt batch)', 50);

      // Prepare batch memories for QuiltBatchManager
      const batchMemories = contents.map((content, i) => ({
        content,
        category: categories[i],
        importance,
        topic: topic || '',
        embedding: embeddings[i] || [],
        encryptedContent: encryptedContents[i] || new TextEncoder().encode(content),
        id: `memory-${Date.now()}-${i}` // Client-side tracking ID
      }));

      const quiltResult = await this.services.storage.uploadMemoryBatch(
        batchMemories,
        {
          signer: this.services.config.signer.getSigner(),
          epochs: 3,
          userAddress: this.services.config.userAddress
        }
      );

      const gasSavedEstimate = contents.length > 1 ? `~${((1 - 1 / contents.length) * 100).toFixed(0)}%` : '0%';
      console.log(`✅ Quilt batch upload complete: ${quiltResult.files.length} files, ${gasSavedEstimate} gas saved, ${quiltResult.uploadTimeMs.toFixed(0)}ms`);

      // Step 5: Register on-chain (batched PTB if available)
      onProgress?.('registering on blockchain', 70);
      const memoryObjectIds: (string | undefined)[] = [];
      const vectorIds: number[] = [];

      if (this.services.tx) {
        // Create memory records for each file in the quilt
        for (let i = 0; i < quiltResult.files.length; i++) {
          const file = quiltResult.files[i];
          const vectorId = (Date.now() + i) % 4294967295;
          vectorIds.push(vectorId);

          try {
            const tx = this.services.tx.buildCreateMemoryRecordLightweight({
              category: categories[i],
              vectorId,
              blobId: file.blobId,
              blobObjectId: '',
              importance
            });

            const txResult = await this.services.tx.executeTransaction(
              tx,
              this.services.config.signer.getSigner()
            );

            if (txResult.status === 'success') {
              const memoryObject = txResult.createdObjects?.find(
                (obj: any) => obj.objectType?.includes('::memory::Memory')
              );
              memoryObjectIds.push(memoryObject?.objectId);
            } else {
              memoryObjectIds.push(undefined);
            }
          } catch (error) {
            console.warn(`Failed to register memory ${i} on-chain:`, error);
            memoryObjectIds.push(undefined);
          }
        }
      }

      // Step 6: Index locally (batch add to vector index)
      onProgress?.('indexing vectors', 90);
      if (this.services.vector && embeddings.length > 0) {
        const spaceId = this.services.config.userAddress;

        for (let i = 0; i < embeddings.length; i++) {
          if (!embeddings[i]) continue;

          const vectorId = vectorIds[i] || (Date.now() + i) % 4294967295;
          const indexMetadata = {
            ...metadata,
            blobId: quiltResult.files[i]?.blobId,
            memoryObjectId: memoryObjectIds[i],
            category: categories[i],
            importance,
            topic: topic || '',
            timestamp: Date.now()
          };

          try {
            await this.services.vector.addVector(spaceId, vectorId, embeddings[i], indexMetadata);
          } catch (error: any) {
            if (error.message?.includes('not found')) {
              await this.services.vector.createIndex(spaceId, embeddings[i].length);
              await this.services.vector.addVector(spaceId, vectorId, embeddings[i], indexMetadata);
            }
          }
        }
      }

      onProgress?.('complete', 100);

      // Build result array
      const memories: Memory[] = contents.map((content, i) => ({
        id: memoryObjectIds[i] || quiltResult.files[i]?.blobId || `batch-${i}`,
        content,
        category: categories[i],
        importance,
        topic,
        blobId: quiltResult.files[i]?.blobId || '',
        vectorId: vectorIds[i],
        embedding: embeddings[i],
        metadata: {
          category: categories[i],
          importance,
          topic,
          quiltId: quiltResult.quiltId,
          ...metadata
        },
        encrypted: !!encryptedContents[i],
        createdAt: Date.now()
      }));

      return memories;

    } catch (error) {
      throw new Error(`Failed to create batch memories: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * Delete multiple memories
   *
   * @param memoryIds - Array of memory IDs to delete
   */
  async deleteBatch(memoryIds: string[]): Promise<void> {
    for (const id of memoryIds) {
      await this.delete(id);
    }
  }

  /**
   * Update multiple memories in batch
   *
   * Updates memories in parallel batches:
   * 1. For updates with new content: uploads new blobs to Walrus
   * 2. Executes on-chain update transactions
   * 3. Updates local vector index if enabled
   *
   * @param updates - Array of {id, content?, category?, importance?, topic?}
   * @returns Array of successfully updated memory IDs
   *
   * @example
   * ```typescript
   * const updatedIds = await pdw.memory.updateBatch([
   *   { id: 'mem1', importance: 9 },
   *   { id: 'mem2', content: 'Updated content' }
   * ]);
   * ```
   */
  async updateBatch(
    updates: Array<{
      id: string;
      content?: string;
      category?: string;
      importance?: number;
      topic?: string;
    }>
  ): Promise<string[]> {
    const successfulIds: string[] = [];
    const BATCH_SIZE = 5;

    for (let i = 0; i < updates.length; i += BATCH_SIZE) {
      const batch = updates.slice(i, i + BATCH_SIZE);

      const batchPromises = batch.map(async (update) => {
        try {
          await this.update(update.id, {
            content: update.content,
            category: update.category,
            importance: update.importance,
            topic: update.topic
          });
          return { success: true, id: update.id };
        } catch (error) {
          const errorMsg = error instanceof Error ? error.message : String(error);
          console.warn(`Failed to update memory ${update.id}:`, errorMsg);
          return { success: false, id: update.id };
        }
      });

      const batchResults = await Promise.all(batchPromises);
      for (const result of batchResults) {
        if (result.success) {
          successfulIds.push(result.id);
        }
      }
    }

    return successfulIds;
  }

  /**
   * Get memory with related context (related memories, knowledge graph)
   *
   * @param memoryId - Memory ID
   * @param options - Context options
   * @returns Memory with context
   */
  async getContext(
    memoryId: string,
    options: { includeRelated?: boolean; includeGraph?: boolean } = {}
  ): Promise<MemoryContext> {
    const memory = await this.get(memoryId);

    const context: MemoryContext = {
      memory,
      related: []
    };

    // Get related memories if requested
    if (options.includeRelated && memory.content) {
      // Use local vector search if available
      try {
        if (this.services.memoryIndex) {
          // Generate embedding for the memory content
          const embedding = this.services.embedding
            ? await this.services.embedding.embedText({ text: memory.content.substring(0, 500) })
            : null;

          if (embedding) {
            const searchResults = await this.services.memoryIndex.searchMemories({
              userAddress: this.services.config.userAddress,
              vector: embedding.vector,
              k: 5
            });

            context.related = searchResults
              .filter((r: any) => r.memoryObjectId !== memoryId)
              .slice(0, 5)
              .map((r: any) => ({
                id: r.memoryObjectId || r.id,
                content: r.content || '',
                category: r.category || 'general',
                importance: r.importance,
                blobId: r.blobId || r.memoryObjectId || r.id,
                metadata: r.metadata,
                createdAt: r.timestamp || Date.now()
              }));
          }
        }
      } catch (error) {
        console.warn('Failed to get related memories:', error);
        context.related = [];
      }
    }

    // Get knowledge graph if requested
    if (options.includeGraph) {
      const graphData = await this.services.storage.searchKnowledgeGraph(
        this.services.config.userAddress,
        { searchText: memory.content, limit: 10 }
      );

      context.entities = graphData.entities.map(e => ({
        id: e.id,
        name: e.label,
        type: e.type
      }));

      context.relationships = graphData.relationships.map(r => ({
        source: r.source,
        target: r.target,
        type: r.type || 'related'
      }));
    }

    return context;
  }

  /**
   * Get memories related to a specific memory
   *
   * @param memoryId - Memory ID
   * @param k - Number of related memories to return
   * @returns Array of related memories
   */
  async getRelated(memoryId: string, k: number = 5): Promise<Memory[]> {
    const memory = await this.get(memoryId);

    if (!memory.content) {
      return [];
    }

    try {
      // Generate embedding for content to find similar memories
      if (!this.services.embedding) {
        console.warn('Embedding service not available for related memories search');
        return [];
      }

      const embResult = await this.services.embedding.embedText({
        text: memory.content.substring(0, 500)
      });

      if (!this.services.memoryIndex) {
        console.warn('Memory index service not available for related memories search');
        return [];
      }

      const searchResults = await this.services.memoryIndex.searchMemories({
        userAddress: this.services.config.userAddress,
        vector: embResult.vector,
        k: k + 1
      });

      return searchResults
        .filter((r: any) => (r.blobId || r.id) !== memoryId)
        .slice(0, k)
        .map((r: any) => ({
          id: r.id,
          content: r.content || '',
          category: r.category,
          importance: r.metadata?.importance,
          blobId: r.blobId || r.id,
          metadata: r.metadata,
          createdAt: r.timestamp ? new Date(r.timestamp).getTime() : Date.now()
        }));
    } catch (error) {
      console.warn('Failed to get related memories:', error);
      return [];
    }
  }

  /**
   * Export memories to file format
   *
   * Exports memories to JSON or CSV format for backup/portability
   *
   * @param options - Export options
   * @returns Exported data as string
   */
  async export(options: {
    format?: 'json' | 'csv';
    includeContent?: boolean;
    includeEmbeddings?: boolean;
    category?: string;
    limit?: number;
  } = {}): Promise<string> {
    const {
      format = 'json',
      includeContent = true,
      includeEmbeddings = false,
      category,
      limit
    } = options;

    try {
      // Get memories
      const memories = await this.list({ category, limit });

      if (format === 'json') {
        // JSON export
        const exportData = memories.map(m => ({
          id: m.id,
          content: includeContent ? m.content : undefined,
          category: m.category,
          importance: m.importance,
          topic: m.topic,
          blobId: m.blobId,
          embedding: includeEmbeddings ? m.embedding : undefined,
          metadata: m.metadata,
          createdAt: m.createdAt,
          updatedAt: m.updatedAt
        }));

        return JSON.stringify(exportData, null, 2);
      } else {
        // CSV export
        const headers = [
          'id',
          'category',
          'importance',
          'topic',
          'blobId',
          'createdAt',
          includeContent ? 'content' : null
        ].filter(Boolean);

        const rows = memories.map(m => [
          m.id,
          m.category || '',
          m.importance || '',
          m.topic || '',
          m.blobId,
          new Date(m.createdAt).toISOString(),
          includeContent ? `"${(m.content || '').replace(/"/g, '""')}"` : null
        ].filter(v => v !== null));

        const csv = [
          headers.join(','),
          ...rows.map(row => row.join(','))
        ].join('\n');

        return csv;
      }
    } catch (error) {
      throw new Error(`Failed to export memories: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}
