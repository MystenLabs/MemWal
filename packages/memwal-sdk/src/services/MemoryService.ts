/**
 * Memory Service
 *
 * Handles memory-related blockchain operations including transaction builders,
 * move calls, and view functions for on-chain memory data.
 *
 * Note: This service provides direct blockchain access. For high-level memory
 * operations (create, search), use SimplePDWClient's memory namespace instead.
 */

import type {
  ClientWithCoreApi,
  PDWConfig,
  MemoryCreateOptions,
  MemorySearchOptions,
  MemorySearchResult,
  MemoryContext,
  MemoryContextOptions,
  MemoryStatsResponse,
  Thunk,
  AsyncThunk
} from '../types';
import { Transaction } from '@mysten/sui/transactions';
import * as memoryContract from '../generated/pdw/memory';

export class MemoryService {
  constructor(
    private client: ClientWithCoreApi,
    private config: PDWConfig
  ) {}

  // ==================== TRANSACTION BUILDERS ====================

  get tx() {
    return {
      /**
       * Create transaction for memory record on blockchain
       */
      createMemoryRecord: async (options: {
        category: string;
        vectorId: number | bigint;
        blobId: string;
        metadata: {
          contentType: string;
          contentSize: number | bigint;
          contentHash: string;
          category: string;
          topic: string;
          importance: number;
          embeddingBlobId: string;
          embeddingDimension: number | bigint;
          createdTimestamp: number | bigint;
          updatedTimestamp: number | bigint;
          customMetadata?: Record<string, string>;
        };
      }) => {
        const tx = new Transaction();
        
        // Create the memory record with inline metadata
        const memoryRecord = memoryContract.createMemoryRecord({
          package: this.config.packageId,
          arguments: {
            category: Array.from(new TextEncoder().encode(options.category)),
            vectorId: options.vectorId,
            blobId: Array.from(new TextEncoder().encode(options.blobId)),
            contentType: Array.from(new TextEncoder().encode(options.metadata.contentType)),
            contentSize: options.metadata.contentSize,
            contentHash: Array.from(new TextEncoder().encode(options.metadata.contentHash)),
            topic: Array.from(new TextEncoder().encode(options.metadata.topic)),
            importance: options.metadata.importance,
            embeddingBlobId: Array.from(new TextEncoder().encode(options.metadata.embeddingBlobId))
          }
        });
        
        tx.add(memoryRecord);
        return tx;
      },

      /**
       * Create transaction to delete memory
       */
      deleteMemory: async (memoryId: string) => {
        const tx = new Transaction();
        
        const deleteCall = memoryContract.deleteMemoryRecord({
          package: this.config.packageId,
          arguments: {
            memory: memoryId
          }
        });
        
        tx.add(deleteCall);
        return tx;
      },

      /**
       * Create transaction to update memory metadata
       */
      updateMemoryMetadata: async (memoryId: string, metadata: {
        newTopic: string;
        newImportance: number;
      }) => {
        const tx = new Transaction();
        
        const updateCall = memoryContract.updateMemoryMetadata({
          package: this.config.packageId,
          arguments: {
            memory: memoryId,
            newTopic: Array.from(new TextEncoder().encode(metadata.newTopic)),
            newImportance: metadata.newImportance
          }
        });
        
        tx.add(updateCall);
        return tx;
      },

      /**
       * Create memory index transaction
       */
      createMemoryIndex: async (options: {
        indexBlobId: string;
        graphBlobId: string;
      }) => {
        const tx = new Transaction();
        
        const indexCall = memoryContract.createMemoryIndex({
          package: this.config.packageId,
          arguments: {
            indexBlobId: Array.from(new TextEncoder().encode(options.indexBlobId)),
            graphBlobId: Array.from(new TextEncoder().encode(options.graphBlobId))
          }
        });
        
        tx.add(indexCall);
        return tx;
      },

      /**
       * Update memory index transaction
       */
      updateMemoryIndex: async (options: {
        memoryIndex: string;
        expectedVersion: number | bigint;
        newIndexBlobId: string;
        newGraphBlobId: string;
      }) => {
        const tx = new Transaction();
        
        const updateCall = memoryContract.updateMemoryIndex({
          package: this.config.packageId,
          arguments: {
            memoryIndex: options.memoryIndex,
            expectedVersion: options.expectedVersion,
            newIndexBlobId: Array.from(new TextEncoder().encode(options.newIndexBlobId)),
            newGraphBlobId: Array.from(new TextEncoder().encode(options.newGraphBlobId))
          }
        });
        
        tx.add(updateCall);
        return tx;
      },
    };
  }

  // ==================== MOVE CALL BUILDERS ====================

