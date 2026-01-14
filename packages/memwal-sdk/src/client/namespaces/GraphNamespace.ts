/**
 * Graph Namespace - Knowledge Graph Operations
 *
 * Provides knowledge graph extraction and querying:
 * - Extract entities and relationships from text
 * - Query entities
 * - Traverse relationship graphs
 * - Get statistics
 *
 * @module client/namespaces
 */

import type { ServiceContainer } from '../SimplePDWClient';

/**
 * Entity in knowledge graph
 */
export interface Entity {
  id: string;
  name: string;
  type: string;
  confidence: number;
  metadata?: Record<string, any>;
}

/**
 * Relationship between entities
 */
export interface Relationship {
  id: string;
  source: string;
  target: string;
  type: string;
  confidence: number;
  metadata?: Record<string, any>;
}

/**
 * Knowledge graph structure
 */
export interface KnowledgeGraph {
  entities: Entity[];
  relationships: Relationship[];
  confidence: number;
}

/**
 * Graph query result
 */
export interface GraphQueryResult {
  entity: Entity;
  relationships: Relationship[];
  connectedEntities: Entity[];
}

/**
 * Graph path (for traversal)
 */
export interface GraphPath {
  nodes: Entity[];
  edges: Relationship[];
  totalConfidence: number;
}

/**
 * Graph statistics
 */
export interface GraphStats {
  totalEntities: number;
  totalRelationships: number;
  entityTypes: Record<string, number>;
  relationshipTypes: Record<string, number>;
  avgConfidence: number;
}

/**
 * Entity filter
 */
export interface EntityFilter {
  type?: string;
  minConfidence?: number;
  limit?: number;
}

/**
 * Relationship filter
 */
export interface RelationshipFilter {
  type?: string;
  sourceId?: string;
  targetId?: string;
  minConfidence?: number;
  limit?: number;
}

/**
 * Traverse options
 */
export interface TraverseOptions {
  maxDepth?: number;
  relationshipTypes?: string[];
  minConfidence?: number;
}

/**
 * Graph Namespace
 *
 * Handles knowledge graph operations
 */
export class GraphNamespace {
  constructor(private services: ServiceContainer) {}

