/**
 * ClientMemoryManager - Client-side Memory Operations for React dApps
 *
 * Provides a simplified API for creating and retrieving memories in React dApps
 * using @mysten/dapp-kit. Handles the complete flow:
 * - Memory creation: embedding → encryption → Walrus upload → on-chain registration
 * - Memory retrieval: Walrus fetch → SEAL decryption → content extraction
 *
 * Usage:
 * ```typescript
 * const manager = new ClientMemoryManager({
 *   packageId: '0x...',
 *   accessRegistryId: '0x...',
 *   walrusAggregator: 'https://...',
 *   geminiApiKey: 'your-key'
 * });
 *
 * // Create memory
 * const blobId = await manager.createMemory({
 *   content: 'My memory',
 *   account,
 *   signAndExecute,
 *   client,
 *   onProgress: (status) => console.log(status)
 * });
 *
 * // Retrieve memory
 * const content = await manager.retrieveMemory({
 *   blobId: '...',
 *   account,
 *   signPersonalMessage,
 *   client
 * });
 * ```
 */

import { SealClient, SessionKey } from '@mysten/seal';
import { WalrusClient } from '@mysten/walrus';
import { Transaction } from '@mysten/sui/transactions';
import { fromHex } from '@mysten/sui/utils';
import type { SuiClient } from '@mysten/sui/client';
// Import environment detection from browser-safe file (no Node.js deps)
import { isBrowser, isNode } from '../vector/IHnswService';
import type { IHnswService } from '../vector/IHnswService';
import { EmbeddingService } from '../services/EmbeddingService';
import { GeminiAIService } from '../services/GeminiAIService';

export interface ClientMemoryManagerConfig {
  packageId: string;
  accessRegistryId: string;
  walrusAggregator: string;
  geminiApiKey: string;
  sealServerObjectIds?: string[];
  walrusNetwork?: 'testnet' | 'mainnet';
  categories?: string[];
  /** Enable local browser indexing for vector search (default: true) */
  enableLocalIndexing?: boolean;
  /** Pre-initialized HNSW service instance (shared singleton) */
  hnswService?: IHnswService;
  /** Enable SEAL encryption for memory content (default: true) */
  enableEncryption?: boolean;
}

export interface CreateMemoryOptions {
  content: string;
  category?: string;
  account: { address: string };
  signAndExecute: (params: { transaction: Transaction }, callbacks: {
    onSuccess: (result: any) => void;
    onError: (error: Error) => void;
  }) => void;
  client: SuiClient;
  onProgress?: (status: string) => void;
}

export interface RetrieveMemoryOptions {
  blobId: string;
  account: { address: string };
  signPersonalMessage: (params: { message: Uint8Array }) => Promise<{ signature: string }>;
  client: SuiClient;
  onProgress?: (status: string) => void;
}

export interface BatchRetrieveMemoriesOptions {
  blobIds: string[];
  account: { address: string };
  signPersonalMessage: (params: { message: Uint8Array }) => Promise<{ signature: string }>;
  client: SuiClient;
  onProgress?: (status: string, current: number, total: number) => void;
}

export interface BatchRetrieveResult {
  blobId: string;
  content?: string;
  error?: string;
}

interface DecryptionSession {
  sealClient: SealClient;
  sessionKey: SessionKey;
  txBytes: Uint8Array;
}

export interface ClientMemoryMetadata {
  content: string;
  embedding: number[];
  timestamp: number;
}

/**
 * Rich metadata structure aligned with on-chain MemoryMetadata
 * This is extracted during AI analysis and used for:
 * 1. Metadata-based vector embeddings
 * 2. On-chain registration
 * 3. Display in UI
 */
export interface RichMetadataAnalysis {
  category: string;       // e.g., "work"
  topic: string;          // e.g., "Q4 project deadline meeting"
  importance: number;     // 1-10 scale
  summary: string;        // e.g., "Team discussion about Q4 deadlines..."
}

/**
 * Client-side memory manager for React dApps
 */
