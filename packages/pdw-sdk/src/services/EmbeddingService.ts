/**
 * EmbeddingService - AI SDK Integration
 *
 * Refactored to use Vercel AI SDK as the underlying embedding provider.
 * Supports any AI SDK compatible provider (OpenAI, Google, Cohere, etc.)
 * while maintaining backward compatibility with existing PDW code.
 *
 * Key features:
 * - Provider-agnostic: Accept any ai-sdk EmbeddingModel
 * - Backward compatible: Existing code continues to work
 * - Flexible configuration: Direct model OR provider config
 */

import type { EmbeddingModelV2 } from '@ai-sdk/provider';
import { embed, embedMany } from 'ai';
import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { createOpenAI } from '@ai-sdk/openai';

// Type alias for embedding models - V2 is the default in AI SDK v5
type EmbeddingModel<VALUE> = EmbeddingModelV2<VALUE>;

// Provider instances (lazily initialized)
let googleProvider: ReturnType<typeof createGoogleGenerativeAI> | null = null;
let openaiProvider: ReturnType<typeof createOpenAI> | null = null;
let openrouterProvider: ReturnType<typeof createOpenAI> | null = null;
let cohereProvider: any = null;

export interface EmbeddingConfig {
  /**
   * Option 1: Direct ai-sdk model (most flexible)
   * User provides their own EmbeddingModel from any provider
   *
   * For backward compatibility, also accepts string (treated as modelName)
   *
   * @example
   * ```typescript
   * import { openai } from '@ai-sdk/openai';
   * const service = new EmbeddingService({
   *   model: openai.embedding('text-embedding-3-large')
   * });
   *
   * // Backward compatible:
   * const service = new EmbeddingService({
   *   model: 'text-embedding-004', // Treated as modelName
   *   apiKey: 'your-key'
   * });
   * ```
   */
  model?: EmbeddingModel<string> | string;

  /**
   * Option 2: Provider-based configuration
   * PDW creates the model from provider settings
   *
   * - google: Direct Google AI API
   * - openai: Direct OpenAI API
   * - openrouter: OpenRouter API gateway (supports multiple models)
   * - cohere: Direct Cohere API
   */
  provider?: 'google' | 'openai' | 'openrouter' | 'cohere';

  /**
   * API key for the provider
   * Falls back to environment variables:
   * - GEMINI_API_KEY or GOOGLE_AI_API_KEY (for google)
   * - OPENAI_API_KEY (for openai)
   * - OPENROUTER_API_KEY (for openrouter)
   * - COHERE_API_KEY (for cohere)
   */
  apiKey?: string;

  /**
   * Model name to use
   * - Google: 'text-embedding-004', 'gemini-embedding-001'
   * - OpenAI: 'text-embedding-3-small', 'text-embedding-3-large'
   * - OpenRouter: 'google/gemini-embedding-001', 'openai/text-embedding-3-small', etc.
   * - Cohere: 'embed-english-v3.0', 'embed-multilingual-v3.0'
   */
  modelName?: string;

  /**
   * Embedding dimensions (optional, provider-dependent)
   * - Google: Up to 768
   * - OpenAI: 256, 512, 1024, 1536, 3072 (depending on model)
   * - OpenRouter: Depends on the underlying model
   * - Cohere: Model-specific
   */
  dimensions?: number;

  /**
   * Rate limiting
   */
  requestsPerMinute?: number;
}

export interface EmbeddingOptions {
  text: string;
  type?: 'content' | 'metadata' | 'query';
  taskType?: 'RETRIEVAL_QUERY' | 'RETRIEVAL_DOCUMENT' | 'SEMANTIC_SIMILARITY';
}

export interface EmbeddingResult {
  vector: number[];
  dimension: number;
  model: string;
  processingTime: number;
  tokenCount?: number;
}

export interface BatchEmbeddingResult {
  vectors: number[][];
  dimension: number;
  model: string;
  totalProcessingTime: number;
  averageProcessingTime: number;
  successCount: number;
  failedCount: number;
}

