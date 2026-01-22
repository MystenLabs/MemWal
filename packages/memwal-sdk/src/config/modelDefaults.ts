/**
 * Model Defaults - Centralized AI model configuration
 *
 * All default AI model settings are defined here for easy customization.
 * Users can override these via:
 * 1. Environment variables (AI_CHAT_MODEL, EMBEDDING_MODEL, etc.)
 * 2. SDK config options when initializing SimplePDWClient
 *
 * @module config/modelDefaults
 */

/**
 * Default AI model configuration
 *
 * @example
 * ```typescript
 * import { MODEL_DEFAULTS } from '@cmdoss/memwal-sdk';
 *
 * // Use defaults
 * console.log(MODEL_DEFAULTS.CHAT_MODEL); // 'google/gemini-2.5-flash'
 *
 * // Override via env vars
 * process.env.AI_CHAT_MODEL = 'anthropic/claude-3.5-sonnet';
 * ```
 */
export const MODEL_DEFAULTS = {
  // =========================================================================
  // Embedding Models (for vector search)
  // =========================================================================

  /** Default embedding model for OpenRouter provider */
  EMBEDDING_OPENROUTER: 'google/gemini-embedding-001',

  /** Default embedding model for Google provider */
  EMBEDDING_GOOGLE: 'text-embedding-004',

  /** Default embedding model for OpenAI provider */
  EMBEDDING_OPENAI: 'text-embedding-3-small',

  /** Default embedding model for Cohere provider */
  EMBEDDING_COHERE: 'embed-english-v3.0',

  // =========================================================================
  // Chat/Analysis Models (for RAG, knowledge graph extraction)
  // =========================================================================

  /**
   * Default chat/analysis model (OpenRouter format)
   *
   * Used for:
   * - RAG responses
   * - Knowledge graph entity extraction
   * - Content classification
   *
   * Popular alternatives:
   * - 'google/gemini-2.5-pro' - higher quality
   * - 'openai/gpt-4o-mini' - fast, cheap
   * - 'openai/gpt-4o' - highest quality
   * - 'anthropic/claude-3.5-sonnet' - balanced
   */
  CHAT_MODEL: 'google/gemini-2.5-flash',

  // =========================================================================
  // Embedding Dimensions
  // =========================================================================

  /**
   * Default embedding dimensions
   *
   * Lower dimensions = faster but less accurate
   * - 768: Fast, good for most use cases (default)
   * - 1536: Balanced
   * - 3072: Highest quality, slowest
   */
  EMBEDDING_DIMENSIONS: 768,
} as const;

/**
 * Get the default embedding model for a provider
 */
export function getDefaultEmbeddingModel(
  provider: 'google' | 'openai' | 'openrouter' | 'cohere' | string
): string {
  switch (provider) {
    case 'google':
      return MODEL_DEFAULTS.EMBEDDING_GOOGLE;
    case 'openai':
      return MODEL_DEFAULTS.EMBEDDING_OPENAI;
    case 'openrouter':
      return MODEL_DEFAULTS.EMBEDDING_OPENROUTER;
    case 'cohere':
      return MODEL_DEFAULTS.EMBEDDING_COHERE;
    default:
      return MODEL_DEFAULTS.EMBEDDING_GOOGLE;
  }
}

/**
 * Get chat model from config or environment
 */
export function getChatModel(configModel?: string): string {
  return configModel || process.env.AI_CHAT_MODEL || MODEL_DEFAULTS.CHAT_MODEL;
}
