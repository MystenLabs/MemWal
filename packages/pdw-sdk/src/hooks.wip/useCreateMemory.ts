/**
 * useCreateMemory - Hook for creating memories with automatic state management
 *
 * Simplifies memory creation with loading states, error handling, and progress tracking.
 *
 * @example
 * ```tsx
 * import { useCreateMemory } from 'personal-data-wallet-sdk/hooks';
 * import { useCurrentAccount, useSignAndExecuteTransaction, useSuiClient } from '@mysten/dapp-kit';
 *
 * function MemoryCreator() {
 *   const account = useCurrentAccount();
 *   const { mutate: signAndExecute } = useSignAndExecuteTransaction();
 *   const client = useSuiClient();
 *
 *   const { mutate: createMemory, isPending, data, error, progress } = useCreateMemory({
 *     onSuccess: (blobId) => {
 *       console.log('Memory created:', blobId);
 *     },
 *     onError: (error) => {
 *       console.error('Failed:', error);
 *     }
 *   });
 *
 *   const handleCreate = () => {
 *     createMemory({
 *       content: 'I love TypeScript',
 *       category: 'personal'
 *     });
 *   };
 *
 *   return (
 *     <div>
 *       <button onClick={handleCreate} disabled={isPending}>
 *         {isPending ? 'Creating...' : 'Create Memory'}
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
import { useMemoryManager } from './useMemoryManager';
import { cacheKeys } from './utils/cache';
import type {
  CreateMemoryInput,
  CreateMemoryProgress,
  CreateMemoryResult,
  MemoryManagerConfig,
} from './utils/types';

export interface UseCreateMemoryOptions {
  /**
   * Callback when memory creation succeeds
   */
  onSuccess?: (result: CreateMemoryResult) => void;

  /**
   * Callback when memory creation fails
   */
  onError?: (error: Error) => void;

  /**
   * Callback for progress updates
   */
  onProgress?: (progress: CreateMemoryProgress) => void;

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

export interface UseCreateMemoryReturn {
  /**
   * Mutation function to create a memory
   */
  mutate: (input: CreateMemoryInput) => void;

  /**
   * Async mutation function (returns promise)
   */
  mutateAsync: (input: CreateMemoryInput) => Promise<CreateMemoryResult>;

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
   * The result data (blobId) if successful
   */
  data?: CreateMemoryResult;

  /**
   * The error if failed
   */
  error: Error | null;

  /**
   * Current progress status
   */
  progress?: CreateMemoryProgress;

  /**
   * Reset mutation state
   */
  reset: () => void;
}

/**
 * Hook for creating memories with automatic state management
 */
export function useCreateMemory(options: UseCreateMemoryOptions = {}): UseCreateMemoryReturn {
  const {
    onSuccess,
    onError,
    onProgress,
    config,
    invalidateQueries = true,
  } = options;

  const queryClient = useQueryClient();
  const client = useSuiClient();
  const account = useCurrentAccount();
  const { mutate: signAndExecute } = useSignAndExecuteTransaction();
  const manager = useMemoryManager(config);

  const [progress, setProgress] = useState<CreateMemoryProgress | undefined>();

  // Progress handler
  const handleProgress = useCallback(
    (status: string) => {
      let stage: CreateMemoryProgress['stage'] = 'analyzing';

      if (status.includes('Analyzing')) {
        stage = 'analyzing';
      } else if (status.includes('embedding')) {
        stage = 'embedding';
      } else if (status.includes('Encrypting')) {
        stage = 'encrypting';
      } else if (status.includes('Uploading')) {
        stage = 'uploading';
      } else if (status.includes('Registering')) {
        stage = 'registering';
      } else if (status.includes('successfully')) {
        stage = 'success';
      }

      const progressUpdate: CreateMemoryProgress = {
        stage,
        message: status,
      };

      setProgress(progressUpdate);
      onProgress?.(progressUpdate);
    },
    [onProgress]
  );

  // Create memory mutation
  const mutation = useMutation({
    mutationFn: async (input: CreateMemoryInput): Promise<CreateMemoryResult> => {
      if (!manager) {
        throw new Error('Memory manager not initialized. Check your configuration.');
      }

      if (!account) {
        throw new Error('No wallet connected. Please connect your wallet.');
      }

      if (!client) {
        throw new Error('Sui client not available.');
      }

      // Create memory
      const blobId = await manager.createMemory({
        content: input.content,
        category: input.category,
        account,
        signAndExecute: signAndExecute as any, // Type compatibility workaround
        client: client as any, // Type compatibility workaround
        onProgress: handleProgress,
      });

      return {
        blobId,
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

export default useCreateMemory;
