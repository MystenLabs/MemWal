/**
 * PDW Tools for AI SDK - Phase 1 (MVP)
 *
 * Provides AI agents with tools to interact with Personal Data Wallet.
 * Tools automatically handle embeddings, storage, and search.
 *
 * @example
 * ```typescript
 * import { generateText } from 'ai';
 * import { google } from '@ai-sdk/google';
 * import { pdwTools } from 'personal-data-wallet-sdk/ai-sdk';
 *
 * const tools = pdwTools({
 *   userId: 'user-123',
 *   pdwConfig: {
 *     walrus: { aggregator: '...' },
 *     sui: { network: 'testnet', packageId: '...' },
 *     signer,
 *     userAddress,
 *     dimensions: 3072 // Gemini embedding dimensions
 *   }
 * });
 *
 * const result = await generateText({
 *   model: google('gemini-2.0-flash-exp'),
 *   tools,
 *   prompt: "Remember that I love TypeScript"
 * });
 * ```
 *
 * @module ai-sdk/tools
 */

import { tool, embed } from 'ai';
import { z } from 'zod';
import type { EmbeddingModel } from 'ai';
import { PDWVectorStore } from './PDWVectorStore';
import type { PDWVectorStoreConfig } from './types';

/**
 * Configuration for pdwTools
 */
export interface PDWToolsConfig {
  /**
   * User identifier for memory isolation
   */
  userId: string;

  /**
   * PDW Vector Store configuration
   */
  pdwConfig: PDWVectorStoreConfig;

  /**
   * Embedding model from AI SDK (e.g., google.textEmbeddingModel())
   * If not provided, tools that require embeddings will throw errors
   *
   * @example
   * ```typescript
   * import { google } from '@ai-sdk/google';
   *
   * const embedModel = google.textEmbeddingModel('text-embedding-004');
   * ```
   */
  embedModel?: EmbeddingModel<string>;

  /**
   * Which tools to enable
   * @default ['search_memory', 'save_memory', 'list_memories']
   */
  enabledTools?: Array<'search_memory' | 'save_memory' | 'list_memories'> | 'all';

  /**
   * Custom tool descriptions for better AI understanding
   */
  customDescriptions?: {
    search_memory?: string;
    save_memory?: string;
    list_memories?: string;
  };
}

/**
 * Internal state manager for PDW tools
 */
class PDWToolsManager {
  private store: PDWVectorStore;
  private embedModel?: EmbeddingModel<string>;
  private userId: string;
  private config: PDWToolsConfig;
  private initialized: boolean = false;
  private initPromise: Promise<void> | null = null;

  constructor(config: PDWToolsConfig) {
    this.config = config;
    this.userId = config.userId;
    this.embedModel = config.embedModel;

    // Initialize PDW Vector Store
    this.store = new PDWVectorStore(config.pdwConfig);

    // Start async initialization
    this.initPromise = this.initialize();
  }

  /**
   * Initialize the tools (wait for store to be ready)
   */
  private async initialize(): Promise<void> {
    if (this.initialized) return;

    // Store initialization happens in its constructor
    // Just wait a bit for it to complete
    await new Promise(resolve => setTimeout(resolve, 100));

    this.initialized = true;
  }

  /**
   * Ensure tools are initialized before use
   */
  private async ensureInitialized(): Promise<void> {
    if (this.initPromise) {
      await this.initPromise;
    }
  }

  /**
   * Generate embedding for text using configured embed model
   */
  private async generateEmbedding(text: string): Promise<number[]> {
    if (!this.embedModel) {
      throw new Error(
        'Embedding model not configured. Please provide embedModel in pdwTools config.\n' +
        'Example: import { google } from "@ai-sdk/google"; const embedModel = google.textEmbeddingModel("text-embedding-004");'
      );
    }

    // Use AI SDK v5 embed function
    const result = await embed({
      model: this.embedModel,
      value: text
    });

    if (!result.embedding || result.embedding.length === 0) {
      throw new Error('Failed to generate embedding');
    }

    return result.embedding;
  }

