/**
 * Embedding Module
 * 
 * AI-powered embedding generation with Google Gemini API integration,
 * batch processing, rate limiting, and comprehensive error handling.
 */

export { EmbeddingService } from '../services/EmbeddingService';

export type {
  VectorEmbedding,
  EmbeddingConfig,
  EmbeddingOptions,
  EmbeddingResult,
  BatchEmbeddingResult,
  Memory,
  ProcessedMemory,
  MemoryPipelineConfig,
  MemoryPipelineResult
} from './types';