/**
 * Advanced Namespace - Power User Features
 *
 * Groups specialized features for advanced use cases:
 * - Knowledge graph operations
 * - Memory analytics and insights
 * - Manual encryption/decryption
 * - Access control and permissions
 * - Transaction building
 * - Processing pipelines
 *
 * Most users won't need these - use pdw.memory for common operations.
 *
 * @module client/namespaces/consolidated
 */

import type { ServiceContainer } from '../../SimplePDWClient';
import type { GraphNamespace } from '../GraphNamespace';
import type { AnalyticsNamespace } from '../AnalyticsNamespace';
import type { EncryptionNamespace } from '../EncryptionNamespace';
import type { PermissionsNamespace } from '../PermissionsNamespace';
import type { TxNamespace } from '../TxNamespace';
import type { PipelineNamespace } from '../PipelineNamespace';
import type { CapabilityNamespace } from '../CapabilityNamespace';
import type { ContextNamespace } from '../ContextNamespace';
import type { BatchNamespace } from '../BatchNamespace';
import type { CacheNamespace } from '../CacheNamespace';
import type { SearchNamespace } from '../SearchNamespace';

/**
 * Advanced Namespace
 *
 * Access specialized features through sub-namespaces:
 *
 * @example
 * ```typescript
 * // Knowledge graph
 * const entities = await pdw.advanced.graph.getEntities();
 *
 * // Analytics
 * const insights = await pdw.advanced.analytics.generate();
 *
 * // Manual encryption
 * const encrypted = await pdw.advanced.encryption.encrypt(data);
 *
 * // Permissions
 * await pdw.advanced.permissions.grant(userId, memoryId);
 *
 * // Blockchain transactions
 * const tx = pdw.advanced.blockchain.buildCreateMemory(params);
 * ```
 */
export class AdvancedNamespace {
  private _graph?: GraphNamespace;
  private _analytics?: AnalyticsNamespace;
  private _encryption?: EncryptionNamespace;
  private _permissions?: PermissionsNamespace;
  private _blockchain?: TxNamespace;
  private _pipeline?: PipelineNamespace;
  private _capability?: CapabilityNamespace;
  private _context?: ContextNamespace;
  private _batch?: BatchNamespace;
  private _cache?: CacheNamespace;
  private _search?: SearchNamespace;

  constructor(
    private services: ServiceContainer,
    namespaces: {
      graph?: GraphNamespace;
      analytics?: AnalyticsNamespace;
      encryption?: EncryptionNamespace;
      permissions?: PermissionsNamespace;
      blockchain?: TxNamespace;
      pipeline?: PipelineNamespace;
      capability?: CapabilityNamespace;
      context?: ContextNamespace;
      batch?: BatchNamespace;
      cache?: CacheNamespace;
      search?: SearchNamespace;
    }
  ) {
    this._graph = namespaces.graph;
    this._analytics = namespaces.analytics;
    this._encryption = namespaces.encryption;
    this._permissions = namespaces.permissions;
    this._blockchain = namespaces.blockchain;
    this._pipeline = namespaces.pipeline;
    this._capability = namespaces.capability;
    this._context = namespaces.context;
    this._batch = namespaces.batch;
    this._cache = namespaces.cache;
    this._search = namespaces.search;
  }

  /**
   * Knowledge Graph Operations
   *
   * Extract entities and relationships from memories,
   * traverse the graph, and find connections.
   *
   * @example
   * ```typescript
   * const entities = await pdw.advanced.graph.getEntities();
   * const related = await pdw.advanced.graph.traverse(entityId);
   * ```
   */
  get graph(): GraphNamespace | undefined {
    return this._graph;
  }

  /**
   * Memory Analytics
   *
   * Generate insights, trends, and clustering from memories.
   *
   * @example
   * ```typescript
   * const insights = await pdw.advanced.analytics.generate();
   * const trends = await pdw.advanced.analytics.trends();
   * ```
   */
  get analytics(): AnalyticsNamespace | undefined {
    return this._analytics;
  }

  /**
   * Manual Encryption/Decryption
   *
   * Direct access to SEAL encryption for custom use cases.
   * Note: pdw.memory.create() handles encryption automatically.
   *
   * @example
   * ```typescript
   * const encrypted = await pdw.advanced.encryption.encrypt(data, keyId);
   * const decrypted = await pdw.advanced.encryption.decrypt(options);
   * ```
   */
  get encryption(): EncryptionNamespace | undefined {
    return this._encryption;
  }

  /**
   * Access Control & Permissions
   *
   * Grant, revoke, and manage access to memories.
   *
   * @example
   * ```typescript
   * await pdw.advanced.permissions.grant(userId, memoryId);
   * await pdw.advanced.permissions.revoke(userId, memoryId);
   * const perms = await pdw.advanced.permissions.list(memoryId);
   * ```
   */
  get permissions(): PermissionsNamespace | undefined {
    return this._permissions;
  }

  /**
   * Blockchain Transaction Building
   *
   * Build custom Sui transactions for advanced operations.
   *
   * @example
   * ```typescript
   * const tx = pdw.advanced.blockchain.buildCreateMemory(params);
   * const result = await pdw.advanced.blockchain.execute(tx);
   * ```
   */
  get blockchain(): TxNamespace | undefined {
    return this._blockchain;
  }

  /**
   * Processing Pipelines
   *
   * Create and manage memory processing pipelines.
   *
   * @example
   * ```typescript
   * const pipeline = await pdw.advanced.pipeline.create(config);
   * await pdw.advanced.pipeline.execute(pipeline, data);
   * ```
   */
  get pipeline(): PipelineNamespace | undefined {
    return this._pipeline;
  }

  /**
   * Capability Management
   *
   * Low-level MemoryCap object management for SEAL encryption.
   *
   * @example
   * ```typescript
   * const cap = await pdw.advanced.capability.getOrCreate(appId);
   * const keyId = pdw.advanced.capability.computeKeyId(cap);
   * ```
   */
  get capability(): CapabilityNamespace | undefined {
    return this._capability;
  }

  /**
   * App Context Management
   *
   * Manage application contexts for multi-app memory access.
   *
   * @example
   * ```typescript
   * const ctx = await pdw.advanced.context.getOrCreate(appId);
   * await pdw.advanced.context.transfer(ctxId, newOwner);
   * ```
   */
  get context(): ContextNamespace | undefined {
    return this._context;
  }

  /**
   * Batch Processing Utilities
   *
   * Advanced batch operations beyond createBatch.
   *
   * @example
   * ```typescript
   * const stats = await pdw.advanced.batch.stats();
   * const progress = await pdw.advanced.batch.progress(batchId);
   * ```
   */
  get batch(): BatchNamespace | undefined {
    return this._batch;
  }

  /**
   * Cache Management
   *
   * Direct access to in-memory LRU cache.
   *
   * @example
   * ```typescript
   * const cached = pdw.advanced.cache.get(key);
   * pdw.advanced.cache.set(key, value);
   * pdw.advanced.cache.clear();
   * ```
   */
  get cache(): CacheNamespace | undefined {
    return this._cache;
  }

  /**
   * Advanced Search
   *
   * Low-level vector and semantic search operations.
   * Note: pdw.memory.search() is simpler for most use cases.
   *
   * @example
   * ```typescript
   * const results = await pdw.advanced.search.vector(embedding, k);
   * const results = await pdw.advanced.search.hybrid(query, filters);
   * ```
   */
  get search(): SearchNamespace | undefined {
    return this._search;
  }
}
