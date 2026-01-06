/**
 * Embeddings Namespace - Direct Embedding Operations
 *
 * Pure delegation to EmbeddingService for direct embedding access.
 * Useful for custom RAG pipelines and advanced AI integrations.
 *
 * @module client/namespaces
 */

import type { ServiceContainer } from '../SimplePDWClient';

/**
 * Embeddings Namespace
 *
 * Handles direct embedding generation and operations
 */
export class EmbeddingsNamespace {
  constructor(private services: ServiceContainer) {}

  /**
   * Generate embedding for single text
   *
   * Delegates to: EmbeddingService.embedText()
   *
   * @param text - Text to embed
   * @param options - Embedding options
   * @returns Embedding vector (3072 dimensions for Gemini)
   */
  async generate(text: string, options?: { type?: 'query' | 'document' }): Promise<number[]> {
    if (!this.services.embedding) {
      throw new Error('Embedding service not configured. Please provide geminiApiKey.');
    }

    const result = await this.services.embedding.embedText({ text });
    return result.vector;
  }

  /**
   * Generate embeddings for multiple texts
   *
   * Delegates to: EmbeddingService.embedBatch()
   *
   * @param texts - Array of texts
   * @returns Array of embedding vectors
   */
  async batch(texts: string[]): Promise<number[][]> {
    if (!this.services.embedding) {
      throw new Error('Embedding service not configured.');
    }

    const result = await this.services.embedding.embedBatch(texts);
    return result.vectors;
  }

  /**
   * Calculate cosine similarity between two vectors
   *
   * Delegates to: EmbeddingService.calculateCosineSimilarity()
   *
   * @param vector1 - First vector
   * @param vector2 - Second vector
   * @returns Similarity score (0-1, higher is more similar)
   */
  similarity(vector1: number[], vector2: number[]): number {
    if (!this.services.embedding) {
      throw new Error('Embedding service not configured.');
    }

    return this.services.embedding.calculateCosineSimilarity(vector1, vector2);
  }

  /**
   * Find most similar vectors from candidates
   *
   * Delegates to: EmbeddingService.findMostSimilar()
   *
   * @param queryVector - Query vector
   * @param candidateVectors - Candidate vectors to compare
   * @param k - Number of results (default: 5)
   * @returns Top k similar vectors with scores
   */
  findSimilar(
    queryVector: number[],
    candidateVectors: number[][],
    k: number = 5
  ): Array<{ index: number; score: number }> {
    if (!this.services.embedding) {
      throw new Error('Embedding service not configured.');
    }

    const results = this.services.embedding.findMostSimilar(queryVector, candidateVectors, k);

    // Adapt result format (similarity → score)
    return results.map(r => ({
      index: r.index,
      score: r.similarity
    }));
  }
}