export class ClientMemoryManager {
  private readonly config: Omit<Required<ClientMemoryManagerConfig>, 'hnswService'> & { enableLocalIndexing: boolean; enableEncryption: boolean; hnswService?: IHnswService };
  private readonly defaultCategories = [
    'personal', 'work', 'education', 'health', 'finance',
    'travel', 'family', 'hobbies', 'goals', 'ideas'
  ];

  // Local indexing services (optional)
  private embeddingService?: EmbeddingService;
  private geminiAIService?: GeminiAIService;
  private hnswService: IHnswService | null = null;
  private hnswServicePromise: Promise<IHnswService> | null = null;

  constructor(config: ClientMemoryManagerConfig) {
    this.config = {
      ...config,
      sealServerObjectIds: config.sealServerObjectIds || [
        '0x73d05d62c18d9374e3ea529e8e0ed6161da1a141a94d3f76ae3fe4e99356db75',
        '0xf5d14a81a982144ae441cd7d64b09027f116a468bd36e7eca494f750591623c8'
      ],
      walrusNetwork: config.walrusNetwork || 'testnet',
      categories: config.categories || this.defaultCategories,
      enableLocalIndexing: config.enableLocalIndexing !== false, // Default: true
      enableEncryption: config.enableEncryption !== false // Default: true (SEAL encryption)
    };

    // Initialize AI services if Gemini API key is provided
    if (this.config.geminiApiKey) {
      this.embeddingService = new EmbeddingService({
        apiKey: this.config.geminiApiKey,
        model: 'text-embedding-004',
        dimensions: 3072
      });

      this.geminiAIService = new GeminiAIService({
        apiKey: this.config.geminiApiKey,
        model: process.env.AI_CHAT_MODEL || 'google/gemini-2.5-flash',
        temperature: 0.1
      });

      console.log('✅ AI services initialized (Embedding + Metadata Extraction)');
    }

    // Initialize local indexing service if enabled
    if (this.config.enableLocalIndexing) {
      // Use pre-initialized HNSW service if provided (shared singleton pattern)
      if (config.hnswService) {
        this.hnswService = config.hnswService;
        console.log('✅ ClientMemoryManager using shared HNSW service instance');
      } else {
        // Create own HNSW service (async via factory)
        const envType = isBrowser() ? 'browser (hnswlib-wasm)' : isNode() ? 'Node.js (hnswlib-node)' : 'unknown';
        console.log(`✅ ClientMemoryManager initializing local indexing (${envType})`);
        this.hnswServicePromise = this.initializeHnswService();
      }
    }
  }

  /**
   * Initialize HNSW service using factory (async)
   * Uses dynamic import to avoid bundling Node.js modules in browser
   */
  private async initializeHnswService(): Promise<IHnswService> {
    try {
      // Dynamic import to avoid webpack bundling Node.js modules at build time
      const { createHnswService } = await import('../vector/createHnswService');

      const service = await createHnswService({
        indexConfig: {
          dimension: 3072,
          maxElements: 10000,
          m: 16,
          efConstruction: 200
        },
        batchConfig: {
          maxBatchSize: 50,
          batchDelayMs: 5000
        }
      });

      this.hnswService = service;
      console.log('✅ ClientMemoryManager HNSW service initialized');
      return service;
    } catch (error) {
      console.error('❌ ClientMemoryManager failed to initialize HNSW service:', error);
      throw error;
    }
  }

  /**
   * Get HNSW service (waits for initialization if needed)
   */
  private async getHnswService(): Promise<IHnswService | null> {
    if (this.hnswService) {
      return this.hnswService;
    }
    if (this.hnswServicePromise) {
      try {
        return await this.hnswServicePromise;
      } catch (error) {
        console.warn('HNSW service initialization failed:', error);
        return null;
      }
    }
    return null;
  }

  // In-memory counter for Node.js environment
  private vectorIdCounters = new Map<string, number>();