  /**
   * Search memories by semantic similarity
   */
  async searchMemory(params: {
    query: string;
    limit?: number;
    minScore?: number;
    category?: string;
    startDate?: string;
    endDate?: string;
  }) {
    await this.ensureInitialized();

    try {
      const { query, limit = 5, minScore = 0.7, category, startDate, endDate } = params;

      // Generate query embedding
      const queryEmbedding = await this.generateEmbedding(query);

      // Build filters
      const filters: any = {};
      if (category) filters.category = category;
      // Time filters would be handled by metadata filtering
      // For now, we'll keep it simple

      // Search PDW
      const results = await this.store.search({
        vector: queryEmbedding,
        limit,
        minScore,
        filters,
        includeContent: true
      });

      if (results.length === 0) {
        return {
          found: false,
          message: `No memories found matching "${query}"`
        };
      }

      return {
        found: true,
        count: results.length,
        memories: results.map(r => ({
          id: r.id,
          text: r.text,
          score: r.score,
          category: r.metadata?.category || 'general',
          importance: r.metadata?.importance || 5,
          blobId: r.blobId
        }))
      };
    } catch (error) {
      console.error('search_memory error:', error);
      return {
        error: true,
        message: error instanceof Error ? error.message : 'Failed to search memories'
      };
    }
  }

