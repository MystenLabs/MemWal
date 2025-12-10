/**
 * useCreateMemoryBatch - Hook for creating multiple memories in a single Quilt
 *
 * Batch memory creation with ~90% gas savings by using Walrus Quilts.
 * All memories in a batch are stored in a single Quilt with per-file metadata tags.
 *
 * @example
 * ```tsx
 * import { useCreateMemoryBatch } from 'personal-data-wallet-sdk/hooks';
 * import { useCurrentAccount, useSignAndExecuteTransaction, useSuiClient } from '@mysten/dapp-kit';
 *
 * function BatchMemoryCreator() {
 *   const account = useCurrentAccount();
 *   const { mutate: signAndExecute } = useSignAndExecuteTransaction();
 *   const client = useSuiClient();
 *
 *   const { mutate: createBatch, isPending, data, error, progress } = useCreateMemoryBatch({
 *     geminiApiKey: process.env.NEXT_PUBLIC_GEMINI_API_KEY!,
 *     onSuccess: (result) => {
 *       console.log(`Created ${result.memoriesCreated} memories in Quilt ${result.quiltId}`);
 *       console.log(`Upload time: ${result.uploadTimeMs}ms`);
 *     },
 *     onProgress: (progress) => {
 *       console.log(`${progress.message} (${progress.percent}%)`);
 *     }
 *   });
 *
 *   const handleBatchCreate = () => {
 *     createBatch({
 *       memories: [
 *         { content: 'First memory', category: 'personal' },
 *         { content: 'Second memory', category: 'personal' },
 *         { content: 'Third memory', category: 'work' },
 *       ]
 *     });
 *   };
 *
 *   return (
 *     <div>
 *       <button onClick={handleBatchCreate} disabled={isPending}>
 *         {isPending ? `Creating... ${progress?.percent || 0}%` : 'Create Batch'}
 *       </button>
 *       {progress && <div>{progress.message}</div>}
 *       {error && <div>Error: {error.message}</div>}
 *     </div>
 *   );
 * }
 * ```
 */

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState, useCallback } from 'react';
import { useSuiClient, useCurrentAccount, useSignAndExecuteTransaction } from '@mysten/dapp-kit';
import { useMemoryServices } from './useMemoryServices';
import { cacheKeys } from './utils/cache';
import type {
  CreateMemoryBatchInput,
  CreateMemoryBatchProgress,
  CreateMemoryBatchResult,
  MemoryManagerConfig,
} from './utils/types';

export interface UseCreateMemoryBatchOptions {
  /**
   * Callback when batch creation succeeds
   */
  onSuccess?: (result: CreateMemoryBatchResult) => void;

  /**
   * Callback when batch creation fails
   */
  onError?: (error: Error) => void;

  /**
   * Callback for progress updates
   */
  onProgress?: (progress: CreateMemoryBatchProgress) => void;

  /**
   * Gemini API key for embedding generation
   * @required
   */
  geminiApiKey: string;

  /**
   * Optional memory manager config override
   */
  config?: MemoryManagerConfig;

  /**
   * Whether to automatically invalidate memory queries on success
   * @default true
   */
  invalidateQueries?: boolean;
}

export interface UseCreateMemoryBatchReturn {
  /**
   * Mutation function to create a batch of memories
   */
  mutate: (input: CreateMemoryBatchInput) => void;

  /**
   * Async mutation function (returns promise)
   */
  mutateAsync: (input: CreateMemoryBatchInput) => Promise<CreateMemoryBatchResult>;

  /**
   * Whether the mutation is currently loading
   */
  isPending: boolean;

  /**
   * Whether the mutation succeeded
   */
  isSuccess: boolean;

  /**
   * Whether the mutation failed
   */
  isError: boolean;

  /**
   * The result data (Quilt ID and file list) if successful
   */
  data?: CreateMemoryBatchResult;

  /**
   * The error if failed
   */
  error: Error | null;

  /**
   * Current progress status
   */
  progress?: CreateMemoryBatchProgress;

  /**
   * Reset mutation state
   */
  reset: () => void;
}

/**
 * Hook for creating multiple memories in a single Quilt
 */