  /**
   * Get next sequential vector ID for a user (fits in 32-bit unsigned int)
   * Uses IndexedDB in browser, in-memory counter in Node.js
   */
  private async getNextVectorId(userAddress: string): Promise<number> {
    // Check if IndexedDB is available (browser environment)
    if (typeof indexedDB !== 'undefined') {
      try {
        // Use separate database for counters to avoid version conflicts
        const db = await new Promise<IDBDatabase>((resolve, reject) => {
          const request = indexedDB.open('PDW_VectorCounters', 1);
          request.onsuccess = () => resolve(request.result);
          request.onerror = () => reject(request.error);
          request.onupgradeneeded = (event) => {
            const db = (event.target as IDBOpenDBRequest).result;
            if (!db.objectStoreNames.contains('counters')) {
              db.createObjectStore('counters', { keyPath: 'userAddress' });
            }
          };
        });

        const transaction = db.transaction(['counters'], 'readwrite');
        const store = transaction.objectStore('counters');

        // Get current counter
        const getRequest = store.get(userAddress);
        const currentData = await new Promise<{ userAddress: string; counter: number } | undefined>((resolve) => {
          getRequest.onsuccess = () => resolve(getRequest.result);
          getRequest.onerror = () => resolve(undefined);
        });

        const nextId = (currentData?.counter || 0) + 1;

        // Update counter
        store.put({ userAddress, counter: nextId });

        await new Promise<void>((resolve, reject) => {
          transaction.oncomplete = () => resolve();
          transaction.onerror = () => reject(transaction.error);
        });

        db.close();
        console.log(`✅ Sequential vector ID generated: ${nextId} (from IndexedDB)`);
        return nextId;
      } catch (error) {
        console.warn('⚠️ IndexedDB failed, using in-memory counter:', error);
      }
    }

    // Node.js or IndexedDB failure: use in-memory counter
    const current = this.vectorIdCounters.get(userAddress) || 0;
    const nextId = current + 1;
    this.vectorIdCounters.set(userAddress, nextId);
    console.log(`✅ Sequential vector ID generated: ${nextId} (in-memory)`);
    return nextId;
  }

