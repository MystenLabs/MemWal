/**
 * BrowserKnowledgeGraphManager - Client-Side Knowledge Graph with IndexedDB
 *
 * Browser-compatible knowledge graph manager with IndexedDB persistence.
 * Provides entity and relationship management for memory organization.
 *
 * Features:
 * - IndexedDB persistence (survives page refresh)
 * - Fast graph queries and traversal
 * - Entity-relationship mapping
 * - Memory-graph integration
 * - Zero backend dependencies
 */

import type {
  KnowledgeGraph,
  Entity,
  Relationship,
  GraphExtractionResult
} from './GraphService';
import type { ProcessedMemory } from '../embedding/types';

export interface GraphMemoryMapping {
  memoryId: string;
  entityIds: string[];
  relationshipIds: string[];
  extractionDate: Date;
  confidence: number;
}

export interface GraphUpdateResult {
  success: boolean;
  entitiesAdded: number;
  relationshipsAdded: number;
  entitiesUpdated: number;
  relationshipsUpdated: number;
  processingTimeMs: number;
  extractionResult?: GraphExtractionResult;
  error?: string;
}

export interface GraphSearchQuery {
  keywords?: string[];
  entityTypes?: string[];
  relationshipTypes?: string[];
  memoryIds?: string[];
  dateRange?: {
    start: Date;
    end: Date;
  };
  similarToMemory?: string;
  maxResults?: number;
}

export interface GraphSearchResult {
  entities: Entity[];
  relationships: Relationship[];
  relatedMemories: string[];
  searchPaths?: Array<{
    score: number;
    entities: string[];
    relationships: string[];
  }>;
  totalResults: number;
  queryTimeMs: number;
}

/**
 * Browser-compatible knowledge graph manager with IndexedDB persistence
 */
export class BrowserKnowledgeGraphManager {
  private db?: IDBDatabase;
  private memoryMappings = new Map<string, GraphMemoryMapping[]>();
  private graphCache = new Map<string, { graph: KnowledgeGraph; lastUpdated: Date }>();

  constructor() {
    this.initializeIndexedDB();
  }

