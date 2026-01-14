/**
 * Memory Retrieval Module
 * 
 * Unified memory retrieval, search, analytics, and decryption capabilities
 */

export { MemoryRetrievalService } from './MemoryRetrievalService';
export { AdvancedSearchService } from './AdvancedSearchService';
export { MemoryAnalyticsService } from './MemoryAnalyticsService';
export { MemoryDecryptionPipeline } from './MemoryDecryptionPipeline';

export type {
  UnifiedMemoryQuery,
  UnifiedMemoryResult,
  RetrievalStats,
  RetrievalContext
} from './MemoryRetrievalService';

export type {
  KeyServerConfig,
  DecryptionConfig,
  DecryptionRequest,
  DecryptionResult,
  BatchDecryptionResult
} from './MemoryDecryptionPipeline';

export type {
  SearchFilter,
  SearchAggregation,
  SearchFacets,
  SemanticSearchQuery,
  TemporalSearchQuery,
  GraphSearchQuery,
  HybridSearchQuery
} from './AdvancedSearchService';

export type {
  MemoryAnalytics,
  UsagePattern,
  SimilarityCluster,
  TrendAnalysis,
  MemoryInsights
} from './MemoryAnalyticsService';