  /**
   * Create a new memory (3 signatures: Walrus register, certify, on-chain)
   */
  async createMemory(options: CreateMemoryOptions): Promise<string> {
    const { content, category, account, signAndExecute, client, onProgress } = options;

    console.log('🚀 Starting memory creation...');
    onProgress?.('Starting memory creation...');

    try {
      // Step 1: Analyze content (category + importance)
      console.log('🏷️ Step 1: Analyzing content...');
      onProgress?.('Analyzing content with AI...');
      const analysis = await this.analyzeContent(content, category);
      console.log('✅ Analysis:', analysis);

      // Step 2: Build metadata text and generate embedding
      console.log('🔮 Step 2: Building metadata and generating embedding...');
      onProgress?.('Generating metadata embedding...');

      // Build embeddable metadata text
      const metadataText = this.buildMetadataText(analysis);
      console.log('📝 Metadata text for embedding:');
      console.log(metadataText);
      console.log('📊 Metadata fields:', {
        category: analysis.category,
        topic: analysis.topic,
        importance: analysis.importance,
        summaryLength: analysis.summary.length
      });

      // Generate embedding from METADATA (not content)
      const embedding = await this.generateEmbedding(metadataText);
      console.log('✅ Metadata embedding generated:', embedding.length, 'dimensions');
      console.log('   Source: metadata text (not full content)');
      console.log('   Privacy: Only metadata semantics embedded, content stays encrypted');

      // Step 3: Prepare combined data (content + embedding)
      console.log('📦 Step 3: Preparing data...');
      const memoryData: ClientMemoryMetadata = {
        content,
        embedding,
        timestamp: Date.now(),
      };
      const dataBytes = new TextEncoder().encode(JSON.stringify(memoryData));
      console.log('✅ Data prepared:', dataBytes.length, 'bytes');

      // Step 4: Conditionally encrypt with SEAL
      let uploadData: Uint8Array;
      const isEncrypted = this.config.enableEncryption;

      if (isEncrypted) {
        console.log('🔒 Step 4: Encrypting with SEAL...');
        onProgress?.('Encrypting with SEAL...');
        uploadData = await this.encryptWithSEAL(dataBytes, account.address, client);
        console.log('✅ Encrypted:', uploadData.length, 'bytes');
      } else {
        console.log('📝 Step 4: Skipping encryption (enableEncryption=false)');
        onProgress?.('Preparing data (no encryption)...');
        uploadData = dataBytes;
        console.log('✅ Data ready (unencrypted):', uploadData.length, 'bytes');
      }

      // Step 5: Upload to Walrus (2 signatures)
      console.log('🐳 Step 5: Uploading to Walrus...');
      onProgress?.('Uploading to Walrus (2 signatures)...');
      const blobId = await this.uploadToWalrus(uploadData, account, signAndExecute, client);
      console.log('✅ Uploaded to Walrus:', blobId);

      // Generate sequential vector ID (fits in 32-bit for WASM)
      const vectorId = await this.getNextVectorId(account.address);
      console.log('🔢 Generated sequential vector ID:', vectorId);

      // Step 6: Register on-chain with rich metadata (1 signature)
      console.log('⛓️ Step 6: Registering on-chain with rich metadata...');
      onProgress?.('Registering on-chain (1 signature)...');
      await this.registerOnChain({
        blobId,
        category: analysis.category,
        topic: analysis.topic,        // ✅ Pass AI-extracted topic to blockchain
        importance: analysis.importance,
        contentLength: content.length,
        vectorId,                      // ✅ Use sequential ID
        account,
        signAndExecute,
        client
      });
      console.log('✅ Memory registered on-chain with metadata:', {
        category: analysis.category,
        topic: analysis.topic,
        importance: analysis.importance,
        vectorId
      });
      onProgress?.('Memory created successfully!');

      // Step 7: Index locally for search (if enabled)
      console.log('\n📊 === Step 7: Local Vector Indexing ===');
      console.log('  enableLocalIndexing:', this.config.enableLocalIndexing);
      console.log('  account address:', account.address);
      console.log('  embedding length:', embedding?.length || 0);

      if (this.config.enableLocalIndexing && account.address) {
        try {
          // Get HNSW service (wait for async initialization)
          const hnswService = await this.getHnswService();
          console.log('  hnswService available:', !!hnswService);

          if (hnswService) {
            console.log('✅ Local indexing conditions met - proceeding...');
            onProgress?.('Indexing for local search...');
            console.log('  Using vector ID:', vectorId);

            // Prepare rich metadata (aligned with on-chain structure)
            // Option A+: Content storage is controlled by isEncrypted flag.
            // When encryption is OFF, content is stored in local index for fast retrieval.
            // When encryption is ON, only metadata is stored (security).
            const metadata = {
              blobId,
              category: analysis.category,
              topic: analysis.topic,              // ✅ Rich metadata field
              importance: analysis.importance,
              summary: analysis.summary,          // ✅ Rich metadata field
              createdTimestamp: Date.now(),
              contentType: 'text/plain',
              contentSize: content.length,
              source: 'client_memory_manager',
              embeddingType: 'metadata',          // ✅ Mark as metadata-based embedding
              isEncrypted,                        // ✅ Dynamic based on config.enableEncryption
              // Option A+: Store content in index when NOT encrypted (for fast local search)
              ...(isEncrypted ? {} : { content })
            };
            console.log('  Rich metadata prepared:', metadata);

            // Add to local index using IHnswService interface
            console.log('📝 Adding vector to index...');
            await hnswService.addVector(
              account.address,
              vectorId,
              embedding, // ← Metadata embedding from Step 2 (not content embedding!)
              metadata
            );
            console.log('✅ Vector added to index');
            console.log('   Embedding represents: metadata semantics (category, topic, summary)');
            console.log('   NOT content semantics - privacy preserved!');

            // Flush to make searchable
            console.log('🔄 Flushing index to make memory immediately searchable...');
            await hnswService.flushBatch(account.address);
            console.log('✅ Index flushed - vectors now searchable');

            // Save index for persistence
            console.log('💾 Saving index for persistence...');
            await hnswService.saveIndex(account.address);
            console.log('✅ Index saved - will persist after refresh');

            console.log('🎉 Memory indexed, flushed, and persisted!');
            console.log('  Vector ID:', vectorId);
            console.log('  User:', account.address.substring(0, 10) + '...');
            console.log('  Embedding dimensions:', embedding.length);
            onProgress?.('Memory indexed and saved!');
          } else {
            console.warn('⚠️ HNSW service not available - skipping local indexing');
          }
        } catch (indexError: any) {
          // Non-fatal: memory is still created on-chain
          console.error('❌ Local indexing failed:', indexError);
          console.error('  Error details:', indexError.message);
          console.error('  Stack:', indexError.stack);
          console.warn('⚠️ Memory still created on-chain, but not indexed locally');
        }
      } else {
        console.warn('⚠️ Local indexing skipped - conditions not met:');
        if (!this.config.enableLocalIndexing) console.warn('  - Local indexing disabled');
        if (!account.address) console.warn('  - No account address');
        if (!embedding || embedding.length === 0) console.warn('  - No embedding generated');
      }

      console.log('🎉 Memory creation complete!');
      return blobId;
    } catch (error: any) {
      console.error('❌ Memory creation failed:', error);
      throw new Error(`Failed to create memory: ${error.message}`);
    }
  }

