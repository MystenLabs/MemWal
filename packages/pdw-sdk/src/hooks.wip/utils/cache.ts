/**
 * React Query cache keys for memory operations
 */

export const cacheKeys = {
  // Memory manager instance
  memoryManager: (address?: string) => ['memoryManager', address] as const,

  // Memory search queries
  searchMemories: (address?: string, query?: string) =>
    ['searchMemories', address, query] as const,

  // Wallet memories
  walletMemories: (address?: string) => ['walletMemories', address] as const,
  walletMemoriesWithFilters: (address?: string, filters?: any) =>
    ['walletMemories', address, filters] as const,

  // Individual memory
  memory: (blobId: string) => ['memory', blobId] as const,

  // Memory metadata
  memoryMetadata: (blobId: string) => ['memoryMetadata', blobId] as const,

  // Chat history
  chatHistory: (sessionId: string) => ['chatHistory', sessionId] as const,

  // Memory stats
  memoryStats: (address?: string) => ['memoryStats', address] as const,
} as const;

/**
 * Default stale times for different query types (in milliseconds)
 */
export const defaultStaleTimes = {
  // Memory manager is stable once created
  memoryManager: Infinity,

  // Search results can be cached for 5 minutes
  searchMemories: 5 * 60 * 1000,

  // Wallet memories should be fresh (1 minute cache)
  walletMemories: 60 * 1000,

  // Individual memory content can be cached longer (10 minutes)
  memory: 10 * 60 * 1000,

  // Chat history is session-specific
  chatHistory: Infinity,

  // Stats should be relatively fresh
  memoryStats: 30 * 1000,
} as const;
