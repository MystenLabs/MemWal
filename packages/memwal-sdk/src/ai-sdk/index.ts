/**
 * AI SDK Integration Exports
 *
 * Import from: 'personal-data-wallet-sdk/ai-sdk'
 *
 * Provides a familiar vector store API for Vercel AI SDK users,
 * with full PDW capabilities (Walrus + Sui + Graphs + Encryption).
 *
 * @example
 * ```typescript
 * import { PDWVectorStore } from 'personal-data-wallet-sdk/ai-sdk';
 * import { embed } from 'ai';
 * import { openai } from '@ai-sdk/openai';
 *
 * // Create vector store
 * const store = new PDWVectorStore({
 *   walrus: { aggregator: '...' },
 *   sui: { network: 'testnet', packageId: '...' },
 *   signer,
 *   userAddress,
 *   dimensions: 1536
 * });
 *
 * // Use with AI SDK
 * const { embedding } = await embed({
 *   model: openai.embedding('text-embedding-3-large'),
 *   value: 'Hello world'
 * });
 *
 * await store.add({
 *   id: 'doc-1',
 *   vector: embedding,
 *   text: 'Hello world'
 * });
 *
 * const results = await store.search({ vector: queryEmbedding, limit: 5 });
 * ```
 *
 * @module ai-sdk
 */

// Main vector store class
export { PDWVectorStore, PDWVectorStoreError } from './PDWVectorStore';

// Tools for AI SDK agents
export { pdwTools } from './tools';
export type { PDWToolsConfig, PDWToolResult } from './tools';

// Type definitions
export type {
  PDWVectorStoreConfig,
  AddVectorParams,
  AddVectorBatchParams,
  SearchParams,
  SearchResult,
  AddVectorResult,
  AddVectorBatchResult,
  GetVectorParams,
  GetVectorResult,
  DeleteVectorParams,
  DeleteVectorResult,
  VectorStoreStats,
  ProgressCallback,
  PDWErrorType,
} from './types';
