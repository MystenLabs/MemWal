/**
 * Batch Namespace - Batch Processing Operations
 *
 * Pure delegation to BatchService for coordinated batch operations.
 * Handles intelligent batching with configurable delays and sizes.
 *
 * @module client/namespaces
 */

import type { ServiceContainer } from '../SimplePDWClient';
import type { BatchItem, BatchProcessor } from '../../services/BatchService';

/**
 * Batch progress info
 */
export interface BatchProgress {
  total: number;
  completed: number;
  failed: number;
  inProgress: number;
  percentage: number;
}

/**
 * Batch statistics
 */
export interface BatchStatistics {
  totalBatches: number;
  totalItems: number;
  averageBatchSize: number;
  totalProcessingTime: number;
  averageProcessingTime: number;
  successCount: number;
  errorCount: number;
  lastProcessed: Date;
}

/**
 * Batch Namespace
 *
 * Handles batch processing operations with intelligent queuing
 */
export class BatchNamespace {
  constructor(private services: ServiceContainer) {}

  /**
   * Create many memories in batch
   *
   * Delegates to: MemoryNamespace.createBatch()
   *
   * @param contents - Array of content strings
   * @param options - Optional creation options
   * @returns Array of created memory objects
   */
  async createMany(
    contents: string[],
    options?: {
      category?: 'general' | 'preference' | 'fact' | 'todo' | 'note';
      importance?: number;
    }
  ): Promise<Array<{ id: string; blobId: string }>> {
    if (!this.services.batchService) {
      throw new Error('Batch service not configured.');
    }

    // Import MemoryNamespace to reuse existing batch create logic
    const { MemoryNamespace } = await import('./MemoryNamespace');
    const memoryNamespace = new MemoryNamespace(this.services);

    // Delegate to existing createBatch method which handles everything
    const memories = await memoryNamespace.createBatch(
      contents,
      {
        category: options?.category,
        importance: options?.importance
      }
    );

    return memories.map(m => ({
      id: m.id,
      blobId: m.blobId
    }));
  }