export function useCreateMemoryBatch(
  options: UseCreateMemoryBatchOptions
): UseCreateMemoryBatchReturn {
  const {
    onSuccess,
    onError,
    onProgress,
    geminiApiKey,
    config,
    invalidateQueries = true,
  } = options;

  const queryClient = useQueryClient();
  const client = useSuiClient();
  const account = useCurrentAccount();
  const { mutate: signAndExecute } = useSignAndExecuteTransaction();

  // Get services with Gemini API key
  const { storageService, embeddingService, encryptionService, geminiAIService, isReady } = useMemoryServices(
    account?.address,
    { geminiApiKey, ...config }
  );

  const [progress, setProgress] = useState<CreateMemoryBatchProgress | undefined>();

  // Progress helper
  const updateProgress = useCallback(
    (
      stage: CreateMemoryBatchProgress['stage'],
      message: string,
      current: number,
      total: number
    ) => {
      const percent = Math.round((current / total) * 100);
      const progressUpdate: CreateMemoryBatchProgress = {
        stage,
        message,
        current,
        total,
        percent,
      };

      setProgress(progressUpdate);
      onProgress?.(progressUpdate);
    },
    [onProgress]
  );

  // Create batch mutation
  const mutation = useMutation({
    mutationFn: async (input: CreateMemoryBatchInput): Promise<CreateMemoryBatchResult> => {
      if (!isReady) {
        throw new Error('Services not initialized. Please wait...');
      }

      if (!account) {
        throw new Error('No wallet connected. Please connect your wallet.');
      }

      if (!client) {
        throw new Error('Sui client not available.');
      }

      if (!storageService || !embeddingService || !encryptionService) {
        throw new Error('Required services not available.');
      }

      if (!signAndExecute) {
        throw new Error('Sign and execute function not available.');
      }

      const total = input.memories.length;

      if (total === 0) {
        throw new Error('No memories provided.');
      }

      updateProgress('preparing', 'Preparing batch operation...', 0, total);

      // Step 1: Extract AI metadata for all memories in batch (if AI service available)
      let metadataArray: Array<{ importance: number; topic: string; summary: string; category: string }> = [];

      if (geminiAIService) {
        updateProgress('preparing', 'Analyzing content with AI...', 0, total);
        try {
          metadataArray = await geminiAIService.extractRichMetadataBatch(
            input.memories.map(m => ({ content: m.content, category: m.category }))
          );
          console.log('✅ AI metadata extracted for all memories');
        } catch (error) {
          console.warn('⚠️ AI metadata extraction failed, using fallbacks:', error);
          // Fallback to simple extraction
          metadataArray = input.memories.map(m => ({
            importance: 5,
            topic: m.category || 'uncategorized',
            summary: m.content.substring(0, 100),
            category: m.category || 'uncategorized'
          }));
        }
      } else {
        console.warn('⚠️ No AI service available, using simple metadata extraction');
        metadataArray = input.memories.map(m => ({
          importance: 5,
          topic: m.category || 'uncategorized',
          summary: m.content.substring(0, 100),
          category: m.category || 'uncategorized'
        }));
      }

      // Step 2: Process each memory: generate embeddings and encrypt
      const processedMemories: Array<{
        content: string;
        category: string;
        importance: number;
        topic: string;
        embedding: number[];
        encryptedContent: Uint8Array;
        summary?: string;
      }> = [];

      for (let i = 0; i < total; i++) {
        const memory = input.memories[i];
        const metadata = metadataArray[i];
        const current = i + 1;

        // Generate embedding
        updateProgress(
          'processing',
          `Generating embedding for memory ${current}/${total}...`,
          current,
          total
        );

        const embeddingResult = await embeddingService.embedText({
          text: memory.content,
          taskType: 'RETRIEVAL_DOCUMENT',
        });

        // Encrypt content
        updateProgress(
          'encrypting',
          `Encrypting memory ${current}/${total}...`,
          current,
          total
        );

        const encryptionResult = await encryptionService.encrypt(
          new TextEncoder().encode(memory.content),
          account.address
        );

        processedMemories.push({
          content: memory.content,
          category: metadata.category,
          importance: metadata.importance,
          topic: metadata.topic,
          embedding: embeddingResult.vector,
          encryptedContent: encryptionResult.encryptedObject,
          summary: metadata.summary,
        });
      }

      // Upload batch to Walrus Quilt
      updateProgress('uploading', 'Uploading batch to Walrus Quilt...', total, total);

      // Create a simple signer wrapper from signAndExecute
      const signer = {
        async signAndSend(txb: any) {
          return new Promise<any>((resolve, reject) => {
            signAndExecute(
              { transaction: txb },
              {
                onSuccess: (result: any) => resolve(result),
                onError: (error: Error) => reject(error),
              }
            );
          });
        },
      };

      const result = await storageService.uploadMemoryBatch(processedMemories, {
        signer: signer as any,
        epochs: 5,
        userAddress: account.address,
      });

      updateProgress('success', 'Batch created successfully!', total, total);

      return {
        quiltId: result.quiltId,
        files: result.files,
        uploadTimeMs: result.uploadTimeMs,
        memoriesCreated: total,
      };
    },
    onSuccess: (data) => {
      // Invalidate relevant queries
      if (invalidateQueries && account) {
        queryClient.invalidateQueries({
          queryKey: cacheKeys.walletMemories(account.address),
        });
        queryClient.invalidateQueries({
          queryKey: cacheKeys.memoryStats(account.address),
        });
      }

      onSuccess?.(data);
    },
    onError: (error: Error) => {
      setProgress({
        stage: 'error',
        message: error.message,
        current: 0,
        total: 0,
        percent: 0,
      });
      onError?.(error);
    },
  });

  return {
    mutate: mutation.mutate,
    mutateAsync: mutation.mutateAsync,
    isPending: mutation.isPending,
    isSuccess: mutation.isSuccess,
    isError: mutation.isError,
    data: mutation.data,
    error: mutation.error,
    progress,
    reset: () => {
      mutation.reset();
      setProgress(undefined);
    },
  };
}

export default useCreateMemoryBatch;
