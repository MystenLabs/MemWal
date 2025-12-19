/**
 * PDWEmbeddings - LangChain Embeddings adapter for Personal Data Wallet
 *
 * Integrates PDW's EmbeddingService (Google Gemini) with LangChain's Embeddings interface.
 * Enables seamless use of PDW embeddings in any LangChain workflow.
 *
 * @example
 * ```typescript
 * import { PDWEmbeddings } from 'personal-data-wallet-sdk/langchain';
 *
 * const embeddings = new PDWEmbeddings({
 *   geminiApiKey: process.env.GEMINI_API_KEY
 * });
 *
 * // Use with any LangChain VectorStore
 * const vectorStore = new SomeVectorStore(embeddings, config);
 * ```
 */

import { Embeddings, EmbeddingsParams } from '@langchain/core/embeddings';
import { EmbeddingService } from '../services/EmbeddingService';
import type { EmbeddingConfig } from '../services/EmbeddingService';

export interface PDWEmbeddingsParams extends EmbeddingsParams {
  /**
   * Google Gemini API key for embedding generation
   * Get your key from: https://aistudio.google.com/app/apikey
   */
  geminiApiKey: string;

  /**
   * Embedding model to use
   * @default 'text-embedding-004'
   */
  model?: string;

  /**
   * Embedding dimensions
   * @default 3072
   */
  dimensions?: number;

  /**
   * Maximum requests per minute (rate limiting)
   * @default 1500
   */
  requestsPerMinute?: number;
}

/**
 * LangChain Embeddings implementation using Personal Data Wallet's EmbeddingService
 *
 * This adapter wraps PDW's existing EmbeddingService to provide a standard
 * LangChain Embeddings interface, enabling drop-in compatibility with the
 * entire LangChain ecosystem.
 */
export class PDWEmbeddings extends Embeddings {
  private embeddingService: EmbeddingService;
  private readonly model: string;
  private readonly dimensions: number;

  constructor(params: PDWEmbeddingsParams) {
    super(params);

    // Validate API key
    if (!params.geminiApiKey) {
      throw new Error(
        'geminiApiKey is required for PDWEmbeddings. ' +
        'Get your API key from: https://aistudio.google.com/app/apikey'
      );
    }

    this.model = params.model || 'text-embedding-004';
    this.dimensions = params.dimensions || 3072;

    // Initialize PDW's EmbeddingService
    const config: EmbeddingConfig = {
      apiKey: params.geminiApiKey,
      model: this.model,
      dimensions: this.dimensions,
      requestsPerMinute: params.requestsPerMinute || 1500,
    };

    this.embeddingService = new EmbeddingService(config);
  }

  /**
   * Embed multiple documents (LangChain interface)
   *
   * @param texts - Array of document texts to embed
   * @returns Promise resolving to array of embedding vectors
   */
  async embedDocuments(texts: string[]): Promise<number[][]> {
    try {
      // Use batch embedding for efficiency
      const result = await this.embeddingService.embedBatch(texts, {
        type: 'content', // Documents are content, not queries
      });

      return result.vectors;
    } catch (error) {
      throw new Error(
        `Failed to embed documents: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  /**
   * Embed a single query (LangChain interface)
   *
   * @param text - Query text to embed
   * @returns Promise resolving to embedding vector
   */
  async embedQuery(text: string): Promise<number[]> {
    try {
      // Use query-optimized embedding
      const result = await this.embeddingService.embedText({
        text,
        type: 'query', // Queries get different optimization
        taskType: 'RETRIEVAL_QUERY',
      });

      return result.vector;
    } catch (error) {
      throw new Error(
        `Failed to embed query: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  /**
   * Get embedding model information
   */
  getModelInfo(): {
    model: string;
    dimensions: number;
    provider: string;
  } {
    return {
      model: this.model,
      dimensions: this.dimensions,
      provider: 'Google Gemini',
    };
  }
}