  /**
   * Update many memories in batch
   *
   * Updates memories in parallel:
   * 1. For updates with new content: uploads new blobs to Walrus
   * 2. Executes on-chain update transactions
   * 3. Updates local vector index if enabled
   *
   * @param updates - Array of {id, content, category, importance, topic}
   * @returns Array of successfully updated memory IDs
   */
  async updateMany(
    updates: Array<{
      id: string;
      content?: string;
      category?: string;
      importance?: number;
      topic?: string;
    }>
  ): Promise<string[]> {
    if (!this.services.batchService) {
      throw new Error('Batch service not configured.');
    }

    if (!this.services.tx) {
      throw new Error('Transaction service not configured.');
    }

    const successfulIds: string[] = [];
    const errors: Array<{ id: string; error: string }> = [];

    // Process updates in parallel batches
    const BATCH_SIZE = 5; // Process 5 at a time to avoid overwhelming network

    for (let i = 0; i < updates.length; i += BATCH_SIZE) {
      const batch = updates.slice(i, i + BATCH_SIZE);

      const batchPromises = batch.map(async (update) => {
        try {
          let newBlobId = '';
          let newContentHash = '';
          let newContentSize = 0;

          // Step 1: If content changed, upload new blob to Walrus
          if (update.content) {
            // Generate embedding if service available
            let embedding: number[] = [];
            if (this.services.embedding) {
              const embResult = await this.services.embedding.embedText({
                text: update.content
              });
              embedding = embResult.vector;
            }

            // Upload new content
            const uploadResult = await this.services.storage.uploadMemoryPackage(
              {
                content: update.content,
                embedding,
                metadata: {
                  category: update.category || 'general',
                  importance: update.importance || 5,
                  topic: update.topic || ''
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
            newContentHash = uploadResult.blobId; // blob_id is content-addressed
            newContentSize = update.content.length;
          }

          // Step 2: Build and execute update transaction
          const tx = this.services.tx!.buildUpdateMemoryRecord({
            memoryId: update.id,
            newBlobId,
            newCategory: update.category || '',
            newTopic: update.topic || '',
            newImportance: update.importance || 0,
            newEmbeddingBlobId: '',
            newContentHash,
            newContentSize
          });

          const result = await this.services.tx!.executeTransaction(
            tx,
            this.services.config.signer.getSigner()
          );

          if (result.status !== 'success') {
            throw new Error(result.error || 'Transaction failed');
          }

          // Step 3: Update local vector index if content changed
          if (update.content && this.services.vector && this.services.embedding) {
            const embResult = await this.services.embedding.embedText({
              text: update.content
            });
            await this.services.vector.addVector(
              this.services.config.userAddress,
              Date.now(), // vectorId
              embResult.vector,
              {
                category: update.category,
                importance: update.importance,
                topic: update.topic
              }
            );
          }

          return { success: true, id: update.id };
        } catch (error) {
          const errorMsg = error instanceof Error ? error.message : String(error);
          console.warn(`Failed to update memory ${update.id}:`, errorMsg);
          return { success: false, id: update.id, error: errorMsg };
        }
      });

      const batchResults = await Promise.all(batchPromises);

      for (const result of batchResults) {
        if (result.success) {
          successfulIds.push(result.id);
        } else {
          errors.push({ id: result.id, error: result.error || 'Unknown error' });
        }
      }
    }

    if (errors.length > 0) {
      console.warn(`Batch update completed with ${errors.length} errors:`, errors);
    }

    return successfulIds;
  }

  /**
   * Delete many memories in batch
   *
   * Delegates to: MemoryService.deleteMemoryRecord() for each
   *
   * @param ids - Array of memory IDs
   * @returns Number of successfully deleted
   */
  async deleteMany(ids: string[]): Promise<number> {
    if (!this.services.batchService) {
      throw new Error('Batch service not configured.');
    }

    let successCount = 0;

    for (const id of ids) {
      try {
        await this.services.memory.deleteMemoryRecord(
          id,
          this.services.config.userAddress,
          this.services.config.signer.getSigner()
        );
        successCount++;
      } catch (error) {
        console.warn(`Failed to delete memory ${id}:`, error);
      }
    }

    return successCount;
  }

  /**
   * Upload many files in batch
   *
   * Delegates to: StorageService.uploadMemoryBatch()
   *
   * @param files - Array of {name, data}
   * @returns Quilt result with blob IDs
   */
  async uploadMany(
    files: Array<{ name: string; data: Uint8Array }>
  ): Promise<{ quiltId: string; files: Array<{ name: string; blobId: string }> }> {
    if (!this.services.batchService) {
      throw new Error('Batch service not configured.');
    }

    // Convert to memory format for batch upload
    const memories = files.map(f => ({
      content: new TextDecoder().decode(f.data),
      category: 'file' as const,
      importance: 5,
      topic: f.name,
      embedding: [] as number[],
      encryptedContent: f.data,
      summary: ''
    }));

    const result = await this.services.storage.uploadMemoryBatch(
      memories,
      {
        signer: this.services.config.signer.getSigner(),
        epochs: 3,
        userAddress: this.services.config.userAddress
      }
    );

    return {
      quiltId: result.quiltId,
      files: result.files.map((f: any) => ({
        name: f.identifier,
        blobId: f.blobId
      }))
    };
  }

  /**
   * Get batch processing progress
   *
   * Delegates to: BatchService.getStats()
   *
   * @returns Current batch progress
   */
  getProgress(): BatchProgress {
    if (!this.services.batchService) {
      throw new Error('Batch service not configured.');
    }

    const stats = this.services.batchService.getStats() as Map<string, any>;

    let total = 0;
    let completed = 0;
    let failed = 0;

    for (const [, stat] of stats) {
      total += stat.totalItems;
      completed += stat.successCount;
      failed += stat.errorCount;
    }

    const percentage = total > 0 ? (completed / total) * 100 : 0;

    return {
      total,
      completed,
      failed,
      inProgress: total - completed - failed,
      percentage
    };
  }

  /**
   * Get batch statistics
   *
   * Delegates to: BatchService.getStats()
   *
   * @param type - Optional batch type ('memory-create', 'storage', etc.)
   * @returns Batch statistics
   */
  getStats(type?: string): BatchStatistics | Map<string, BatchStatistics> {
    if (!this.services.batchService) {
      throw new Error('Batch service not configured.');
    }

    const stats = this.services.batchService.getStats(type);

    if (stats instanceof Map) {
      return stats as Map<string, BatchStatistics>;
    }

    return stats as BatchStatistics;
  }
}