  /**
   * Retrieve and decrypt a memory
   */
  async retrieveMemory(options: RetrieveMemoryOptions): Promise<ClientMemoryMetadata> {
    const { blobId, account, signPersonalMessage, client, onProgress } = options;

    console.log('🔍 Starting memory retrieval...');
    onProgress?.('Starting retrieval...');

    try {
      // Step 1: Fetch from Walrus
      console.log('🐳 Step 1: Fetching from Walrus...');
      onProgress?.('Fetching from Walrus...');
      const encryptedData = await this.fetchFromWalrus(blobId, client);
      console.log('✅ Retrieved:', encryptedData.length, 'bytes');

      // Step 2: Decrypt with SEAL
      console.log('🔓 Step 2: Decrypting with SEAL...');
      onProgress?.('Decrypting with SEAL...');
      const decryptedData = await this.decryptWithSEAL({
        encryptedData,
        account,
        signPersonalMessage,
        client
      });
      console.log('✅ Decrypted:', decryptedData.length, 'bytes');

      // Step 3: Parse JSON
      const decryptedString = new TextDecoder().decode(decryptedData);
      const parsed: ClientMemoryMetadata = JSON.parse(decryptedString);

      console.log('🎉 Memory retrieval complete!');
      onProgress?.('Memory retrieved successfully!');

      return parsed;
    } catch (error: any) {
      console.error('❌ Memory retrieval failed:', error);
      throw new Error(`Failed to retrieve memory: ${error.message}`);
    }
  }

  /**
   * Batch retrieve and decrypt multiple memories with a single signature
   * This is much more efficient than calling retrieveMemory multiple times
   */
  async batchRetrieveMemories(options: BatchRetrieveMemoriesOptions): Promise<BatchRetrieveResult[]> {
    const { blobIds, account, signPersonalMessage, client, onProgress } = options;

    console.log('🔍 Starting batch memory retrieval for', blobIds.length, 'memories...');
    onProgress?.('Initializing decryption session...', 0, blobIds.length);

    try {
      // Step 1: Create reusable decryption session (SINGLE SIGNATURE!)
      const session = await this.createDecryptionSession({
        account,
        signPersonalMessage,
        client
      });
      console.log('✅ Decryption session created - will decrypt all memories without additional signatures');

      const results: BatchRetrieveResult[] = [];

      // Step 2: Decrypt all memories using the same session
      for (let i = 0; i < blobIds.length; i++) {
        const blobId = blobIds[i];
        console.log(`🔓 Decrypting memory ${i + 1}/${blobIds.length}: ${blobId}`);
        onProgress?.(`Decrypting memory ${i + 1}/${blobIds.length}...`, i + 1, blobIds.length);

        try {
          // Fetch from Walrus
          const encryptedData = await this.fetchFromWalrus(blobId, client);

          // Decrypt using shared session (NO SIGNING!)
          const decryptedData = await session.sealClient.decrypt({
            data: encryptedData,
            sessionKey: session.sessionKey,
            txBytes: session.txBytes,
          });

          // Parse JSON
          const decryptedString = new TextDecoder().decode(decryptedData);
          const parsed: ClientMemoryMetadata = JSON.parse(decryptedString);

          results.push({
            blobId,
            content: parsed.content
          });

          console.log(`✅ Memory ${i + 1} decrypted successfully`);
        } catch (error: any) {
          console.error(`❌ Failed to decrypt memory ${blobId}:`, error);

          // Handle old format (binary embedding data)
          if (error.message?.includes('not valid JSON') || error.message?.includes('Unexpected token')) {
            results.push({
              blobId,
              content: '[Old format - cannot display content]'
            });
          } else {
            results.push({
              blobId,
              error: error.message || 'Decryption failed'
            });
          }
        }
      }

      console.log('🎉 Batch retrieval complete!');
      onProgress?.('All memories decrypted!', blobIds.length, blobIds.length);

      return results;
    } catch (error: any) {
      console.error('❌ Batch retrieval failed:', error);
      throw new Error(`Failed to batch retrieve memories: ${error.message}`);
    }
  }