/**
 * Embedding service using Vercel AI SDK
 * Supports all AI SDK compatible providers
 * OpenRouter uses native fetch API for better compatibility
 */
export class EmbeddingService {
  private embeddingModel: EmbeddingModel<string> | null = null;
  private modelName: string;
  private dimensions: number;
  private requestCount = 0;
  private lastReset = Date.now();
  private readonly maxRequestsPerMinute: number;
  private provider: 'google' | 'openai' | 'openrouter' | 'cohere' | 'custom';
  private apiKey: string = '';

  constructor(config: EmbeddingConfig = {}) {
    this.maxRequestsPerMinute = config.requestsPerMinute || 1500;

    // Case 1: Direct model provided (most flexible)
    if (config.model) {
      // Backward compatibility: If model is a string, treat as modelName
      if (typeof config.model === 'string') {
        const modelNameFromString = config.model;
        console.log(`🔄 Backward compatibility: treating model string "${modelNameFromString}" as modelName`);

        // Treat string as modelName and use provider config path
        const provider = config.provider || 'google';
        this.apiKey = this.resolveApiKey(provider, config.apiKey);

        if (!this.apiKey) {
          throw new Error(
            `API key is required for ${provider} provider. ` +
            `Provide it via config.apiKey or environment variable.`
          );
        }

        this.provider = provider;
        this.modelName = modelNameFromString;
        this.dimensions = config.dimensions || this.getDefaultDimensions(provider);

        // OpenRouter uses native fetch, others use AI SDK
        if (provider !== 'openrouter') {
          this.embeddingModel = this.createModel(provider, this.apiKey, this.modelName);
        }

        console.log(`✅ EmbeddingService initialized with ${provider} provider (${this.modelName}) [backward compat mode]`);
        return;
      }

      // New behavior: Direct EmbeddingModel from ai-sdk
      this.embeddingModel = config.model;
      this.modelName = 'custom';
      this.dimensions = config.dimensions || 3072;
      this.provider = 'custom';
      console.log('✅ EmbeddingService initialized with custom ai-sdk model');
      return;
    }

    // Case 2: Provider-based configuration
    const provider = config.provider || 'google'; // Default to google for backward compat
    this.apiKey = this.resolveApiKey(provider, config.apiKey);

    if (!this.apiKey) {
      throw new Error(
        `API key is required for ${provider} provider. ` +
        `Provide it via config.apiKey or environment variable.`
      );
    }

    this.provider = provider;
    this.modelName = config.modelName || this.getDefaultModelName(provider);
    this.dimensions = config.dimensions || this.getDefaultDimensions(provider);

    // OpenRouter uses native fetch API for better compatibility
    // Other providers use AI SDK
    if (provider !== 'openrouter') {
      this.embeddingModel = this.createModel(provider, this.apiKey, this.modelName);
    }

    console.log(`✅ EmbeddingService initialized with ${provider} provider (${this.modelName})`);
  }

  /**
   * Resolve API key from config or environment
   */
  private resolveApiKey(provider: string, configKey?: string): string {
    if (configKey) return configKey;

    switch (provider) {
      case 'google':
        return process.env.GEMINI_API_KEY || process.env.GOOGLE_AI_API_KEY || '';
      case 'openai':
        return process.env.OPENAI_API_KEY || '';
      case 'openrouter':
        return process.env.OPENROUTER_API_KEY || '';
      case 'cohere':
        return process.env.COHERE_API_KEY || '';
      default:
        return '';
    }
  }

  /**
   * Get default model name for provider
   */
  private getDefaultModelName(provider: string): string {
    switch (provider) {
      case 'google':
        return 'text-embedding-004';
      case 'openai':
        return 'text-embedding-3-small';
      case 'openrouter':
        return 'google/gemini-embedding-001'; // Default OpenRouter embedding model
      case 'cohere':
        return 'embed-english-v3.0';
      default:
        return 'text-embedding-004';
    }
  }