  /**
   * Extract knowledge graph from text
   *
   * Uses AI to extract entities and relationships.
   *
   * @param content - Text content to analyze
   * @returns Extracted knowledge graph
   *
   * @example
   * ```typescript
   * const graph = await pdw.graph.extract('Alice works at Google in California');
   * // Returns: {
   * //   entities: [
   * //     { id: '1', name: 'Alice', type: 'PERSON', confidence: 0.95 },
   * //     { id: '2', name: 'Google', type: 'ORG', confidence: 0.98 },
   * //     { id: '3', name: 'California', type: 'LOCATION', confidence: 0.92 }
   * //   ],
   * //   relationships: [
   * //     { source: '1', target: '2', type: 'WORKS_AT', confidence: 0.90 }
   * //   ]
   * // }
   * ```
   */
  async extract(content: string): Promise<KnowledgeGraph> {
    try {
      const result = await this.services.storage.extractKnowledgeGraph(
        content,
        '', // blobId (optional for extraction only)
        { confidenceThreshold: 0.6 }
      );

      return {
        entities: result.entities.map((e: any) => ({
          id: e.id,
          name: e.label || e.label,
          type: e.type,
          confidence: e.confidence || 0
        })),
        relationships: result.relationships.map((r: any) => ({
          id: `${r.source}-${r.target}`,
          source: r.source,
          target: r.target,
          type: r.type || 'related',
          confidence: r.confidence || 0
        })),
        confidence: result.confidence || 0
      };
    } catch (error) {
      throw new Error(`Graph extraction failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * Query graph for a specific entity
   *
   * Gets entity and its relationships.
   *
   * @param entityId - Entity ID to query
   * @returns Entity with relationships and connected entities
   */
  async query(entityId: string): Promise<GraphQueryResult> {
    try {
      // Search by entity ID using searchText (StorageService doesn't have entityId param)
      const graphData = await this.services.storage.searchKnowledgeGraph(
        this.services.config.userAddress,
        { searchText: entityId, limit: 50 }
      );

      const entity = graphData.entities.find((e: any) => e.id === entityId);
      if (!entity) {
        throw new Error(`Entity ${entityId} not found`);
      }

      // Get relationships involving this entity
      const relationships = graphData.relationships.filter((r: any) =>
        r.source === entityId || r.target === entityId
      );

      // Get connected entity IDs
      const connectedIds = new Set<string>();
      relationships.forEach((r: any) => {
        if (r.source === entityId) connectedIds.add(r.target);
        if (r.target === entityId) connectedIds.add(r.source);
      });

      const connectedEntities = graphData.entities.filter((e: any) =>
        connectedIds.has(e.id)
      );

      return {
        entity: {
          id: entity.id,
          name: entity.label, // Entity has 'label' not 'name'
          type: entity.type,
          confidence: entity.confidence || 0
        },
        relationships: relationships.map((r: any) => ({
          id: `${r.source}-${r.target}`,
          source: r.source,
          target: r.target,
          type: r.type || 'related',
          confidence: r.confidence || 0
        })),
        connectedEntities: connectedEntities.map((e: any) => ({
          id: e.id,
          name: e.label || '',  // Entity has 'label' not 'name'
          type: e.type,
          confidence: e.confidence || 0
        }))
      };
    } catch (error) {
      throw new Error(`Graph query failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * Traverse graph from a starting entity
   *
   * Follows relationships to discover connected entities.
   *
   * @param startEntity - Entity ID to start from
   * @param options - Traversal options
   * @returns Array of paths through the graph
   */
  async traverse(
    startEntity: string,
    options: TraverseOptions = {}
  ): Promise<GraphPath[]> {
    try {
      const { maxDepth = 3, relationshipTypes, minConfidence = 0.5 } = options;

      // Get graph data
      const graphData = await this.services.storage.searchKnowledgeGraph(
        this.services.config.userAddress,
        { searchText: startEntity, limit: 100 }
      );

      const paths: GraphPath[] = [];
      const visited = new Set<string>();

      // BFS traversal
      const queue: Array<{
        currentEntity: string;
        path: Entity[];
        edges: Relationship[];
        depth: number;
      }> = [{
        currentEntity: startEntity,
        path: [],
        edges: [],
        depth: 0
      }];

      while (queue.length > 0 && paths.length < 20) {
        const { currentEntity, path, edges, depth } = queue.shift()!;

        if (depth >= maxDepth || visited.has(currentEntity)) {
          if (path.length > 0) {
            const totalConfidence = edges.reduce((sum, e) => sum + e.confidence, 0) / edges.length;
            paths.push({ nodes: path, edges, totalConfidence });
          }
          continue;
        }

        visited.add(currentEntity);

        // Find entity
        const entity = graphData.entities.find((e: any) => e.id === currentEntity);
        if (!entity) continue;

        const entityObj: Entity = {
          id: entity.id,
          name: entity.label || '',  // Entity only has 'label'
          type: entity.type,
          confidence: entity.confidence || 0
        };

        // Find outgoing relationships
        const outgoing = graphData.relationships.filter((r: any) => {
          const matches = r.source === currentEntity;
          const typeMatch = !relationshipTypes || relationshipTypes.includes(r.type);
          const confMatch = (r.confidence || 0) >= minConfidence;
          return matches && typeMatch && confMatch;
        });

        // Add to queue
        outgoing.forEach((r: any) => {
          queue.push({
            currentEntity: r.target,
            path: [...path, entityObj],
            edges: [...edges, {
              id: `${r.source}-${r.target}`,
              source: r.source,
              target: r.target,
              type: r.type || 'related',
              confidence: r.confidence || 0
            }],
            depth: depth + 1
          });
        });
      }

      return paths.slice(0, 20); // Limit results
    } catch (error) {
      throw new Error(`Graph traversal failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * Get all entities matching filter
   *
   * @param filter - Entity filter options
   * @returns Array of entities
   */
  async getEntities(filter: EntityFilter = {}): Promise<Entity[]> {
    try {
      const graphData = await this.services.storage.searchKnowledgeGraph(
        this.services.config.userAddress,
        { limit: filter.limit || 100 }
      );

      let entities = graphData.entities;

      // Apply filters
      if (filter.type) {
        entities = entities.filter((e: any) => e.type === filter.type);
      }

      if (filter.minConfidence) {
        entities = entities.filter((e: any) => (e.confidence || 0) >= filter.minConfidence!);
      }

      return entities.map((e: any) => ({
        id: e.id,
        name: e.label,  // Entity only has 'label', not 'name'
        type: e.type,
        confidence: e.confidence || 0,
        metadata: e.metadata
      }));
    } catch (error) {
      throw new Error(`Get entities failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * Get all relationships matching filter
   *
   * @param filter - Relationship filter options
   * @returns Array of relationships
   */
  async getRelationships(filter: RelationshipFilter = {}): Promise<Relationship[]> {
    try {
      const graphData = await this.services.storage.searchKnowledgeGraph(
        this.services.config.userAddress,
        {
          searchText: filter.sourceId || filter.targetId || '',
          limit: filter.limit || 100
        }
      );

      let relationships = graphData.relationships;

      // Apply filters
      if (filter.type) {
        relationships = relationships.filter((r: any) => r.type === filter.type);
      }

      if (filter.sourceId) {
        relationships = relationships.filter((r: any) => r.source === filter.sourceId);
      }

      if (filter.targetId) {
        relationships = relationships.filter((r: any) => r.target === filter.targetId);
      }

      if (filter.minConfidence) {
        relationships = relationships.filter((r: any) =>
          (r.confidence || 0) >= filter.minConfidence!
        );
      }

      return relationships.map((r: any) => ({
        id: `${r.source}-${r.target}`,
        source: r.source,
        target: r.target,
        type: r.type || 'related',
        confidence: r.confidence || 0,
        metadata: r.metadata
      }));
    } catch (error) {
      throw new Error(`Get relationships failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * Get knowledge graph statistics
   *
   * Calculates average confidence from entity and relationship confidence scores.
   *
   * @returns Graph statistics
   */
  async stats(): Promise<GraphStats> {
    try {
      const stats = await this.services.storage.getGraphStatistics(
        this.services.config.userAddress
      );

      // Calculate average confidence from graph entities and relationships
      let avgConfidence = 0;

      if (stats.totalEntities > 0 || stats.totalRelationships > 0) {
        // Get graph data to calculate average confidence
        try {
          const graphData = await this.services.storage.searchKnowledgeGraph(
            this.services.config.userAddress,
            { limit: 1000 }
          );

          const confidences: number[] = [];

          // Collect entity confidences
          for (const entity of graphData.entities || []) {
            if (typeof entity.confidence === 'number') {
              confidences.push(entity.confidence);
            }
          }

          // Collect relationship confidences
          for (const rel of graphData.relationships || []) {
            if (typeof rel.confidence === 'number') {
              confidences.push(rel.confidence);
            }
          }

          // Calculate average
          if (confidences.length > 0) {
            avgConfidence = confidences.reduce((sum, c) => sum + c, 0) / confidences.length;
          }
        } catch {
          // If we can't get graph data for confidence calculation, use 0
          avgConfidence = 0;
        }
      }

      return {
        totalEntities: stats.totalEntities,
        totalRelationships: stats.totalRelationships,
        entityTypes: stats.entityTypes,
        relationshipTypes: stats.relationshipTypes,
        avgConfidence
      };
    } catch (error) {
      throw new Error(`Get graph stats failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}
