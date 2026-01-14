/**
 * LangChain Integration for Personal Data Wallet SDK
 *
 * Provides standard LangChain interfaces for PDW's decentralized storage,
 * SEAL encryption, and Sui blockchain integration.
 *
 * @module langchain
 *
 * @example
 * ```typescript
 * import { PDWEmbeddings, PDWVectorStore } from 'personal-data-wallet-sdk/langchain';
 *
 * // Initialize embeddings
 * const embeddings = new PDWEmbeddings({
 *   geminiApiKey: process.env.GEMINI_API_KEY!
 * });
 *
 * // Initialize vector store
 * const vectorStore = new PDWVectorStore(embeddings, {
 *   userAddress: '0x...',
 *   packageId: '0x...',
 *   walrusAggregator: 'https://...'
 * });
 *
 * // Use with LangChain
 * const results = await vectorStore.similaritySearch('query', 5);
 * ```
 */

// Embeddings
export { PDWEmbeddings } from './PDWEmbeddings';
export type { PDWEmbeddingsParams } from './PDWEmbeddings';

// VectorStore
export { PDWVectorStore } from './PDWVectorStore';
export type { PDWVectorStoreConfig, PDWAddDocumentOptions } from './PDWVectorStore';

// RAG Helpers
export {
  createPDWRAG,
  createPDWRAGWithSources,
  createConversationalPDWRAG
} from './createPDWRAG';
export type {
  PDWRAGConfig,
  PDWRAGResult
} from './createPDWRAG';