  /**
   * Get default dimensions for provider
   */
  private getDefaultDimensions(provider: string): number {
    switch (provider) {
      case 'google':
        return 3072;
      case 'openai':
        return 1536; // text-embedding-3-small default
      case 'openrouter':
        return 3072; // google/gemini-embedding-001 returns 3072 dimensions
      case 'cohere':
        return 1024;
      default:
        return 3072;
    }
  }

  /**
   * Create embedding model from provider
   */
  private createModel(
    provider: string,
    apiKey: string,
    modelName: string
  ): EmbeddingModel<string> {
    switch (provider) {
      case 'google': {
        if (!googleProvider) {
          googleProvider = createGoogleGenerativeAI({ apiKey });
        }
        return googleProvider.textEmbeddingModel(modelName);
      }

      case 'openai': {
        if (!openaiProvider) {
          openaiProvider = createOpenAI({ apiKey });
        }
        // OpenAI returns EmbeddingModelV2 but is compatible with ai SDK
        return openaiProvider.textEmbeddingModel(modelName) as unknown as EmbeddingModel<string>;
      }

      case 'openrouter': {
        // OpenRouter uses OpenAI-compatible API with custom baseURL
        if (!openrouterProvider) {
          openrouterProvider = createOpenAI({
            baseURL: 'https://openrouter.ai/api/v1',
            apiKey,
          });
        }
        // OpenRouter embedding models use the same interface as OpenAI
        return openrouterProvider.textEmbeddingModel(modelName) as unknown as EmbeddingModel<string>;
      }

      case 'cohere': {
        if (!cohereProvider) {
          throw new Error(
            'Cohere provider requires manual initialization. ' +
            'Import createCohere from @ai-sdk/cohere and set cohereProvider before use.'
          );
        }
        return cohereProvider.textEmbedding(modelName);
      }

      default:
        throw new Error(`Unsupported provider: ${provider}`);
    }
  }

  /**
   * Generate embedding for a single text
   */
  async embedText(options: EmbeddingOptions): Promise<EmbeddingResult> {
    const startTime = Date.now();

    // Validate input
    if (!options.text || typeof options.text !== 'string' || options.text.trim().length === 0) {
      throw new Error('Invalid or empty text provided for embedding');
    }

    await this.checkRateLimit();

    try {
      // OpenRouter uses native fetch API for better compatibility
      if (this.provider === 'openrouter') {
        return await this.embedTextOpenRouter(options.text, startTime);
      }

      // Other providers use AI SDK
      if (!this.embeddingModel) {
        throw new Error('Embedding model not initialized');
      }

      const result = await embed({
        model: this.embeddingModel,
        value: options.text,
        ...this.getProviderOptions(options),
      });

      this.requestCount++;

      return {
        vector: result.embedding,
        dimension: result.embedding.length,
        model: this.modelName,
        processingTime: Date.now() - startTime,
        tokenCount: result.usage?.tokens,
      };
    } catch (error) {
      throw new Error(
        `Embedding generation failed: ${error instanceof Error ? error.message : 'Unknown error'}`
      );
    }
  }