  /**
   * Initialize IndexedDB for graph persistence
   */
  private async initializeIndexedDB(): Promise<void> {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open('KnowledgeGraphDB', 1);

      request.onerror = () => reject(new Error('Failed to open IndexedDB'));

      request.onsuccess = () => {
        this.db = request.result;
        console.log('✅ IndexedDB initialized for knowledge graphs');
        resolve();
      };

      request.onupgradeneeded = (event) => {
        const db = (event.target as IDBOpenDBRequest).result;

        // Graphs store
        if (!db.objectStoreNames.contains('graphs')) {
          const graphsStore = db.createObjectStore('graphs', { keyPath: 'userId' });
          graphsStore.createIndex('lastUpdated', 'lastUpdated', { unique: false });
        }

        // Entities store
        if (!db.objectStoreNames.contains('entities')) {
          const entitiesStore = db.createObjectStore('entities', { keyPath: ['userId', 'entityId'] });
          entitiesStore.createIndex('userId', 'userId', { unique: false });
          entitiesStore.createIndex('type', 'type', { unique: false });
        }

        // Relationships store
        if (!db.objectStoreNames.contains('relationships')) {
          const relsStore = db.createObjectStore('relationships', { keyPath: ['userId', 'source', 'target'] });
          relsStore.createIndex('userId', 'userId', { unique: false });
          relsStore.createIndex('source', 'source', { unique: false });
          relsStore.createIndex('target', 'target', { unique: false });
        }

        // Memory mappings store
        if (!db.objectStoreNames.contains('memoryMappings')) {
          const mappingsStore = db.createObjectStore('memoryMappings', { keyPath: ['userId', 'memoryId'] });
          mappingsStore.createIndex('userId', 'userId', { unique: false });
        }
      };
    });
  }

  /**
   * Get user's knowledge graph from IndexedDB
   */
  async getUserGraph(userId: string): Promise<KnowledgeGraph | null> {
    try {
      // Check cache first
      const cached = this.graphCache.get(userId);
      if (cached) {
        return cached.graph;
      }

      if (!this.db) {
        await this.initializeIndexedDB();
      }

      // Load from IndexedDB
      const graph = await this.loadGraphFromDB(userId);
      if (graph) {
        this.graphCache.set(userId, { graph, lastUpdated: new Date() });
        return graph;
      }

      return null;
    } catch (error) {
      console.error('Error getting user graph:', error);
      return null;
    }
  }

  /**
   * Update user's knowledge graph
   */
  async updateUserGraph(userId: string, graph: KnowledgeGraph): Promise<void> {
    try {
      // Update cache
      this.graphCache.set(userId, { graph, lastUpdated: new Date() });

      // Save to IndexedDB
      await this.saveGraphToDB(userId, graph);
    } catch (error) {
      console.error('Error updating user graph:', error);
      throw error;
    }
  }

  /**
   * Add entities and relationships to graph
   */
  async addToGraph(
    userId: string,
    entities: Entity[],
    relationships: Relationship[],
    memoryId: string
  ): Promise<void> {
    try {
      // Get or create graph
      let graph = await this.getUserGraph(userId);
      if (!graph) {
        graph = this.createEmptyGraph(userId);
      }

      // Add entities
      for (const entity of entities) {
        const existing = graph.entities.find(e => e.id === entity.id);
        if (!existing) {
          graph.entities.push({
            ...entity,
            sourceMemoryIds: [memoryId],
            createdAt: new Date()
          });
        } else {
          // Update existing entity
          if (!existing.sourceMemoryIds) {
            existing.sourceMemoryIds = [];
          }
          if (!existing.sourceMemoryIds.includes(memoryId)) {
            existing.sourceMemoryIds.push(memoryId);
          }
        }
      }

      // Add relationships
      for (const relationship of relationships) {
        const existing = graph.relationships.find(
          r => r.source === relationship.source && r.target === relationship.target && r.label === relationship.label
        );
        if (!existing) {
          graph.relationships.push({
            ...relationship,
            sourceMemoryIds: [memoryId],
            createdAt: new Date()
          });
        } else {
          // Update existing relationship
          if (!existing.sourceMemoryIds) {
            existing.sourceMemoryIds = [];
          }
          if (!existing.sourceMemoryIds.includes(memoryId)) {
            existing.sourceMemoryIds.push(memoryId);
          }
        }
      }

      // Update metadata
      if (!graph.metadata.sourceMemories) {
        graph.metadata.sourceMemories = [];
      }
      if (!graph.metadata.sourceMemories.includes(memoryId)) {
        graph.metadata.sourceMemories.push(memoryId);
      }
      graph.metadata.lastUpdated = new Date();

      // Save updated graph
      await this.updateUserGraph(userId, graph);

      console.log(`✅ Added ${entities.length} entities and ${relationships.length} relationships to graph for user ${userId}`);
    } catch (error) {
      console.error('Error adding to graph:', error);
      throw error;
    }
  }

  /**
   * Search graph with complex queries
   */
  async searchGraph(
    userId: string,
    query: GraphSearchQuery
  ): Promise<GraphSearchResult> {
    const startTime = Date.now();

    try {
      const graph = await this.getUserGraph(userId);
      if (!graph) {
        return {
          entities: [],
          relationships: [],
          relatedMemories: [],
          totalResults: 0,
          queryTimeMs: Date.now() - startTime
        };
      }

      let entities = graph.entities;
      let relationships = graph.relationships;

      // Filter by entity types
      if (query.entityTypes && query.entityTypes.length > 0) {
        entities = entities.filter(e => query.entityTypes!.includes(e.type));
      }

      // Filter by relationship types
      if (query.relationshipTypes && query.relationshipTypes.length > 0) {
        relationships = relationships.filter(r =>
          query.relationshipTypes!.includes(r.type || r.label)
        );
      }

      // Keyword search
      if (query.keywords && query.keywords.length > 0) {
        const keywords = query.keywords.map(k => k.toLowerCase());

        entities = entities.filter(e =>
          keywords.some(keyword =>
            e.label.toLowerCase().includes(keyword) ||
            JSON.stringify(e.properties || {}).toLowerCase().includes(keyword)
          )
        );

        relationships = relationships.filter(r =>
          keywords.some(keyword =>
            r.label.toLowerCase().includes(keyword) ||
            JSON.stringify(r.properties || {}).toLowerCase().includes(keyword)
          )
        );
      }

      // Filter by memory IDs
      if (query.memoryIds && query.memoryIds.length > 0) {
        entities = entities.filter(e =>
          e.sourceMemoryIds &&
          e.sourceMemoryIds.some(memId => query.memoryIds!.includes(memId))
        );

        relationships = relationships.filter(r =>
          r.sourceMemoryIds &&
          r.sourceMemoryIds.some(memId => query.memoryIds!.includes(memId))
        );
      }

      // Apply result limit
      if (query.maxResults) {
        entities = entities.slice(0, Math.floor(query.maxResults / 2));
        relationships = relationships.slice(0, Math.floor(query.maxResults / 2));
      }

      // Collect related memories
      const relatedMemories = new Set<string>();
      entities.forEach(e => e.sourceMemoryIds?.forEach(id => relatedMemories.add(id)));
      relationships.forEach(r => r.sourceMemoryIds?.forEach(id => relatedMemories.add(id)));

      return {
        entities,
        relationships,
        relatedMemories: Array.from(relatedMemories),
        totalResults: entities.length + relationships.length,
        queryTimeMs: Date.now() - startTime
      };
    } catch (error) {
      console.error('Error searching graph:', error);

      return {
        entities: [],
        relationships: [],
        relatedMemories: [],
        totalResults: 0,
        queryTimeMs: Date.now() - startTime
      };
    }
  }

  /**
   * Find entities related to a specific entity
   */
  async findRelatedEntities(
    userId: string,
    entityId: string,
    maxHops: number = 2
  ): Promise<Entity[]> {
    try {
      const graph = await this.getUserGraph(userId);
      if (!graph) {
        return [];
      }

      const relatedEntities = new Set<string>();
      const toExplore = [{ id: entityId, hops: 0 }];
      const explored = new Set<string>();

      while (toExplore.length > 0) {
        const current = toExplore.shift()!;
        if (explored.has(current.id) || current.hops >= maxHops) {
          continue;
        }

        explored.add(current.id);
        relatedEntities.add(current.id);

        // Find connected entities through relationships
        for (const rel of graph.relationships) {
          if (rel.source === current.id && !explored.has(rel.target)) {
            toExplore.push({ id: rel.target, hops: current.hops + 1 });
          }
          if (rel.target === current.id && !explored.has(rel.source)) {
            toExplore.push({ id: rel.source, hops: current.hops + 1 });
          }
        }
      }

      return graph.entities.filter(e => relatedEntities.has(e.id));
    } catch (error) {
      console.error('Error finding related entities:', error);
      return [];
    }
  }

  /**
   * Clear user's knowledge graph
   */
  async clearUserGraph(userId: string): Promise<void> {
    try {
      this.graphCache.delete(userId);
      this.memoryMappings.delete(userId);

      if (!this.db) {
        await this.initializeIndexedDB();
      }

      // Delete from IndexedDB
      const transaction = this.db!.transaction(['graphs', 'entities', 'relationships', 'memoryMappings'], 'readwrite');

      const graphsStore = transaction.objectStore('graphs');
      const entitiesStore = transaction.objectStore('entities');
      const relationshipsStore = transaction.objectStore('relationships');
      const mappingsStore = transaction.objectStore('memoryMappings');

      graphsStore.delete(userId);

      // Delete all entities for this user
      const entitiesIndex = entitiesStore.index('userId');
      const entitiesRequest = entitiesIndex.openCursor(IDBKeyRange.only(userId));
      entitiesRequest.onsuccess = (event) => {
        const cursor = (event.target as IDBRequest).result;
        if (cursor) {
          cursor.delete();
          cursor.continue();
        }
      };

      // Delete all relationships for this user
      const relsIndex = relationshipsStore.index('userId');
      const relsRequest = relsIndex.openCursor(IDBKeyRange.only(userId));
      relsRequest.onsuccess = (event) => {
        const cursor = (event.target as IDBRequest).result;
        if (cursor) {
          cursor.delete();
          cursor.continue();
        }
      };

      // Delete all mappings for this user
      const mappingsIndex = mappingsStore.index('userId');
      const mappingsRequest = mappingsIndex.openCursor(IDBKeyRange.only(userId));
      mappingsRequest.onsuccess = (event) => {
        const cursor = (event.target as IDBRequest).result;
        if (cursor) {
          cursor.delete();
          cursor.continue();
        }
      };

      console.log(`✅ Cleared knowledge graph for user ${userId}`);
    } catch (error) {
      console.error('Error clearing user graph:', error);
      throw error;
    }
  }

  /**
   * Cleanup resources
   */
  destroy(): void {
    this.graphCache.clear();
    this.memoryMappings.clear();

    if (this.db) {
      this.db.close();
    }
  }

  // ==================== PRIVATE METHODS ====================

  private createEmptyGraph(userId: string): KnowledgeGraph {
    return {
      entities: [],
      relationships: [],
      metadata: {
        version: '1.0',
        createdAt: new Date(),
        lastUpdated: new Date(),
        totalEntities: 0,
        totalRelationships: 0,
        sourceMemories: []
      }
    };
  }

  private async loadGraphFromDB(userId: string): Promise<KnowledgeGraph | null> {
    if (!this.db) {
      await this.initializeIndexedDB();
    }

    return new Promise((resolve, reject) => {
      const transaction = this.db!.transaction(['graphs'], 'readonly');
      const store = transaction.objectStore('graphs');
      const request = store.get(userId);

      request.onsuccess = () => {
        const result = request.result;
        if (!result) {
          resolve(null);
          return;
        }

        const entities = result.entities || [];
        const relationships = result.relationships || [];

        resolve({
          entities,
          relationships,
          metadata: result.metadata || {
            version: result.version || '1.0',
            createdAt: new Date(result.createdAt || Date.now()),
            lastUpdated: new Date(result.lastUpdated || Date.now()),
            totalEntities: entities.length,
            totalRelationships: relationships.length,
            sourceMemories: result.sourceMemories || []
          }
        });
      };

      request.onerror = () => reject(new Error('Failed to load graph from IndexedDB'));
    });
  }

  private async saveGraphToDB(userId: string, graph: KnowledgeGraph): Promise<void> {
    if (!this.db) {
      await this.initializeIndexedDB();
    }

    return new Promise((resolve, reject) => {
      const transaction = this.db!.transaction(['graphs'], 'readwrite');
      const store = transaction.objectStore('graphs');

      const data = {
        userId,
        entities: graph.entities,
        relationships: graph.relationships,
        metadata: graph.metadata,
        lastUpdated: Date.now()
      };

      const request = store.put(data);

      request.onsuccess = () => {
        console.log(`✅ Graph saved to IndexedDB for user ${userId}`);
        resolve();
      };

      request.onerror = () => reject(new Error('Failed to save graph to IndexedDB'));
    });
  }
}

export default BrowserKnowledgeGraphManager;
