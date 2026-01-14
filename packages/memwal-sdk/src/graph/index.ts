/**
 * Knowledge Graph Module
 * 
 * AI-powered knowledge graph extraction and management for the PDW SDK.
 * Provides entity/relationship extraction, graph traversal, and intelligent queries.
 */

export { GraphService } from './GraphService';
export { KnowledgeGraphManager } from './KnowledgeGraphManager';

export type {
  Entity,
  Relationship,
  KnowledgeGraph,
  GraphExtractionResult,
  GraphQueryResult,
  GraphConfig
} from './GraphService';

export type {
  GraphMemoryMapping,
  GraphUpdateResult,
  GraphSearchQuery,
  GraphSearchResult,
  KnowledgeGraphStats
} from './KnowledgeGraphManager';