  // ==================== PRIVATE METHODS ====================

  private async analyzeContent(text: string, categoryOverride?: string): Promise<RichMetadataAnalysis> {
    // Use client-side Gemini AI for rich metadata extraction
    try {
      if (this.geminiAIService) {
        console.log('🤖 Using Gemini AI for metadata extraction...');
        const metadata = await this.geminiAIService.extractRichMetadata(text, categoryOverride);
        console.log('✅ AI metadata extracted:', metadata);
        return metadata;
      } else {
        console.warn('⚠️ Gemini AI service not initialized, using fallback extraction');
        return this.getFallbackAnalysis(text, categoryOverride);
      }
    } catch (error) {
      console.warn('⚠️ AI analysis failed, using fallback:', error);
      return this.getFallbackAnalysis(text, categoryOverride);
    }
  }

  private getFallbackAnalysis(text: string, categoryOverride?: string): RichMetadataAnalysis {
    return {
      category: categoryOverride || 'personal',
      topic: this.extractTopicFromContent(text),
      importance: 5,
      summary: text.substring(0, 200) + (text.length > 200 ? '...' : '')
    };
  }

  /**
   * Extract topic from content as fallback (when AI fails)
   * Tries to get first sentence, or first 50 characters
   *
   * @param text - Content text to extract topic from
   * @returns Topic string (max 100 characters)
   */
  private extractTopicFromContent(text: string): string {
    // Try to get first sentence
    const firstSentence = text.match(/^[^.!?]+[.!?]/);
    if (firstSentence) {
      const topic = firstSentence[0].trim();
      return topic.length > 100 ? topic.substring(0, 97) + '...' : topic;
    }

    // Fallback: first 50 characters
    return text.substring(0, 50) + (text.length > 50 ? '...' : '');
  }

  /**
   * Build embeddable metadata text from rich metadata
   * Format optimized for semantic embedding and alignment with on-chain metadata
   *
   * @param metadata - Rich metadata extracted from AI analysis
   * @returns Formatted text string ready for embedding
   *
   * @example
   * ```typescript
   * const metadataText = buildMetadataText({
   *   category: 'work',
   *   topic: 'Q4 project deadline meeting',
   *   importance: 7,
   *   summary: 'Team discussion about Q4 deadlines'
   * });
   * // Returns:
   * // "category: work
   * //  topic: Q4 project deadline meeting
   * //  importance: 7
   * //  summary: Team discussion about Q4 deadlines"
   * ```
   */
  private buildMetadataText(metadata: RichMetadataAnalysis): string {
    const parts = [
      `category: ${metadata.category}`,
      `topic: ${metadata.topic}`,
      `importance: ${metadata.importance}`
    ];

    if (metadata.summary && metadata.summary.trim().length > 0) {
      parts.push(`summary: ${metadata.summary}`);
    }

    return parts.join('\n');
  }

