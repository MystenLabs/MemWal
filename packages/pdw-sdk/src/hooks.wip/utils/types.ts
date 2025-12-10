/**
 * Type definitions for React hooks
 */

import type { SuiClient } from '@mysten/sui/client';
import type { Transaction } from '@mysten/sui/transactions';

// Common types used across hooks
export interface Account {
  address: string;
}

export interface SignAndExecuteFunction {
  (
    params: { transaction: Transaction },
    callbacks: {
      onSuccess: (result: any) => void;
      onError: (error: Error) => void;
    }
  ): void;
}

export interface SignPersonalMessageFunction {
  (params: { message: Uint8Array }): Promise<{ signature: string }>;
}

// Memory Manager Config
export interface MemoryManagerConfig {
  packageId?: string;
  accessRegistryId?: string;
  walrusAggregator?: string;
  geminiApiKey?: string;
  sealServerObjectIds?: string[];
  walrusNetwork?: 'testnet' | 'mainnet';
  categories?: string[];
}

// Create Memory Types
export interface CreateMemoryInput {
  content: string;
  category?: string;
}

export interface CreateMemoryProgress {
  stage: 'analyzing' | 'embedding' | 'encrypting' | 'uploading' | 'registering' | 'success' | 'error';
  message: string;
}

export interface CreateMemoryResult {
  blobId: string;
  transactionDigest?: string;
}

// Batch Create Memory Types
export interface CreateMemoryBatchInput {
  memories: Array<{
    content: string;
    category?: string;
  }>;
}

export interface CreateMemoryBatchProgress {
  stage: 'preparing' | 'processing' | 'encrypting' | 'uploading' | 'success' | 'error';
  message: string;
  current: number;
  total: number;
  percent: number;
}

export interface CreateMemoryBatchResult {
  quiltId: string;
  files: Array<{ identifier: string; blobId: string }>;
  uploadTimeMs: number;
  memoriesCreated: number;
}

// Search Memory Types
export interface SearchMemoryOptions {
  k?: number;
  minSimilarity?: number;
  category?: string;
  dateRange?: {
    start: Date;
    end: Date;
  };
  enabled?: boolean;
  staleTime?: number;
}

export interface SearchMemoryResult {
  blobId: string;
  content: string;
  category?: string;
  topic?: string;              // Rich metadata: AI-extracted topic
  importance?: number;         // Rich metadata: Importance score (1-10)
  summary?: string;            // Rich metadata: AI-generated summary
  embeddingType?: string;      // Embedding type: 'metadata' or 'content'
  similarity: number;
  timestamp: Date;
  embedding?: number[];
}

// Wallet Memories Types
export interface MemoryFilters {
  category?: string;
  dateRange?: {
    start: Date;
    end: Date;
  };
  minImportance?: number;
}

export type SortOption = 'timestamp-asc' | 'timestamp-desc' | 'importance' | 'category';

export interface MemoryStats {
  total: number;
  byCategory: Record<string, number>;
  totalStorageBytes: number;
}

export interface WalletMemory {
  blobId: string;
  category: string;
  importance: number;
  contentLength: number;
  timestamp: Date;
  owner: string;
}

// Chat Types
export interface ChatMessage {
  role: 'user' | 'assistant' | 'system';
  content: string;
  timestamp: Date;
  memories?: SearchMemoryResult[];
}

export interface MemoryChatConfig {
  systemPrompt?: string;
  maxContextMemories?: number;
  aiProvider?: 'gemini' | 'openai' | 'anthropic';
  streamResponses?: boolean;
}

// Hook Return Types
export interface MutationState<TData = unknown, TError = Error> {
  data?: TData;
  error: TError | null;
  isLoading: boolean;
  isSuccess: boolean;
  isError: boolean;
}

export interface QueryState<TData = unknown, TError = Error> {
  data?: TData;
  error: TError | null;
  isLoading: boolean;
  isSuccess: boolean;
  isError: boolean;
  refetch: () => void;
}
