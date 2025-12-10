/**
 * ViewService - Read-only blockchain query methods
 * 
 * Provides methods for querying blockchain state without creating transactions.
 * Follows MystenLabs patterns for view/query operations.
 */

import type { SuiClient } from '@mysten/sui/client';
import type { PDWConfig, ClientWithCoreApi } from '../types';

// View query result types
export interface MemoryRecord {
  id: string;
  owner: string;
  category: string;
  vectorId: number;
  blobId: string;
  contentType: string;
  contentSize: number;
  contentHash: string;
  topic: string;
  importance: number;
  embeddingBlobId: string;
  createdAt: number;
  updatedAt: number;
}

export interface MemoryIndex {
  id: string;
  owner: string;
  version: number;
  indexBlobId: string;
  graphBlobId: string;
  memoryCount: number;
  lastUpdated: number;
}

export interface MemoryStats {
  totalMemories: number;
  categoryCounts: Record<string, number>;
  totalSize: number;
  averageImportance: number;
  lastActivityTime: number;
}

export interface AccessPermission {
  id: string;
  grantor: string;
  grantee: string;
  contentId: string;
  permissionType: string;
  expiresAt?: number;
  createdAt: number;
  isActive: boolean;
}

export interface ContentRegistry {
  id: string;
  owner: string;
  contentHash: string;
  encryptionInfo: string;
  accessCount: number;
  createdAt: number;
}

export class ViewService {
  private static readonly MAX_QUERY_LIMIT = 50;
  private client: SuiClient;
  private config: PDWConfig;

  constructor(client: ClientWithCoreApi, config: PDWConfig) {
    // Extract SuiClient from the core API wrapper
    this.client = (client as any).client || client;
    this.config = config;
  }

  // ==================== MEMORY QUERIES ====================

  /**
   * Get all memories owned by a user
   */
  async getUserMemories(userAddress: string, options?: {
    limit?: number;
    cursor?: string;
    category?: string;
  }): Promise<{
    data: MemoryRecord[];
    nextCursor?: string;
    hasMore: boolean;
  }> {
    try {
      const response = await this.client.getOwnedObjects({
        owner: userAddress,
        filter: {
          StructType: `${this.config.packageId}::memory::Memory`,
        },
        options: {
          showContent: true,
          showType: true,
        },
        limit: options?.limit || 50,
        cursor: options?.cursor,
      });

      const memories: MemoryRecord[] = [];
      
      for (const obj of response.data) {
        if (obj.data?.content && 'fields' in obj.data.content) {
          const fields = obj.data.content.fields as any;
          const metadata = fields.metadata?.fields || fields.metadata || {};

          // Filter by category if specified
          if (options?.category && fields.category !== options.category) {
            continue;
          }

          memories.push({
            id: obj.data.objectId,
            owner: fields.owner,
            category: fields.category,
            vectorId: parseInt(fields.vector_id),
            blobId: fields.blob_id,
            contentType: metadata.content_type || '',
            contentSize: parseInt(metadata.content_size || '0'),
            contentHash: metadata.content_hash || '',
            topic: metadata.topic || '',
            importance: parseInt(metadata.importance || '5'),
            embeddingBlobId: metadata.embedding_blob_id || '',
            createdAt: parseInt(metadata.created_timestamp || '0'),
            updatedAt: parseInt(metadata.updated_timestamp || '0'),
          });
        }
      }

      return {
        data: memories,
        nextCursor: response.nextCursor || undefined,
        hasMore: response.hasNextPage,
      };
    } catch (error) {
      throw new Error(`Failed to get user memories: ${error}`);
    }
  }

  /**
   * Get a specific memory by ID
   */
  async getMemory(memoryId: string): Promise<MemoryRecord | null> {
    try {
      const response = await this.client.getObject({
        id: memoryId,
        options: {
          showContent: true,
          showType: true,
        },
      });

      if (!response.data?.content || !('fields' in response.data.content)) {
        return null;
      }

      const fields = response.data.content.fields as any;

      return {
        id: response.data.objectId,
        owner: fields.owner,
        category: fields.category,
        vectorId: parseInt(fields.vector_id),
        blobId: fields.blob_id,
        contentType: fields.content_type,
        contentSize: parseInt(fields.content_size),
        contentHash: fields.content_hash,
        topic: fields.topic,
        importance: parseInt(fields.importance),
        embeddingBlobId: fields.embedding_blob_id,
        createdAt: parseInt(fields.created_at || '0'),
        updatedAt: parseInt(fields.updated_at || '0'),
      };
    } catch (error) {
      throw new Error(`Failed to get memory: ${error}`);
    }
  }

  /**
   * Get memory index for a user
   */
  async getMemoryIndex(userAddress: string): Promise<MemoryIndex | null> {
    try {
      const response = await this.client.getOwnedObjects({
        owner: userAddress,
        filter: {
          StructType: `${this.config.packageId}::memory::MemoryIndex`,
        },
        options: {
          showContent: true,
          showType: true,
        },
        limit: 1,
      });

      if (response.data.length === 0) {
        return null;
      }

      const obj = response.data[0];
      if (!obj.data?.content || !('fields' in obj.data.content)) {
        return null;
      }

      const fields = obj.data.content.fields as any;

      return {
        id: obj.data.objectId,
        owner: fields.owner,
        version: parseInt(fields.version),
        indexBlobId: fields.index_blob_id,
        graphBlobId: fields.graph_blob_id,
        memoryCount: parseInt(fields.memory_count || '0'),
        lastUpdated: parseInt(fields.last_updated || '0'),
      };
    } catch (error) {
      throw new Error(`Failed to get memory index: ${error}`);
    }
  }