  /**
   * Save new memory with automatic categorization
   */
  async saveMemory(params: {
    text: string;
    category?: 'fact' | 'preference' | 'todo' | 'note' | 'general';
    importance?: number;
  }) {
    await this.ensureInitialized();

    try {
      const { text, category = 'general', importance = 5 } = params;

      // Validate importance
      if (importance < 1 || importance > 10) {
        return {
          error: true,
          message: 'Importance must be between 1 and 10'
        };
      }

      // Generate embedding
      const embedding = await this.generateEmbedding(text);

      // Generate unique ID
      const id = `mem_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

      // Save to PDW
      const result = await this.store.add({
        id,
        vector: embedding,
        text,
        category,
        importance,
        metadata: {
          userId: this.userId,
          savedAt: new Date().toISOString(),
          category,
          importance
        }
      });

      return {
        success: true,
        memoryId: id,
        blobId: result.blobId,
        message: `Saved to memory: "${text.substring(0, 50)}${text.length > 50 ? '...' : ''}"`
      };
    } catch (error) {
      console.error('save_memory error:', error);
      return {
        error: true,
        message: error instanceof Error ? error.message : 'Failed to save memory'
      };
    }
  }

  /**
   * List recent memories
   */
  async listMemories(params: {
    limit?: number;
    category?: string;
  }) {
    await this.ensureInitialized();

    try {
      const { limit = 10, category } = params;

      // Get store stats
      const stats = await this.store.stats();

      return {
        success: true,
        totalMemories: stats.totalVectors,
        message: `You have ${stats.totalVectors} stored memories` +
                 (category ? ` in category "${category}"` : ''),
        stats: {
          totalVectors: stats.totalVectors,
          dimensions: stats.index.dimensions,
          distanceMetric: stats.index.distanceMetric
        }
      };
    } catch (error) {
      console.error('list_memories error:', error);
      return {
        error: true,
        message: error instanceof Error ? error.message : 'Failed to list memories'
      };
    }
  }
}

/**
 * Create PDW tools for AI SDK
 *
 * Returns a tools object that can be passed directly to generateText() or streamText().
 *
 * @param config - PDW tools configuration
 * @returns Tools object compatible with AI SDK
 *
 * @example
 * ```typescript
 * import { generateText } from 'ai';
 * import { google } from '@ai-sdk/google';
 * import { pdwTools } from 'personal-data-wallet-sdk/ai-sdk';
 *
 * // Create embedding model
 * const embedModel = google.textEmbeddingModel('text-embedding-004');
 *
 * // Create tools
 * const tools = pdwTools({
 *   userId: 'user-123',
 *   embedModel,
 *   pdwConfig: {
 *     walrus: { aggregator: process.env.WALRUS_AGGREGATOR! },
 *     sui: { network: 'testnet', packageId: process.env.PACKAGE_ID! },
 *     signer: keypair,
 *     userAddress: keypair.toSuiAddress(),
 *     dimensions: 3072 // Gemini text-embedding-004 dimensions
 *   }
 * });
 *
 * // Use with AI
 * const result = await generateText({
 *   model: google('gemini-2.0-flash-exp'),
 *   tools,
 *   prompt: "Remember that I love TypeScript and use it daily"
 * });
 * ```
 */
export function pdwTools(config: PDWToolsConfig) {
  const manager = new PDWToolsManager(config);

  // Determine which tools to enable
  const enabledTools = config.enabledTools === 'all'
    ? ['search_memory', 'save_memory', 'list_memories']
    : (config.enabledTools || ['search_memory', 'save_memory', 'list_memories']);

  const tools: Record<string, any> = {};

  // Tool 1: search_memory
  if (enabledTools.includes('search_memory')) {
    tools.search_memory = tool({
      description: config.customDescriptions?.search_memory ||
        `Search through the user's personal memories using semantic similarity. ` +
        `Use this when the user asks about past conversations, stored facts, or wants to recall information. ` +
        `Examples: "What did I say about...", "Do you remember when...", "What do I know about..."`,

      inputSchema: z.object({
        query: z.string().describe('The search query text to find relevant memories'),
        limit: z.number().optional().describe('Maximum number of results to return (default: 5)'),
        minScore: z.number().optional().describe('Minimum similarity score 0-1 (default: 0.7)'),
        category: z.enum(['fact', 'preference', 'todo', 'note', 'general']).optional()
          .describe('Filter by memory category'),
        startDate: z.string().optional().describe('Filter memories from this date (ISO format)'),
        endDate: z.string().optional().describe('Filter memories until this date (ISO format)')
      }),

      execute: async ({ query, limit, minScore, category, startDate, endDate }) =>
        manager.searchMemory({ query, limit, minScore, category, startDate, endDate })
    });
  }

  // Tool 2: save_memory
  if (enabledTools.includes('save_memory')) {
    tools.save_memory = tool({
      description: config.customDescriptions?.save_memory ||
        `Save important information to the user's personal memory. ` +
        `Use this when the user shares important facts, preferences, or information they want to remember. ` +
        `Examples: "Remember that...", "Save this...", "I prefer...", "My favorite is..."`,

      inputSchema: z.object({
        text: z.string().describe('The text content to save to memory'),
        category: z.enum(['fact', 'preference', 'todo', 'note', 'general']).optional()
          .describe('Category of the memory (default: general)'),
        importance: z.number().min(1).max(10).optional()
          .describe('Importance level 1-10 (default: 5)')
      }),

      execute: async ({ text, category, importance }) =>
        manager.saveMemory({ text, category, importance })
    });
  }

  // Tool 3: list_memories
  if (enabledTools.includes('list_memories')) {
    tools.list_memories = tool({
      description: config.customDescriptions?.list_memories ||
        `Get information about stored memories. ` +
        `Use when the user asks "what do you know about me", "what have I told you", or wants a memory summary.`,

      inputSchema: z.object({
        limit: z.number().optional().describe('Number of memories to list (default: 10)'),
        category: z.enum(['fact', 'preference', 'todo', 'note', 'general']).optional()
          .describe('Filter by category')
      }),

      execute: async ({ limit, category }) =>
        manager.listMemories({ limit, category })
    });
  }

  return tools;
}

/**
 * Type helper for extracting tool results
 */
export type PDWToolResult = {
  search_memory: {
    found: boolean;
    message: string;
    count?: number;
    memories?: Array<{
      id: string;
      text: string;
      score: number;
      category: string;
      importance: number;
      blobId: string;
    }>;
    error?: boolean;
  };
  save_memory: {
    success: boolean;
    memoryId: string;
    blobId: string;
    message: string;
  } | {
    error: boolean;
    message: string;
  };
  list_memories: {
    success: boolean;
    totalMemories: number;
    message: string;
    stats: {
      totalVectors: number;
      dimensions: number;
      distanceMetric: string;
    };
  } | {
    error: boolean;
    message: string;
  };
};
