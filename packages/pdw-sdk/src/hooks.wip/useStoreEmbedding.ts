/**
 * useStoreEmbedding - Hook for generating and storing vector embeddings
 *
 * Simplifies embedding storage with automatic:
 * - Text to vector embedding conversion (768 dimensions)
 * - Walrus storage upload
 * - Loading states and error handling
 *
 * @example
 * ```tsx
 * import { useStoreEmbedding } from 'personal-data-wallet-sdk/hooks';
 * import { useCurrentAccount, useSignAndExecuteTransaction } from '@mysten/dapp-kit';
 *
 * function EmbeddingUploader() {
 *   const account = useCurrentAccount();
 *   const { mutateAsync: signAndExecute } = useSignAndExecuteTransaction();
 *   const { mutate: storeEmbedding, isPending, data } = useStoreEmbedding({
 *     onSuccess: (result) => {
 *       console.log('Embedding stored:', result.blobId);
 *     }
 *   });
 *
 *   const handleStore = async () => {
 *     if (!account) return;
 *
 *     storeEmbedding({
 *       content: 'The quick brown fox jumps over the lazy dog',
 *       type: 'document',
 *       signer: {
 *         signAndExecuteTransaction: signAndExecute
 *       }
 *     });
 *   };
 *
 *   return (
 *     <div>
 *       <button onClick={handleStore} disabled={isPending || !account}>
 *         {isPending ? 'Storing...' : 'Store Embedding'}
 *       </button>
 *       {data && <div>Blob ID: {data.blobId}</div>}
 *     </div>
 *   );
 * }
 * ```
 */

import { useMutation } from '@tanstack/react-query';
import { useState } from 'react';
import { EmbeddingService } from '../services/EmbeddingService';
import { StorageService } from '../services/StorageService';
import { SuiClient } from '@mysten/sui/client';
import type { Signer } from '@mysten/sui/cryptography';

export interface StoreEmbeddingInput {
  /**
   * Text content to convert to embedding
   */
  content: string;
  /**
   * Signer for Walrus transaction (required for writing blobs)
   */
  signer: Signer;
  /**
   * Type of embedding (affects the model's behavior)
   * - 'document': For storing documents/content
   * - 'query': For search queries
   * - 'metadata': For metadata-based embeddings
   */
  type?: 'document' | 'query' | 'metadata';
  /**
   * Optional metadata to store alongside the embedding
   */
  metadata?: Record<string, any>;
  /**
   * Whether the blob should be deletable (default: false)
   */
  deletable?: boolean;
}

export interface StoreEmbeddingResult {
  /**
   * Walrus blob ID where embedding is stored
   */
  blobId: string;
  /**
   * The generated vector embedding (768 dimensions)
   */
  vector: number[];
  /**
   * Embedding dimension
   */
  dimension: number;
  /**
   * Model used for embedding generation
   */
  model: string;
  /**
   * Time taken to generate embedding (ms)
   */
  embeddingTime: number;
  /**
   * Time taken to upload to Walrus (ms)
   */
  uploadTime: number;
}

export interface UseStoreEmbeddingOptions {
  /**
   * Gemini API key for embedding generation
   */
  geminiApiKey?: string;
  /**
   * PDW package ID for StorageService
   */
  packageId?: string;
  /**
   * Sui RPC URL for StorageService
   */
  suiRpcUrl?: string;
  /**
   * Walrus network ('mainnet' | 'testnet')
   */
  network?: 'mainnet' | 'testnet';
  /**
   * Number of epochs to store on Walrus (default: 5)
   */
  epochs?: number;
  /**
   * Use upload relay (default: true)
   */
  useUploadRelay?: boolean;
  /**
   * Callback when embedding is successfully stored
   */
  onSuccess?: (result: StoreEmbeddingResult) => void;
  /**
   * Callback when an error occurs
   */
  onError?: (error: Error) => void;
}

export interface UseStoreEmbeddingReturn {
  /**
   * Function to store embedding
   */
  mutate: (input: StoreEmbeddingInput) => void;
  /**
   * Async version of mutate
   */
  mutateAsync: (input: StoreEmbeddingInput) => Promise<StoreEmbeddingResult>;
  /**
   * Whether the operation is in progress
   */
  isPending: boolean;
  /**
   * Whether the operation succeeded
   */
  isSuccess: boolean;
  /**
   * Whether the operation failed
   */
  isError: boolean;
  /**
   * Result data if successful
   */
  data?: StoreEmbeddingResult;
  /**
   * Error if operation failed
   */
  error: Error | null;
  /**
   * Current progress message
   */
  progress?: string;
  /**
   * Reset the mutation state
   */
  reset: () => void;
}