  /**
   * Get memory statistics for a user
   */
  async getMemoryStats(userAddress: string): Promise<MemoryStats> {
    try {
  const memories = await this.getUserMemories(userAddress, { limit: ViewService.MAX_QUERY_LIMIT });
      
      const categoryCounts: Record<string, number> = {};
      let totalSize = 0;
      let totalImportance = 0;
      let lastActivityTime = 0;

      for (const memory of memories.data) {
        // Count categories
        categoryCounts[memory.category] = (categoryCounts[memory.category] || 0) + 1;
        
        // Sum sizes
        totalSize += memory.contentSize;
        
        // Sum importance for average
        totalImportance += memory.importance;
        
        // Track latest activity
        if (memory.updatedAt > lastActivityTime) {
          lastActivityTime = memory.updatedAt;
        }
      }

      return {
        totalMemories: memories.data.length,
        categoryCounts,
        totalSize,
        averageImportance: memories.data.length > 0 ? totalImportance / memories.data.length : 0,
        lastActivityTime,
      };
    } catch (error) {
      throw new Error(`Failed to get memory stats: ${error}`);
    }
  }

  // ==================== ACCESS CONTROL QUERIES ====================

  /**
   * Get access permissions for a user
   */
  async getAccessPermissions(userAddress: string, options?: {
    asGrantor?: boolean;
    asGrantee?: boolean;
    activeOnly?: boolean;
  }): Promise<AccessPermission[]> {
    try {
      const permissions: AccessPermission[] = [];

      // Query as grantor (permissions granted by user)
      if (options?.asGrantor !== false) {
        const grantorResponse = await this.client.getOwnedObjects({
          owner: userAddress,
          filter: {
            StructType: `${this.config.packageId}::seal_access_control::AccessPermission`,
          },
          options: {
            showContent: true,
            showType: true,
          },
        });

        for (const obj of grantorResponse.data) {
          if (obj.data?.content && 'fields' in obj.data.content) {
            const fields = obj.data.content.fields as any;
            const expiresAt = fields.expires_at ? parseInt(fields.expires_at) : undefined;
            const isActive = !expiresAt || expiresAt > Date.now();

            if (!options?.activeOnly || isActive) {
              permissions.push({
                id: obj.data.objectId,
                grantor: fields.grantor,
                grantee: fields.grantee,
                contentId: fields.content_id,
                permissionType: fields.permission_type,
                expiresAt,
                createdAt: parseInt(fields.created_at),
                isActive,
              });
            }
          }
        }
      }

      // Query as grantee (permissions granted to user) - would need events or indexing
      if (options?.asGrantee !== false) {
        // Note: In a real implementation, this would require event querying
        // or a secondary index to find permissions where user is the grantee
        // For now, we'll note this limitation
      }

      return permissions;
    } catch (error) {
      throw new Error(`Failed to get access permissions: ${error}`);
    }
  }

  /**
   * Get content registry entries
   */
  async getContentRegistry(options?: {
    owner?: string;
    limit?: number;
    cursor?: string;
  }): Promise<{
    data: ContentRegistry[];
    nextCursor?: string;
    hasMore: boolean;
  }> {
    try {
      const queryOptions: any = {
        filter: {
          StructType: `${this.config.packageId}::seal_access_control::ContentRegistry`,
        },
        options: {
          showContent: true,
          showType: true,
        },
        limit: options?.limit || 50,
        cursor: options?.cursor,
      };

      // If owner specified, query owned objects
      if (options?.owner) {
        queryOptions.owner = options.owner;
      }

      // Query objects - for non-owned queries, we'll use a different approach
      let response;
      if (options?.owner) {
        response = await this.client.getOwnedObjects(queryOptions);
      } else {
        // For general queries without owner, we'll need to use events or other indexing
        // For now, return empty result as this requires additional infrastructure
        response = { data: [], nextCursor: null, hasNextPage: false };
      }

      const registries: ContentRegistry[] = [];
      
      for (const obj of response.data) {
        if (obj.data?.content && 'fields' in obj.data.content) {
          const fields = obj.data.content.fields as any;

          registries.push({
            id: obj.data.objectId,
            owner: fields.owner,
            contentHash: fields.content_hash,
            encryptionInfo: fields.encryption_info,
            accessCount: parseInt(fields.access_count || '0'),
            createdAt: parseInt(fields.created_at),
          });
        }
      }

      return {
        data: registries,
        nextCursor: response.nextCursor || undefined,
        hasMore: response.hasNextPage,
      };
    } catch (error) {
      throw new Error(`Failed to get content registry: ${error}`);
    }
  }

  // ==================== UTILITY QUERIES ====================

  /**
   * Check if an object exists and is accessible
   */
  async objectExists(objectId: string): Promise<boolean> {
    try {
      const response = await this.client.getObject({
        id: objectId,
        options: { showType: true },
      });
      return response.data !== null;
    } catch (error) {
      return false;
    }
  }

  /**
   * Get object type information
   */
  async getObjectType(objectId: string): Promise<string | null> {
    try {
      const response = await this.client.getObject({
        id: objectId,
        options: { showType: true },
      });
      return response.data?.type || null;
    } catch (error) {
      return null;
    }
  }

  /**
   * Search memories by content hash
   * Note: This requires event-based indexing or a search service in production
   */
  async findMemoryByContentHash(contentHash: string): Promise<MemoryRecord[]> {
    try {
      // Note: This would typically require an event-based search or indexing service
      // For now, we'll return empty as this requires additional infrastructure
      // In a real implementation, this would use event queries or an indexing service
      
  console.debug('findMemoryByContentHash: This method requires event indexing infrastructure');
      return [];
    } catch (error) {
      throw new Error(`Failed to find memory by content hash: ${error}`);
    }
  }
}