  get call() {
    return {
      /**
       * Move call for memory record creation
       */
      createMemoryRecord: (options: {
        category: string;
        vectorId: number | bigint;
        blobId: string;
        contentType: string;
        contentSize: number | bigint;
        contentHash: string;
        topic: string;
        importance: number;
        embeddingBlobId: string;
      }): Thunk => {
        return memoryContract.createMemoryRecord({
          package: this.config.packageId,
          arguments: {
            category: Array.from(new TextEncoder().encode(options.category)),
            vectorId: options.vectorId,
            blobId: Array.from(new TextEncoder().encode(options.blobId)),
            contentType: Array.from(new TextEncoder().encode(options.contentType)),
            contentSize: options.contentSize,
            contentHash: Array.from(new TextEncoder().encode(options.contentHash)),
            topic: Array.from(new TextEncoder().encode(options.topic)),
            importance: options.importance,
            embeddingBlobId: Array.from(new TextEncoder().encode(options.embeddingBlobId))
          }
        });
      },

      /**
       * Move call for memory deletion
       */
      deleteMemory: (memoryId: string): Thunk => {
        return memoryContract.deleteMemoryRecord({
          package: this.config.packageId,
          arguments: {
            memory: memoryId
          }
        });
      },

      /**
       * Move call for memory metadata updates
       */
      updateMemoryMetadata: (memoryId: string, options: {
        newTopic: string;
        newImportance: number;
      }): Thunk => {
        return memoryContract.updateMemoryMetadata({
          package: this.config.packageId,
          arguments: {
            memory: memoryId,
            newTopic: Array.from(new TextEncoder().encode(options.newTopic)),
            newImportance: options.newImportance
          }
        });
      },

      /**
       * Move call for memory index creation
       */
      createMemoryIndex: (options: {
        indexBlobId: string;
        graphBlobId: string;
      }): Thunk => {
        return memoryContract.createMemoryIndex({
          package: this.config.packageId,
          arguments: {
            indexBlobId: Array.from(new TextEncoder().encode(options.indexBlobId)),
            graphBlobId: Array.from(new TextEncoder().encode(options.graphBlobId))
          }
        });
      },

      /**
       * Move call for memory index updates
       */
      updateMemoryIndex: (options: {
        memoryIndex: string;
        expectedVersion: number | bigint;
        newIndexBlobId: string;
        newGraphBlobId: string;
      }): Thunk => {
        return memoryContract.updateMemoryIndex({
          package: this.config.packageId,
          arguments: {
            memoryIndex: options.memoryIndex,
            expectedVersion: options.expectedVersion,
            newIndexBlobId: Array.from(new TextEncoder().encode(options.newIndexBlobId)),
            newGraphBlobId: Array.from(new TextEncoder().encode(options.newGraphBlobId))
          }
        });
      },

      /**
       * Move call for adding custom metadata
       */
      addCustomMetadata: (options: {
        memory: string;
        key: string;
        value: string;
      }): Thunk => {
        return memoryContract.addCustomMetadata({
          package: this.config.packageId,
          arguments: {
            memory: options.memory,
            key: Array.from(new TextEncoder().encode(options.key)),
            value: Array.from(new TextEncoder().encode(options.value))
          }
        });
      },
    };
  }

  // ==================== VIEW METHODS ====================

  get view() {
    return {
      /**
       * Get memory object from blockchain
       */
      getMemory: async (memoryId: string) => {
        try {
          const memoryObject = await this.client.core.getObject(memoryId);
          return memoryObject;
        } catch (error) {
          throw new Error(`Failed to get memory ${memoryId}: ${error}`);
        }
      },

      /**
       * Get memory index information from blockchain
       */
      getMemoryIndex: async (indexId: string) => {
        try {
          const indexObject = await this.client.core.getObject(indexId);
          return indexObject;
        } catch (error) {
          throw new Error(`Failed to get memory index ${indexId}: ${error}`);
        }
      },

      /**
       * Get memory blob ID from blockchain
       */
      getMemoryBlobId: async (memoryId: string) => {
        const memoryObject = await this.view.getMemory(memoryId);
        return memoryObject?.data?.content?.fields?.blob_id;
      },

      /**
       * Get memory category from blockchain
       */
      getMemoryCategory: async (memoryId: string) => {
        const memoryObject = await this.view.getMemory(memoryId);
        return memoryObject?.data?.content?.fields?.category;
      },

      /**
       * Get memory vector ID from blockchain
       */
      getMemoryVectorId: async (memoryId: string) => {
        const memoryObject = await this.view.getMemory(memoryId);
        return memoryObject?.data?.content?.fields?.vector_id;
      },

      /**
       * Get memory metadata from blockchain
       */
      getMemoryMetadata: async (memoryId: string) => {
        const memoryObject = await this.view.getMemory(memoryId);
        return memoryObject?.data?.content?.fields?.metadata;
      },

      /**
       * Get index blob ID from memory index
       */
      getIndexBlobId: async (indexId: string) => {
        const indexObject = await this.view.getMemoryIndex(indexId);
        return indexObject?.data?.content?.fields?.index_blob_id;
      },

      /**
       * Get graph blob ID from memory index
       */
      getGraphBlobId: async (indexId: string) => {
        const indexObject = await this.view.getMemoryIndex(indexId);
        return indexObject?.data?.content?.fields?.graph_blob_id;
      },

      /**
       * Get memory index version
       */
      getIndexVersion: async (indexId: string) => {
        const indexObject = await this.view.getMemoryIndex(indexId);
        return indexObject?.data?.content?.fields?.version;
      },
    };
  }
}