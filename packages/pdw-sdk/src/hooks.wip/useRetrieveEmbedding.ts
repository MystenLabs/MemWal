/**
 * useRetrieveEmbedding - Hook for retrieving stored vector embeddings
 *
 * Fetches embedding data from Walrus storage with automatic:
 * - Walrus blob retrieval
 * - JSON parsing
 * - Caching with React Query
 * - Loading and error states
 *
 * @example
 * ```tsx
 * import { useRetrieveEmbedding } from 'personal-data-wallet-sdk/hooks';
 *
 * function EmbeddingViewer({ blobId }: { blobId: string }) {
 *   const { data, isLoading, error, refetch } = useRetrieveEmbedding(blobId, {
 *     enabled: !!blobId // Only fetch when blobId is available
 *   });
 *
 *   if (isLoading) return <div>Loading embedding...</div>;
 *   if (error) return <div>Error: {error.message}</div>;
 *   if (!data) return null;
 *
 *   return (
 *     <div>
 *       <p>Dimension: {data.dimension}</p>
 *       <p>Model: {data.model}</p>
 *       <p>Vector length: {data.vector.length}</p>
 *       <button onClick={() => refetch()}>Refresh</button>
 *     </div>
 *   );
 * }
 * ```
 */

import { useQuery } from '@tanstack/react-query';
import { StorageService } from '../services/StorageService';
import { SuiClient } from '@mysten/sui/client';

export interface RetrievedEmbedding {
  /**
   * The vector embedding (768 dimensions)
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
   * Preview of the original content (first 200 chars)
   */
  contentPreview: string;
  /**
   * Original content length
   */
  contentLength: number;
  /**
   * Type of embedding
   */
  embeddingType: 'document' | 'query' | 'metadata';
  /**
   * Additional metadata stored with the embedding
   */
  metadata: Record<string, any>;
  /**
   * Timestamp when embedding was created
   */
  timestamp: number;
}

export interface UseRetrieveEmbeddingOptions {
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
   * Whether to fetch immediately (default: true)
   */
  enabled?: boolean;
  /**
   * Stale time in milliseconds (default: 5 minutes)
   * How long before cached data is considered stale
   */
  staleTime?: number;
  /**
   * Cache time in milliseconds (default: 10 minutes)
   * How long to keep cached data before garbage collection
   */
  cacheTime?: number;
  /**
   * Callback when data is successfully fetched
   */
  onSuccess?: (data: RetrievedEmbedding) => void;
  /**
   * Callback when an error occurs
   */
  onError?: (error: Error) => void;
}

export interface UseRetrieveEmbeddingReturn {
  /**
   * Retrieved embedding data
   */
  data?: RetrievedEmbedding;
  /**
   * Whether the query is loading
   */
  isLoading: boolean;
  /**
   * Whether the query is fetching (including background refetch)
   */
  isFetching: boolean;
  /**
   * Whether the query succeeded
   */
  isSuccess: boolean;
  /**
   * Whether the query failed
   */
  isError: boolean;
  /**
   * Error if query failed
   */
  error: Error | null;
  /**
   * Manually refetch the embedding
   */
  refetch: () => Promise<any>;
}

/**
 * Hook for retrieving vector embeddings from Walrus
 */
export function useRetrieveEmbedding(
  blobId: string | undefined,
  options: UseRetrieveEmbeddingOptions = {}
): UseRetrieveEmbeddingReturn {
  const packageId = options.packageId || process.env.NEXT_PUBLIC_PACKAGE_ID;
  const suiRpcUrl = options.suiRpcUrl ||
                    process.env.NEXT_PUBLIC_SUI_RPC_URL ||
                    'https://fullnode.testnet.sui.io:443';

  const network = options.network || 'testnet';

  const query = useQuery({
    queryKey: ['embedding', blobId],
    queryFn: async (): Promise<RetrievedEmbedding> => {
      if (!blobId) {
        throw new Error('Blob ID is required');
      }

      if (!packageId) {
        throw new Error(
          'Package ID is required. Provide via options.packageId or NEXT_PUBLIC_PACKAGE_ID env variable'
        );
      }

      console.log('🔍 Retrieving embedding from Walrus:', blobId);

      // Initialize StorageService
      const suiClient = new SuiClient({ url: suiRpcUrl });

      const storageService = new StorageService({
        packageId,
        suiClient,
        network
      });

      // Fetch blob from Walrus
      const startTime = Date.now();
      const data = await storageService.getBlob(blobId);
      const fetchTime = Date.now() - startTime;

      console.log('✅ Blob fetched:', {
        blobId,
        size: data.byteLength,
        time: fetchTime + 'ms'
      });

      // Parse JSON data
      const text = new TextDecoder().decode(data);
      const parsed = JSON.parse(text);

      // Validate structure
      if (!parsed.vector || !Array.isArray(parsed.vector)) {
        throw new Error('Invalid embedding data: missing or invalid vector');
      }

      if (!parsed.dimension || typeof parsed.dimension !== 'number') {
        throw new Error('Invalid embedding data: missing or invalid dimension');
      }

      console.log('✅ Embedding parsed:', {
        dimension: parsed.dimension,
        model: parsed.model,
        type: parsed.embeddingType
      });

      return {
        vector: parsed.vector,
        dimension: parsed.dimension,
        model: parsed.model || 'unknown',
        contentPreview: parsed.contentPreview || '',
        contentLength: parsed.contentLength || 0,
        embeddingType: parsed.embeddingType || 'document',
        metadata: parsed.metadata || {},
        timestamp: parsed.timestamp || 0
      };
    },
    enabled: options.enabled !== false && !!blobId,
    staleTime: options.staleTime ?? 5 * 60 * 1000, // 5 minutes
    gcTime: options.cacheTime ?? 10 * 60 * 1000, // 10 minutes
    retry: 2,
    retryDelay: (attemptIndex) => Math.min(1000 * 2 ** attemptIndex, 5000),
  });

  // Call callbacks
  if (query.isSuccess && query.data && options.onSuccess) {
    options.onSuccess(query.data);
  }

  if (query.isError && query.error && options.onError) {
    options.onError(query.error as Error);
  }

  return {
    data: query.data,
    isLoading: query.isLoading,
    isFetching: query.isFetching,
    isSuccess: query.isSuccess,
    isError: query.isError,
    error: query.error as Error | null,
    refetch: query.refetch
  };
}