  /**
   * Generate embedding using OpenRouter native API
   * Uses direct fetch to /api/v1/embeddings endpoint
   */
  private async embedTextOpenRouter(text: string, startTime: number): Promise<EmbeddingResult> {
    const response = await fetch('https://openrouter.ai/api/v1/embeddings', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': 'https://github.com/personal-data-wallet',
        'X-Title': 'Personal Data Wallet SDK'
      },
      body: JSON.stringify({
        model: this.modelName,
        input: text
      })
    });

    if (!response.ok) {
      const errorData = await response.text();
      throw new Error(`OpenRouter embedding failed: ${response.status} - ${errorData}`);
    }

    const data = await response.json();

    if (!data.data || !data.data[0] || !data.data[0].embedding) {
      throw new Error('Invalid response from OpenRouter embeddings API');
    }

    this.requestCount++;

    return {
      vector: data.data[0].embedding,
      dimension: data.data[0].embedding.length,
      model: this.modelName,
      processingTime: Date.now() - startTime,
      tokenCount: data.usage?.total_tokens
    };
  }

  /**
   * Generate embeddings for multiple texts (batched)
   */
  async embedBatch(
    texts: string[],
    options: Omit<EmbeddingOptions, 'text'> = {}
  ): Promise<BatchEmbeddingResult> {
    const startTime = Date.now();
    let successCount = 0;
    let failedCount = 0;

    try {
      await this.checkRateLimit();

      // OpenRouter uses native fetch API for better compatibility
      if (this.provider === 'openrouter') {
        return await this.embedBatchOpenRouter(texts, startTime);
      }

      // Other providers use AI SDK
      if (!this.embeddingModel) {
        throw new Error('Embedding model not initialized');
      }

      const result = await embedMany({
        model: this.embeddingModel,
        values: texts,
        ...this.getProviderOptions(options as EmbeddingOptions),
      });

      successCount = result.embeddings.length;
      const totalTime = Date.now() - startTime;

      return {
        vectors: result.embeddings,
        dimension: result.embeddings[0]?.length || this.dimensions,
        model: this.modelName,
        totalProcessingTime: totalTime,
        averageProcessingTime: totalTime / texts.length,
        successCount,
        failedCount,
      };
    } catch (error) {
      throw new Error(
        `Batch embedding failed: ${error instanceof Error ? error.message : 'Unknown error'}`
      );
    }
  }

  /**
   * Generate batch embeddings using OpenRouter native API
   */
  private async embedBatchOpenRouter(texts: string[], startTime: number): Promise<BatchEmbeddingResult> {
    const response = await fetch('https://openrouter.ai/api/v1/embeddings', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': 'https://github.com/personal-data-wallet',
        'X-Title': 'Personal Data Wallet SDK'
      },
      body: JSON.stringify({
        model: this.modelName,
        input: texts
      })
    });

    if (!response.ok) {
      const errorData = await response.text();
      throw new Error(`OpenRouter batch embedding failed: ${response.status} - ${errorData}`);
    }

    const data = await response.json();

    if (!data.data || !Array.isArray(data.data)) {
      throw new Error('Invalid response from OpenRouter embeddings API');
    }

    // Sort by index to ensure correct order
    const sortedData = data.data.sort((a: any, b: any) => a.index - b.index);
    const vectors = sortedData.map((item: any) => item.embedding);

    this.requestCount++;
    const totalTime = Date.now() - startTime;

    return {
      vectors,
      dimension: vectors[0]?.length || this.dimensions,
      model: this.modelName,
      totalProcessingTime: totalTime,
      averageProcessingTime: totalTime / texts.length,
      successCount: vectors.length,
      failedCount: texts.length - vectors.length
    };
  }

  /**
   * Get provider-specific options
   */
  private getProviderOptions(options: EmbeddingOptions): any {
    const providerOpts: any = {};

    if (this.provider === 'google') {
      providerOpts.providerOptions = {
        google: {
          outputDimensionality: this.dimensions,
          taskType: this.getGoogleTaskType(options.type),
        },
      };
    } else if (this.provider === 'openai') {
      providerOpts.providerOptions = {
        openai: {
          dimensions: this.dimensions,
        },
      };
    } else if (this.provider === 'openrouter') {
      // OpenRouter uses OpenAI-compatible options
      // Note: dimensions may not be supported for all models via OpenRouter
      providerOpts.providerOptions = {
        openai: {
          dimensions: this.dimensions,
        },
      };
    } else if (this.provider === 'cohere') {
      providerOpts.providerOptions = {
        cohere: {
          inputType: this.getCohereInputType(options.type),
        },
      };
    }

    return providerOpts;
  }

  /**
   * Map PDW type to Google task type
   */
  private getGoogleTaskType(type?: string): string {
    switch (type) {
      case 'query':
        return 'RETRIEVAL_QUERY';
      case 'content':
        return 'RETRIEVAL_DOCUMENT';
      case 'metadata':
        return 'SEMANTIC_SIMILARITY';
      default:
        return 'RETRIEVAL_DOCUMENT';
    }
  }

  /**
   * Map PDW type to Cohere input type
   */
  private getCohereInputType(type?: string): string {
    switch (type) {
      case 'query':
        return 'search_query';
      case 'content':
        return 'search_document';
      default:
        return 'search_document';
    }
  }

  /**
   * Calculate cosine similarity between two vectors
   */
  calculateCosineSimilarity(vectorA: number[], vectorB: number[]): number {
    if (vectorA.length !== vectorB.length) {
      throw new Error(`Vector dimension mismatch: ${vectorA.length} vs ${vectorB.length}`);
    }

    let dotProduct = 0;
    let normA = 0;
    let normB = 0;

    for (let i = 0; i < vectorA.length; i++) {
      dotProduct += vectorA[i] * vectorB[i];
      normA += vectorA[i] * vectorA[i];
      normB += vectorB[i] * vectorB[i];
    }

    const magnitude = Math.sqrt(normA) * Math.sqrt(normB);

    if (magnitude === 0) {
      return 0;
    }

    return dotProduct / magnitude;
  }

  /**
   * Calculate Euclidean distance between two vectors
   */
  calculateEuclideanDistance(vectorA: number[], vectorB: number[]): number {
    if (vectorA.length !== vectorB.length) {
      throw new Error(`Vector dimension mismatch: ${vectorA.length} vs ${vectorB.length}`);
    }

    let sum = 0;
    for (let i = 0; i < vectorA.length; i++) {
      const diff = vectorA[i] - vectorB[i];
      sum += diff * diff;
    }

    return Math.sqrt(sum);
  }

  /**
   * Normalize a vector to unit length
   */
  normalizeVector(vector: number[]): number[] {
    const magnitude = Math.sqrt(vector.reduce((sum, val) => sum + val * val, 0));

    if (magnitude === 0) {
      return vector;
    }

    return vector.map(val => val / magnitude);
  }

  /**
   * Find the most similar vectors to a query vector
   */
  findMostSimilar(
    queryVector: number[],
    candidateVectors: number[][],
    k: number = 5
  ): Array<{ index: number; similarity: number; distance: number }> {
    const similarities = candidateVectors.map((vector, index) => {
      const similarity = this.calculateCosineSimilarity(queryVector, vector);
      const distance = this.calculateEuclideanDistance(queryVector, vector);

      return { index, similarity, distance };
    });

    similarities.sort((a, b) => b.similarity - a.similarity);

    return similarities.slice(0, k);
  }

  /**
   * Get embedding statistics
   */
  getStats(): {
    totalRequests: number;
    requestsThisMinute: number;
    model: string;
    dimensions: number;
    rateLimit: number;
    provider: string;
  } {
    const now = Date.now();
    const requestsThisMinute = (now - this.lastReset) < 60000 ? this.requestCount : 0;

    return {
      totalRequests: this.requestCount,
      requestsThisMinute,
      model: this.modelName,
      dimensions: this.dimensions,
      rateLimit: this.maxRequestsPerMinute,
      provider: this.provider,
    };
  }

  /**
   * Reset rate limiting counters
   */
  private resetRateLimit(): void {
    const now = Date.now();
    if (now - this.lastReset >= 60000) {
      this.requestCount = 0;
      this.lastReset = now;
    }
  }

  /**
   * Check rate limiting and wait if necessary
   */
  private async checkRateLimit(): Promise<void> {
    this.resetRateLimit();

    if (this.requestCount >= this.maxRequestsPerMinute) {
      const waitTime = 60000 - (Date.now() - this.lastReset);
      if (waitTime > 0) {
        if (process.env.NODE_ENV === 'development') {
          console.warn(`Rate limit reached, waiting ${waitTime}ms`);
        }
        await this.delay(waitTime);
        this.resetRateLimit();
      }
    }
  }

  /**
   * Utility delay function
   */
  private delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

export default EmbeddingService;