/**
 * Hook for storing vector embeddings
 */
export function useStoreEmbedding(
  options: UseStoreEmbeddingOptions = {}
): UseStoreEmbeddingReturn {
  const [progress, setProgress] = useState<string>();

  const mutation = useMutation({
    mutationFn: async (input: StoreEmbeddingInput): Promise<StoreEmbeddingResult> => {
      const {
        content,
        signer,
        type = 'document',
        metadata = {},
        deletable = false
      } = input;

      // Validate content
      if (!content || content.trim().length === 0) {
        throw new Error('Content cannot be empty');
      }

      if (!signer) {
        throw new Error('Signer is required for storing embeddings on Walrus');
      }

      // Initialize services
      const geminiApiKey = options.geminiApiKey || process.env.NEXT_PUBLIC_GEMINI_API_KEY;
      if (!geminiApiKey) {
        throw new Error(
          'Gemini API key is required. Provide via options.geminiApiKey or NEXT_PUBLIC_GEMINI_API_KEY env variable'
        );
      }

      const packageId = options.packageId || process.env.NEXT_PUBLIC_PACKAGE_ID;
      if (!packageId) {
        throw new Error(
          'Package ID is required. Provide via options.packageId or NEXT_PUBLIC_PACKAGE_ID env variable'
        );
      }

      const suiRpcUrl = options.suiRpcUrl ||
                        process.env.NEXT_PUBLIC_SUI_RPC_URL ||
                        'https://fullnode.testnet.sui.io:443';

      const network = options.network || 'testnet';

      // Step 1: Generate embedding
      setProgress('Generating embedding...');
      const embeddingService = new EmbeddingService({
        apiKey: geminiApiKey,
        model: 'text-embedding-004',
        dimensions: 3072
      });

      const embeddingStartTime = Date.now();
      const embeddingResult = await embeddingService.embedText({
        text: content,
        type: type === 'document' ? 'content' : type,
        taskType: type === 'document' ? 'RETRIEVAL_DOCUMENT' :
                  type === 'query' ? 'RETRIEVAL_QUERY' :
                  'SEMANTIC_SIMILARITY'
      });
      const embeddingTime = Date.now() - embeddingStartTime;

      console.log('✅ Embedding generated:', {
        dimension: embeddingResult.dimension,
        model: embeddingResult.model,
        time: embeddingTime + 'ms'
      });

      // Step 2: Prepare data for storage
      setProgress('Preparing data for storage...');
      const storageData = {
        vector: embeddingResult.vector,
        dimension: embeddingResult.dimension,
        model: embeddingResult.model,
        contentPreview: content.substring(0, 200), // Store preview
        contentLength: content.length,
        embeddingType: type,
        metadata,
        timestamp: Date.now()
      };

      const dataBytes = new TextEncoder().encode(JSON.stringify(storageData));
      console.log('📦 Data prepared:', dataBytes.length, 'bytes');

      // Step 3: Upload to Walrus using StorageService
      setProgress('Uploading to Walrus...');
      const suiClient = new SuiClient({ url: suiRpcUrl });

      const storageService = new StorageService({
        packageId,
        suiClient,
        network,
        useUploadRelay: options.useUploadRelay ?? true,
        epochs: options.epochs || 5
      });

      const uploadStartTime = Date.now();
      const result = await storageService.uploadBlob(dataBytes, {
        signer,
        deletable,
        epochs: options.epochs || 5,
        useUploadRelay: options.useUploadRelay ?? true
      });
      const uploadTime = Date.now() - uploadStartTime;

      console.log('✅ Uploaded to Walrus:', {
        blobId: result.blobId,
        time: uploadTime + 'ms',
        storageEpochs: result.storageEpochs
      });

      setProgress(undefined);

      return {
        blobId: result.blobId,
        vector: embeddingResult.vector,
        dimension: embeddingResult.dimension,
        model: embeddingResult.model,
        embeddingTime,
        uploadTime
      };
    },
    onSuccess: (data) => {
      options.onSuccess?.(data);
    },
    onError: (error: Error) => {
      setProgress(undefined);
      options.onError?.(error);
    }
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
    reset: mutation.reset
  };
}
