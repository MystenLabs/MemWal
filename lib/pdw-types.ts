/**
 * Types for Personal Data Wallet SDK integration
 */

export interface PDWMemory {
  id: string; // On-chain object ID
  content: string;
  blobId: string; // Walrus blob ID
  category?: string;
  importance?: number;
  createdAt: number;
  vector?: Float32Array; // Embedding vector
  metadata?: Record<string, any>;
}

export interface PDWSearchResult {
  memory: PDWMemory;
  score: number; // Similarity score (0-1)
  distance: number;
}

export interface PDWClassification {
  category: string; // e.g., 'fact', 'preference', 'personal_info'
  importance: number; // 0-10
  topic?: string;
  summary?: string;
  shouldSave: boolean;
}

export interface PDWKnowledgeGraph {
  entities: PDWEntity[];
  relationships: PDWRelationship[];
}

export interface PDWEntity {
  id: string;
  name: string;
  type: string; // e.g., 'person', 'company', 'location'
  metadata?: Record<string, any>;
}

export interface PDWRelationship {
  source: string; // Entity ID
  target: string; // Entity ID
  type: string; // e.g., 'works_at', 'lives_in', 'likes'
  metadata?: Record<string, any>;
}

export interface CreateMemoryOptions {
  category?: string;
  importance?: number;
  metadata?: Record<string, any>;
}

export interface SearchMemoryOptions {
  limit?: number;
  category?: string;
  minScore?: number;
}
