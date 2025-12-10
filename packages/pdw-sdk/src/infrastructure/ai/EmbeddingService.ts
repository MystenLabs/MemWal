/**
 * EmbeddingService - Local AI Embedding Generation
 *
 * Provides local embedding generation using Google Gemini API,
 * eliminating the need for backend API calls for vector operations.
 */

import { GoogleGenAI } from '@google/genai';

export interface EmbeddingConfig {
  apiKey?: string; // Optional - will fall back to environment variable
  model?: string;
  dimensions?: number;
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
 * Local embedding service using Google Gemini API
 */
export class EmbeddingService {
  private genAI: GoogleGenAI;
  private model: string;
  private dimensions: number;
  private requestCount = 0;
  private lastReset = Date.now();
  private readonly maxRequestsPerMinute: number;

  constructor(config: EmbeddingConfig = {}) {
    // Try config first, then environment variables, then throw error
    const apiKey = config.apiKey || 
                   process.env.GEMINI_API_KEY || 
                   process.env.GOOGLE_AI_API_KEY;
    
    if (!apiKey) {
      throw new Error(
        'Gemini API key is required for embedding generation. ' +
        'Provide it via:\n' +
        '1. config.apiKey parameter\n' +
        '2. GEMINI_API_KEY environment variable\n' +
        '3. GOOGLE_AI_API_KEY environment variable\n' +
        'Get your API key from: https://makersuite.google.com/app/apikey'
      );
    }

    this.genAI = new GoogleGenAI({ apiKey });
    this.model = config.model || 'text-embedding-004';
    this.dimensions = config.dimensions || 768;
    this.maxRequestsPerMinute = config.requestsPerMinute || 1500; // Gemini rate limit
    
    if (process.env.NODE_ENV === 'development') {
      console.log(`✅ EmbeddingService initialized with model: ${this.model}`);
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
      const taskType = this.getTaskType(options.type);

      const result = await this.genAI.models.embedContent({
        model: this.model,
        contents: options.text,
        config: {
          taskType,
          outputDimensionality: this.dimensions
        }
      });

      this.requestCount++;

      const vector = result.embeddings?.[0]?.values;
      
      if (!vector || vector.length === 0) {
        throw new Error('Empty embedding vector received from Gemini API');
      }

      // Ensure vector has expected dimensions
      if (vector.length !== this.dimensions && process.env.NODE_ENV === 'development') {
        console.warn(`Expected ${this.dimensions} dimensions, got ${vector.length}`);
      }

      return {
        vector: Array.from(vector), // Convert to regular array
        dimension: vector.length,
        model: this.model,
        processingTime: Date.now() - startTime,
      };
    } catch (error) {
      throw new Error(`Embedding generation failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  /**
   * Generate embeddings for multiple texts (batched)
   */
  async embedBatch(texts: string[], options: Omit<EmbeddingOptions, 'text'> = {}): Promise<BatchEmbeddingResult> {
    const startTime = Date.now();
    const results: number[][] = [];
    let successCount = 0;
    let failedCount = 0;
    
    // Process in smaller batches to respect rate limits
    const batchSize = 10;
    const totalBatches = Math.ceil(texts.length / batchSize);

    for (let i = 0; i < totalBatches; i++) {
      const batch = texts.slice(i * batchSize, (i + 1) * batchSize);
      
      const batchPromises = batch.map(async (text) => {
        try {
          const result = await this.embedText({ ...options, text });
          successCount++;
          return result.vector;
        } catch (error) {
          failedCount++;
          if (process.env.NODE_ENV === 'development') {
            console.warn(`Failed to embed text: ${text.substring(0, 100)}...`);
          }
          // Return zero vector as fallback
          return new Array(this.dimensions).fill(0);
        }
      });

      const batchResults = await Promise.all(batchPromises);
      results.push(...batchResults);

      // Add delay between batches to respect rate limits
      if (i < totalBatches - 1) {
        await this.delay(100); // 100ms delay between batches
      }
    }

    const totalTime = Date.now() - startTime;

    return {
      vectors: results,
      dimension: this.dimensions,
      model: this.model,
      totalProcessingTime: totalTime,
      averageProcessingTime: totalTime / texts.length,
      successCount,
      failedCount,
    };
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
      return 0; // Handle zero vectors
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
      return vector; // Return as-is if zero vector
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

    // Sort by similarity (highest first)
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
  } {
    const now = Date.now();
    const requestsThisMinute = (now - this.lastReset) < 60000 ? this.requestCount : 0;

    return {
      totalRequests: this.requestCount,
      requestsThisMinute,
      model: this.model,
      dimensions: this.dimensions,
      rateLimit: this.maxRequestsPerMinute,
    };
  }

  /**
   * Reset rate limiting counters (called automatically every minute)
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
   * Get appropriate task type for Gemini API
   */
  private getTaskType(type?: string): 'RETRIEVAL_QUERY' | 'RETRIEVAL_DOCUMENT' | 'SEMANTIC_SIMILARITY' {
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
   * Utility delay function
   */
  private delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

export default EmbeddingService;