  private async generateEmbedding(text: string): Promise<number[]> {
    if (!this.embeddingService) {
      throw new Error(
        'EmbeddingService not configured. Please provide an API key for embedding generation ' +
        '(e.g., GEMINI_API_KEY or OPENROUTER_API_KEY in environment variables).'
      );
    }

    try {
      const result = await this.embeddingService.embedText({
        text,
        type: 'content'
      });
      return result.vector;
    } catch (error) {
      throw new Error(`Failed to generate embedding: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  private async encryptWithSEAL(
    data: Uint8Array,
    ownerAddress: string,
    client: SuiClient
  ): Promise<Uint8Array> {
    const sealClient = new SealClient({
      suiClient: client as any,
      serverConfigs: this.config.sealServerObjectIds.map((id) => ({
        objectId: id,
        weight: 1,
      })),
      verifyKeyServers: false,
    });

    const { encryptedObject: encryptedBytes } = await sealClient.encrypt({
      threshold: 1,
      packageId: this.config.packageId,
      id: ownerAddress, // Use owner's address as ID for simple access control
      data,
    });

    return encryptedBytes;
  }

  private async uploadToWalrus(
    data: Uint8Array,
    account: { address: string },
    signAndExecute: CreateMemoryOptions['signAndExecute'],
    client: SuiClient
  ): Promise<string> {
    const extendedClient = (client as any).$extend(
      WalrusClient.experimental_asClientExtension({
        network: this.config.walrusNetwork,
        uploadRelay: {
          host: `https://upload-relay.${this.config.walrusNetwork}.walrus.space`,
          sendTip: { max: 1_000 },
          timeout: 60_000,
        },
        storageNodeClientOptions: {
          timeout: 60_000,
        },
      })
    );

    const walrusClient = extendedClient.walrus as any;
    const flow = walrusClient.writeBlobFlow({ blob: data });

    // Encode
    await flow.encode();

    // Register (signature 1)
    const registerTx = flow.register({
      epochs: 5,
      deletable: true,
      owner: account.address,
    });
    registerTx.setSender(account.address);

    const registerDigest = await new Promise<string>((resolve, reject) => {
      signAndExecute(
        { transaction: registerTx },
        {
          onSuccess: (result) => resolve(result.digest),
          onError: (error) => reject(error),
        }
      );
    });

    // Upload
    await flow.upload({ digest: registerDigest });

    // Certify (signature 2)
    const certifyTx = flow.certify();
    certifyTx.setSender(account.address);

    await new Promise<void>((resolve, reject) => {
      signAndExecute(
        { transaction: certifyTx },
        {
          onSuccess: () => resolve(),
          onError: (error) => reject(error),
        }
      );
    });

    const blob = await flow.getBlob();
    return blob.blobId;
  }

  private async registerOnChain(params: {
    blobId: string;
    category: string;
    topic: string;           // ✅ NEW: Real topic from AI analysis
    importance: number;
    contentLength: number;
    vectorId: number;        // ✅ Sequential ID (fits in 32-bit unsigned int)
    account: { address: string };
    signAndExecute: CreateMemoryOptions['signAndExecute'];
    client: SuiClient;
  }): Promise<void> {
    const { blobId, category, topic, importance, contentLength, vectorId, account, signAndExecute, client } = params;

    const tx = new Transaction();
    const packageId = this.config.packageId.replace(/^0x/, '');

    console.log('📝 Registering on-chain with rich metadata:', {
      category,
      topic,
      importance,
      vectorId,
      blobId: blobId.substring(0, 20) + '...'
    });

    tx.moveCall({
      target: `${packageId}::memory::create_memory_record`,
      arguments: [
        tx.pure.string(category),
        tx.pure.u64(vectorId),
        tx.pure.string(blobId),
        tx.pure.string('text/plain'),
        tx.pure.u64(contentLength),
        tx.pure.string(blobId),            // ✅ FIX: content_hash = blobId (content-addressed)
        tx.pure.string(topic),              // ✅ FIX: Real topic from AI (not hardcoded "memory")
        tx.pure.u8(importance),
        tx.pure.string(blobId),             // embedding_blob_id (same as content for now)
      ],
    });

    return new Promise((resolve, reject) => {
      signAndExecute(
        { transaction: tx },
        {
          onSuccess: (result) => {
            console.log('✅ Transaction successful:', result.digest);
            console.log('✅ On-chain Memory created with rich metadata:', {
              category,
              topic,
              importance
            });
            resolve();
          },
          onError: (error) => {
            console.error('❌ Transaction failed:', error);
            reject(error);
          },
        }
      );
    });
  }

  private async fetchFromWalrus(blobId: string, client: SuiClient): Promise<Uint8Array> {
    // Use Walrus SDK for reading blobs (consistent with uploadToWalrus)
    const extendedClient = (client as any).$extend(
      WalrusClient.experimental_asClientExtension({
        network: this.config.walrusNetwork,
      })
    );

    const walrusClient = extendedClient.walrus as any;
    const blob = await walrusClient.readBlob({ blobId });
    return blob;
  }

  /**
   * Create a reusable decryption session (requires one signature)
   * This session can be used to decrypt multiple memories without additional signatures
   */
  private async createDecryptionSession(params: {
    account: { address: string };
    signPersonalMessage: (params: { message: Uint8Array }) => Promise<{ signature: string }>;
    client: SuiClient;
  }): Promise<DecryptionSession> {
    const { account, signPersonalMessage, client } = params;

    console.log('🔑 Creating decryption session...');

    // Create SEAL client (reusable)
    const sealClient = new SealClient({
      suiClient: client as any,
      serverConfigs: this.config.sealServerObjectIds.map((id) => ({
        objectId: id,
        weight: 1,
      })),
      verifyKeyServers: false,
    });

    // Create session key (reusable)
    const sessionKey = await SessionKey.create({
      address: account.address,
      packageId: this.config.packageId,
      ttlMin: 10,
      suiClient: client as any,
    });

    // Sign personal message ONCE
    const personalMessage = sessionKey.getPersonalMessage();
    const signatureResult = await signPersonalMessage({ message: personalMessage });
    await sessionKey.setPersonalMessageSignature(signatureResult.signature);
    console.log('✅ Personal message signed');

    // Build seal_approve transaction ONCE
    const tx = new Transaction();
    const addressHex = account.address.startsWith('0x')
      ? account.address.slice(2)
      : account.address;
    const idBytes = fromHex(addressHex);

    tx.moveCall({
      target: `${this.config.packageId}::seal_access_control::seal_approve`,
      arguments: [
        tx.pure.vector('u8', Array.from(idBytes)),
        tx.pure.address(account.address),
        tx.object(this.config.accessRegistryId),
        tx.object('0x6'),
      ],
    });

    const txBytes = await tx.build({ client, onlyTransactionKind: true });
    console.log('✅ Session created - can now decrypt multiple memories');

    return {
      sealClient,
      sessionKey,
      txBytes
    };
  }

  private async decryptWithSEAL(params: {
    encryptedData: Uint8Array;
    account: { address: string };
    signPersonalMessage: RetrieveMemoryOptions['signPersonalMessage'];
    client: SuiClient;
  }): Promise<Uint8Array> {
    const { encryptedData, account, signPersonalMessage, client } = params;

    // Create SEAL client
    const sealClient = new SealClient({
      suiClient: client as any,
      serverConfigs: this.config.sealServerObjectIds.map((id) => ({
        objectId: id,
        weight: 1,
      })),
      verifyKeyServers: false,
    });

    // Create session key
    const sessionKey = await SessionKey.create({
      address: account.address,
      packageId: this.config.packageId,
      ttlMin: 10,
      suiClient: client as any,
    });

    // Sign personal message
    const personalMessage = sessionKey.getPersonalMessage();
    const signatureResult = await signPersonalMessage({ message: personalMessage });
    await sessionKey.setPersonalMessageSignature(signatureResult.signature);

    // Build seal_approve transaction
    const tx = new Transaction();
    const addressHex = account.address.startsWith('0x')
      ? account.address.slice(2)
      : account.address;
    const idBytes = fromHex(addressHex);

    tx.moveCall({
      target: `${this.config.packageId}::seal_access_control::seal_approve`,
      arguments: [
        tx.pure.vector('u8', Array.from(idBytes)),
        tx.pure.address(account.address),
        tx.object(this.config.accessRegistryId),
        tx.object('0x6'),
      ],
    });

    const txBytes = await tx.build({ client, onlyTransactionKind: true });

    // Decrypt
    const decryptedData = await sealClient.decrypt({
      data: encryptedData,
      sessionKey,
      txBytes,
    });

    return decryptedData;
  }
}

export default ClientMemoryManager;
