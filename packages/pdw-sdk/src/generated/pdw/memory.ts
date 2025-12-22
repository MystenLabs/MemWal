/**************************************************************
 * THIS FILE IS GENERATED AND SHOULD NOT BE MANUALLY MODIFIED *
 **************************************************************/


/**
 * Memory management module for Personal Data Wallet
 * 
 * This module provides memory record management with:
 * 
 * - Rich metadata for encrypted content stored on Walrus
 * - Support for both capability-based and legacy address-based access
 * - Vector embedding storage for semantic search
 * - Knowledge graph integration
 * 
 * V2 Changes (Capability-based):
 * 
 * - Added capability_id field to link memories to MemoryCap
 * - New create_memory_with_cap() for capability-based creation
 * - Maintains backward compatibility with existing functions
 */

import { MoveStruct, normalizeMoveArguments, type RawTransactionArgument } from '../utils/index.js';
import { bcs } from '@mysten/sui/bcs';
import { type Transaction } from '@mysten/sui/transactions';
import * as vec_map from './deps/sui/vec_map.js';
import * as object from './deps/sui/object.js';
const $moduleName = '@local-pkg/pdw::memory';
export const MemoryCreated = new MoveStruct({ name: `${$moduleName}::MemoryCreated`, fields: {
        id: bcs.Address,
        owner: bcs.Address,
        category: bcs.string(),
        vector_id: bcs.u64(),
        /** V2: Link to MemoryCap object ID */
        capability_id: bcs.option(bcs.Address),
        /**
         * V2: App context for filtering (e.g., "MEMO", "HEALTH")
         *
         * - Query all: no filter
         * - Query by context: filter by app_id
         */
        app_id: bcs.option(bcs.string())
    } });
export const MemoryIndexUpdated = new MoveStruct({ name: `${$moduleName}::MemoryIndexUpdated`, fields: {
        id: bcs.Address,
        owner: bcs.Address,
        version: bcs.u64(),
        index_blob_id: bcs.string(),
        graph_blob_id: bcs.string()
    } });
export const MemoryMetadataUpdated = new MoveStruct({ name: `${$moduleName}::MemoryMetadataUpdated`, fields: {
        memory_id: bcs.Address,
        metadata_blob_id: bcs.string(),
        embedding_dimension: bcs.u64()
    } });
export const MemoryUpdated = new MoveStruct({ name: `${$moduleName}::MemoryUpdated`, fields: {
        id: bcs.Address,
        owner: bcs.Address,
        /**
         * Fields that were updated (bitmask: 1=blob_id, 2=category, 4=topic, 8=importance,
         * 16=embedding)
         */
        updated_fields: bcs.u8(),
        new_blob_id: bcs.option(bcs.string()),
        new_category: bcs.option(bcs.string()),
        updated_at: bcs.u64()
    } });
export const MemoryMetadata = new MoveStruct({ name: `${$moduleName}::MemoryMetadata`, fields: {
        content_type: bcs.string(),
        content_size: bcs.u64(),
        content_hash: bcs.string(),
        category: bcs.string(),
        topic: bcs.string(),
        importance: bcs.u8(),
        embedding_blob_id: bcs.string(),
        embedding_dimension: bcs.u64(),
        created_timestamp: bcs.u64(),
        updated_timestamp: bcs.u64(),
        custom_metadata: vec_map.VecMap(bcs.string(), bcs.string())
    } });
export const MemoryIndex = new MoveStruct({ name: `${$moduleName}::MemoryIndex`, fields: {
        id: object.UID,
        owner: bcs.Address,
        version: bcs.u64(),
        index_blob_id: bcs.string(),
        graph_blob_id: bcs.string()
    } });
export const Memory = new MoveStruct({ name: `${$moduleName}::Memory`, fields: {
        id: object.UID,
        owner: bcs.Address,
        category: bcs.string(),
        vector_id: bcs.u64(),
        blob_id: bcs.string(),
        metadata: MemoryMetadata,
        /**
         * V2: Link to MemoryCap for capability-based access control If set, access is
         * controlled via MemoryCap ownership If none, falls back to owner-based access
         * (legacy)
         */
        capability_id: bcs.option(bcs.Address),
        /**
         * V2: App context for context-based querying Copied from MemoryCap.app_id for
         * efficient filtering
         *
         * - Query all memories: getOwnedObjects without filter
         * - Query by context: filter by app_id field
         */
        app_id: bcs.option(bcs.string())
    } });
export interface CreateMemoryIndexArguments {
    indexBlobId: RawTransactionArgument<number[]>;
    graphBlobId: RawTransactionArgument<number[]>;
}
export interface CreateMemoryIndexOptions {
    package?: string;
    arguments: CreateMemoryIndexArguments | [
        indexBlobId: RawTransactionArgument<number[]>,
        graphBlobId: RawTransactionArgument<number[]>
    ];
}
/** Create a new memory index for a user */
export function createMemoryIndex(options: CreateMemoryIndexOptions) {
    const packageAddress = options.package ?? '@local-pkg/pdw';
    const argumentsTypes = [
        'vector<u8>',
        'vector<u8>'
    ] satisfies string[];
    const parameterNames = ["indexBlobId", "graphBlobId"];
    return (tx: Transaction) => tx.moveCall({
        package: packageAddress,
        module: 'memory',
        function: 'create_memory_index',
        arguments: normalizeMoveArguments(options.arguments, argumentsTypes, parameterNames),
    });
}
export interface UpdateMemoryIndexArguments {
    memoryIndex: RawTransactionArgument<string>;
    expectedVersion: RawTransactionArgument<number | bigint>;
    newIndexBlobId: RawTransactionArgument<number[]>;
    newGraphBlobId: RawTransactionArgument<number[]>;
}
export interface UpdateMemoryIndexOptions {
    package?: string;
    arguments: UpdateMemoryIndexArguments | [
        memoryIndex: RawTransactionArgument<string>,
        expectedVersion: RawTransactionArgument<number | bigint>,
        newIndexBlobId: RawTransactionArgument<number[]>,
        newGraphBlobId: RawTransactionArgument<number[]>
    ];
}
/** Update an existing memory index with new blob IDs */
export function updateMemoryIndex(options: UpdateMemoryIndexOptions) {
    const packageAddress = options.package ?? '@local-pkg/pdw';
    const argumentsTypes = [
        `${packageAddress}::memory::MemoryIndex`,
        'u64',
        'vector<u8>',
        'vector<u8>'
    ] satisfies string[];
    const parameterNames = ["memoryIndex", "expectedVersion", "newIndexBlobId", "newGraphBlobId"];
    return (tx: Transaction) => tx.moveCall({
        package: packageAddress,
        module: 'memory',
        function: 'update_memory_index',
        arguments: normalizeMoveArguments(options.arguments, argumentsTypes, parameterNames),
    });
}
export interface CreateMemoryMetadataArguments {
    contentType: RawTransactionArgument<number[]>;
    contentSize: RawTransactionArgument<number | bigint>;
    contentHash: RawTransactionArgument<number[]>;
    category: RawTransactionArgument<number[]>;
    topic: RawTransactionArgument<number[]>;
    importance: RawTransactionArgument<number>;
    embeddingBlobId: RawTransactionArgument<number[]>;
    embeddingDimension: RawTransactionArgument<number | bigint>;
    createdTimestamp: RawTransactionArgument<number | bigint>;
}
export interface CreateMemoryMetadataOptions {
    package?: string;
    arguments: CreateMemoryMetadataArguments | [
        contentType: RawTransactionArgument<number[]>,
        contentSize: RawTransactionArgument<number | bigint>,
        contentHash: RawTransactionArgument<number[]>,
        category: RawTransactionArgument<number[]>,
        topic: RawTransactionArgument<number[]>,
        importance: RawTransactionArgument<number>,
        embeddingBlobId: RawTransactionArgument<number[]>,
        embeddingDimension: RawTransactionArgument<number | bigint>,
        createdTimestamp: RawTransactionArgument<number | bigint>
    ];
}
/** Create metadata struct with embedding */
export function createMemoryMetadata(options: CreateMemoryMetadataOptions) {
    const packageAddress = options.package ?? '@local-pkg/pdw';
    const argumentsTypes = [
        'vector<u8>',
        'u64',
        'vector<u8>',
        'vector<u8>',
        'vector<u8>',
        'u8',
        'vector<u8>',
        'u64',
        'u64'
    ] satisfies string[];
    const parameterNames = ["contentType", "contentSize", "contentHash", "category", "topic", "importance", "embeddingBlobId", "embeddingDimension", "createdTimestamp"];
    return (tx: Transaction) => tx.moveCall({
        package: packageAddress,
        module: 'memory',
        function: 'create_memory_metadata',
        arguments: normalizeMoveArguments(options.arguments, argumentsTypes, parameterNames),
    });
}
export interface CreateMemoryRecordArguments {
    category: RawTransactionArgument<number[]>;
    vectorId: RawTransactionArgument<number | bigint>;
    blobId: RawTransactionArgument<number[]>;
    contentType: RawTransactionArgument<number[]>;
    contentSize: RawTransactionArgument<number | bigint>;
    contentHash: RawTransactionArgument<number[]>;
    topic: RawTransactionArgument<number[]>;
    importance: RawTransactionArgument<number>;
    embeddingBlobId: RawTransactionArgument<number[]>;
}
export interface CreateMemoryRecordOptions {
    package?: string;
    arguments: CreateMemoryRecordArguments | [
        category: RawTransactionArgument<number[]>,
        vectorId: RawTransactionArgument<number | bigint>,
        blobId: RawTransactionArgument<number[]>,
        contentType: RawTransactionArgument<number[]>,
        contentSize: RawTransactionArgument<number | bigint>,
        contentHash: RawTransactionArgument<number[]>,
        topic: RawTransactionArgument<number[]>,
        importance: RawTransactionArgument<number>,
        embeddingBlobId: RawTransactionArgument<number[]>
    ];
}
/**
 * Create a new memory record with rich metadata (LEGACY - for backward
 * compatibility)
 *
 * NOTE: For new implementations, use create_memory_with_cap() instead which
 * provides capability-based access control.
 */
export function createMemoryRecord(options: CreateMemoryRecordOptions) {
    const packageAddress = options.package ?? '@local-pkg/pdw';
    const argumentsTypes = [
        'vector<u8>',
        'u64',
        'vector<u8>',
        'vector<u8>',
        'u64',
        'vector<u8>',
        'vector<u8>',
        'u8',
        'vector<u8>'
    ] satisfies string[];
    const parameterNames = ["category", "vectorId", "blobId", "contentType", "contentSize", "contentHash", "topic", "importance", "embeddingBlobId"];
    return (tx: Transaction) => tx.moveCall({
        package: packageAddress,
        module: 'memory',
        function: 'create_memory_record',
        arguments: normalizeMoveArguments(options.arguments, argumentsTypes, parameterNames),
    });
}
export interface CreateMemoryWithCapArguments {
    cap: RawTransactionArgument<string>;
    category: RawTransactionArgument<number[]>;
    vectorId: RawTransactionArgument<number | bigint>;
    blobId: RawTransactionArgument<number[]>;
    contentType: RawTransactionArgument<number[]>;
    contentSize: RawTransactionArgument<number | bigint>;
    contentHash: RawTransactionArgument<number[]>;
    topic: RawTransactionArgument<number[]>;
    importance: RawTransactionArgument<number>;
    embeddingBlobId: RawTransactionArgument<number[]>;
}
export interface CreateMemoryWithCapOptions {
    package?: string;
    arguments: CreateMemoryWithCapArguments | [
        cap: RawTransactionArgument<string>,
        category: RawTransactionArgument<number[]>,
        vectorId: RawTransactionArgument<number | bigint>,
        blobId: RawTransactionArgument<number[]>,
        contentType: RawTransactionArgument<number[]>,
        contentSize: RawTransactionArgument<number | bigint>,
        contentHash: RawTransactionArgument<number[]>,
        topic: RawTransactionArgument<number[]>,
        importance: RawTransactionArgument<number>,
        embeddingBlobId: RawTransactionArgument<number[]>
    ];
}
/**
 * Create a new memory record with capability-based access control (V2 -
 * RECOMMENDED)
 *
 * This function links the memory to a MemoryCap for SEAL-compliant access control.
 * Benefits:
 *
 * - Access controlled via MemoryCap ownership
 * - Cross-dApp sharing "just works" (same owner = access)
 * - No allowlist management needed
 *
 * @param cap: Reference to the MemoryCap (proves ownership) @param category:
 * Memory category @param vector_id: Links to HNSW index @param blob_id: Pointer to
 * encrypted content on Walrus @param content_type: MIME type @param content_size:
 * Size in bytes @param content_hash: Content hash (blob_id) @param topic: Topic
 * classification @param importance: Importance scale (1-10) @param
 * embedding_blob_id: Pointer to embedding on Walrus @param ctx: Transaction
 * context
 */
export function createMemoryWithCap(options: CreateMemoryWithCapOptions) {
    const packageAddress = options.package ?? '@local-pkg/pdw';
    const argumentsTypes = [
        `${packageAddress}::capability::MemoryCap`,
        'vector<u8>',
        'u64',
        'vector<u8>',
        'vector<u8>',
        'u64',
        'vector<u8>',
        'vector<u8>',
        'u8',
        'vector<u8>'
    ] satisfies string[];
    const parameterNames = ["cap", "category", "vectorId", "blobId", "contentType", "contentSize", "contentHash", "topic", "importance", "embeddingBlobId"];
    return (tx: Transaction) => tx.moveCall({
        package: packageAddress,
        module: 'memory',
        function: 'create_memory_with_cap',
        arguments: normalizeMoveArguments(options.arguments, argumentsTypes, parameterNames),
    });
}
export interface UpdateMemoryMetadataArguments {
    memory: RawTransactionArgument<string>;
    newTopic: RawTransactionArgument<number[]>;
    newImportance: RawTransactionArgument<number>;
}
export interface UpdateMemoryMetadataOptions {
    package?: string;
    arguments: UpdateMemoryMetadataArguments | [
        memory: RawTransactionArgument<string>,
        newTopic: RawTransactionArgument<number[]>,
        newImportance: RawTransactionArgument<number>
    ];
}
/** Update metadata for an existing memory */
export function updateMemoryMetadata(options: UpdateMemoryMetadataOptions) {
    const packageAddress = options.package ?? '@local-pkg/pdw';
    const argumentsTypes = [
        `${packageAddress}::memory::Memory`,
        'vector<u8>',
        'u8'
    ] satisfies string[];
    const parameterNames = ["memory", "newTopic", "newImportance"];
    return (tx: Transaction) => tx.moveCall({
        package: packageAddress,
        module: 'memory',
        function: 'update_memory_metadata',
        arguments: normalizeMoveArguments(options.arguments, argumentsTypes, parameterNames),
    });
}
export interface AddCustomMetadataArguments {
    memory: RawTransactionArgument<string>;
    key: RawTransactionArgument<number[]>;
    value: RawTransactionArgument<number[]>;
}
export interface AddCustomMetadataOptions {
    package?: string;
    arguments: AddCustomMetadataArguments | [
        memory: RawTransactionArgument<string>,
        key: RawTransactionArgument<number[]>,
        value: RawTransactionArgument<number[]>
    ];
}
/** Add custom metadata field */
export function addCustomMetadata(options: AddCustomMetadataOptions) {
    const packageAddress = options.package ?? '@local-pkg/pdw';
    const argumentsTypes = [
        `${packageAddress}::memory::Memory`,
        'vector<u8>',
        'vector<u8>'
    ] satisfies string[];
    const parameterNames = ["memory", "key", "value"];
    return (tx: Transaction) => tx.moveCall({
        package: packageAddress,
        module: 'memory',
        function: 'add_custom_metadata',
        arguments: normalizeMoveArguments(options.arguments, argumentsTypes, parameterNames),
    });
}
export interface UpdateMemoryRecordArguments {
    memory: RawTransactionArgument<string>;
    newBlobId: RawTransactionArgument<number[]>;
    newCategory: RawTransactionArgument<number[]>;
    newTopic: RawTransactionArgument<number[]>;
    newImportance: RawTransactionArgument<number>;
    newEmbeddingBlobId: RawTransactionArgument<number[]>;
    newContentHash: RawTransactionArgument<number[]>;
    newContentSize: RawTransactionArgument<number | bigint>;
}
export interface UpdateMemoryRecordOptions {
    package?: string;
    arguments: UpdateMemoryRecordArguments | [
        memory: RawTransactionArgument<string>,
        newBlobId: RawTransactionArgument<number[]>,
        newCategory: RawTransactionArgument<number[]>,
        newTopic: RawTransactionArgument<number[]>,
        newImportance: RawTransactionArgument<number>,
        newEmbeddingBlobId: RawTransactionArgument<number[]>,
        newContentHash: RawTransactionArgument<number[]>,
        newContentSize: RawTransactionArgument<number | bigint>
    ];
}
/**
 * Comprehensive update for a memory record
 *
 * Updates multiple fields of a Memory object in a single transaction. Only
 * non-empty values will be updated (empty vector<u8> = skip update).
 *
 * This function follows Sui's object model where:
 *
 * - Objects are passed as mutable references (&mut)
 * - Version number is automatically incremented by Sui runtime
 * - Changes are atomic within the transaction
 *
 * @param memory: Mutable reference to the Memory object @param new_blob_id: New
 * Walrus blob ID (empty = no change) @param new_category: New category (empty = no
 * change) @param new_topic: New topic (empty = no change) @param new_importance:
 * New importance (0 = no change, 1-10 = update) @param new_embedding_blob_id: New
 * embedding blob ID (empty = no change) @param new_content_hash: New content hash
 * (empty = no change) @param new_content_size: New content size (0 = no change)
 * @param ctx: Transaction context
 */
export function updateMemoryRecord(options: UpdateMemoryRecordOptions) {
    const packageAddress = options.package ?? '@local-pkg/pdw';
    const argumentsTypes = [
        `${packageAddress}::memory::Memory`,
        'vector<u8>',
        'vector<u8>',
        'vector<u8>',
        'u8',
        'vector<u8>',
        'vector<u8>',
        'u64'
    ] satisfies string[];
    const parameterNames = ["memory", "newBlobId", "newCategory", "newTopic", "newImportance", "newEmbeddingBlobId", "newContentHash", "newContentSize"];
    return (tx: Transaction) => tx.moveCall({
        package: packageAddress,
        module: 'memory',
        function: 'update_memory_record',
        arguments: normalizeMoveArguments(options.arguments, argumentsTypes, parameterNames),
    });
}
export interface UpdateMemoryWithCapArguments {
    cap: RawTransactionArgument<string>;
    memory: RawTransactionArgument<string>;
    newBlobId: RawTransactionArgument<number[]>;
    newCategory: RawTransactionArgument<number[]>;
    newTopic: RawTransactionArgument<number[]>;
    newImportance: RawTransactionArgument<number>;
    newEmbeddingBlobId: RawTransactionArgument<number[]>;
    newContentHash: RawTransactionArgument<number[]>;
    newContentSize: RawTransactionArgument<number | bigint>;
}
export interface UpdateMemoryWithCapOptions {
    package?: string;
    arguments: UpdateMemoryWithCapArguments | [
        cap: RawTransactionArgument<string>,
        memory: RawTransactionArgument<string>,
        newBlobId: RawTransactionArgument<number[]>,
        newCategory: RawTransactionArgument<number[]>,
        newTopic: RawTransactionArgument<number[]>,
        newImportance: RawTransactionArgument<number>,
        newEmbeddingBlobId: RawTransactionArgument<number[]>,
        newContentHash: RawTransactionArgument<number[]>,
        newContentSize: RawTransactionArgument<number | bigint>
    ];
}
/**
 * Update memory record with capability verification (V2)
 *
 * Same as update_memory_record but verifies the caller owns the associated
 * MemoryCap. Use this for capability-based memories to ensure proper access
 * control.
 *
 * @param cap: Reference to the MemoryCap (proves ownership) @param memory: Mutable
 * reference to the Memory object @param new_blob_id: New Walrus blob ID (empty =
 * no change) @param new_category: New category (empty = no change) @param
 * new_topic: New topic (empty = no change) @param new_importance: New importance
 * (0 = no change, 1-10 = update) @param new_embedding_blob_id: New embedding blob
 * ID (empty = no change) @param new_content_hash: New content hash (empty = no
 * change) @param new_content_size: New content size (0 = no change) @param ctx:
 * Transaction context
 */
export function updateMemoryWithCap(options: UpdateMemoryWithCapOptions) {
    const packageAddress = options.package ?? '@local-pkg/pdw';
    const argumentsTypes = [
        `${packageAddress}::capability::MemoryCap`,
        `${packageAddress}::memory::Memory`,
        'vector<u8>',
        'vector<u8>',
        'vector<u8>',
        'u8',
        'vector<u8>',
        'vector<u8>',
        'u64'
    ] satisfies string[];
    const parameterNames = ["cap", "memory", "newBlobId", "newCategory", "newTopic", "newImportance", "newEmbeddingBlobId", "newContentHash", "newContentSize"];
    return (tx: Transaction) => tx.moveCall({
        package: packageAddress,
        module: 'memory',
        function: 'update_memory_with_cap',
        arguments: normalizeMoveArguments(options.arguments, argumentsTypes, parameterNames),
    });
}
export interface CreateMemoryRecordLightweightArguments {
    category: RawTransactionArgument<number[]>;
    vectorId: RawTransactionArgument<number | bigint>;
    blobId: RawTransactionArgument<number[]>;
    blobObjectId: RawTransactionArgument<number[]>;
    importance: RawTransactionArgument<number>;
}
export interface CreateMemoryRecordLightweightOptions {
    package?: string;
    arguments: CreateMemoryRecordLightweightArguments | [
        category: RawTransactionArgument<number[]>,
        vectorId: RawTransactionArgument<number | bigint>,
        blobId: RawTransactionArgument<number[]>,
        blobObjectId: RawTransactionArgument<number[]>,
        importance: RawTransactionArgument<number>
    ];
}
/**
 * Create a lightweight memory record (for use with Walrus metadata) - LEGACY
 *
 * This function creates a minimal on-chain Memory struct with only essential
 * queryable fields. Rich metadata should be stored as Walrus blob metadata.
 *
 * Use this when:
 *
 * - Gas costs are a concern
 * - Rich metadata is stored on Walrus blob
 * - Only need basic filtering (category, vector_id)
 *
 * NOTE: For new implementations, use create_memory_lightweight_with_cap() instead
 */
export function createMemoryRecordLightweight(options: CreateMemoryRecordLightweightOptions) {
    const packageAddress = options.package ?? '@local-pkg/pdw';
    const argumentsTypes = [
        'vector<u8>',
        'u64',
        'vector<u8>',
        'vector<u8>',
        'u8'
    ] satisfies string[];
    const parameterNames = ["category", "vectorId", "blobId", "blobObjectId", "importance"];
    return (tx: Transaction) => tx.moveCall({
        package: packageAddress,
        module: 'memory',
        function: 'create_memory_record_lightweight',
        arguments: normalizeMoveArguments(options.arguments, argumentsTypes, parameterNames),
    });
}
export interface CreateMemoryLightweightWithCapArguments {
    cap: RawTransactionArgument<string>;
    category: RawTransactionArgument<number[]>;
    vectorId: RawTransactionArgument<number | bigint>;
    blobId: RawTransactionArgument<number[]>;
    blobObjectId: RawTransactionArgument<number[]>;
    importance: RawTransactionArgument<number>;
}
export interface CreateMemoryLightweightWithCapOptions {
    package?: string;
    arguments: CreateMemoryLightweightWithCapArguments | [
        cap: RawTransactionArgument<string>,
        category: RawTransactionArgument<number[]>,
        vectorId: RawTransactionArgument<number | bigint>,
        blobId: RawTransactionArgument<number[]>,
        blobObjectId: RawTransactionArgument<number[]>,
        importance: RawTransactionArgument<number>
    ];
}
/**
 * Create a lightweight memory record with capability-based access (V2 -
 * RECOMMENDED)
 *
 * Gas-optimized version for capability-based access control.
 *
 * @param cap: Reference to the MemoryCap (proves ownership) @param category:
 * Memory category @param vector_id: Links to HNSW index @param blob_id: Pointer to
 * encrypted content on Walrus @param blob_object_id: Optional Walrus blob object
 * ID @param importance: Importance scale (1-10) @param ctx: Transaction context
 */
export function createMemoryLightweightWithCap(options: CreateMemoryLightweightWithCapOptions) {
    const packageAddress = options.package ?? '@local-pkg/pdw';
    const argumentsTypes = [
        `${packageAddress}::capability::MemoryCap`,
        'vector<u8>',
        'u64',
        'vector<u8>',
        'vector<u8>',
        'u8'
    ] satisfies string[];
    const parameterNames = ["cap", "category", "vectorId", "blobId", "blobObjectId", "importance"];
    return (tx: Transaction) => tx.moveCall({
        package: packageAddress,
        module: 'memory',
        function: 'create_memory_lightweight_with_cap',
        arguments: normalizeMoveArguments(options.arguments, argumentsTypes, parameterNames),
    });
}
export interface DeleteMemoryRecordArguments {
    memory: RawTransactionArgument<string>;
}
export interface DeleteMemoryRecordOptions {
    package?: string;
    arguments: DeleteMemoryRecordArguments | [
        memory: RawTransactionArgument<string>
    ];
}
/** Delete a memory record */
export function deleteMemoryRecord(options: DeleteMemoryRecordOptions) {
    const packageAddress = options.package ?? '@local-pkg/pdw';
    const argumentsTypes = [
        `${packageAddress}::memory::Memory`
    ] satisfies string[];
    const parameterNames = ["memory"];
    return (tx: Transaction) => tx.moveCall({
        package: packageAddress,
        module: 'memory',
        function: 'delete_memory_record',
        arguments: normalizeMoveArguments(options.arguments, argumentsTypes, parameterNames),
    });
}
export interface GetIndexBlobIdArguments {
    memoryIndex: RawTransactionArgument<string>;
}
export interface GetIndexBlobIdOptions {
    package?: string;
    arguments: GetIndexBlobIdArguments | [
        memoryIndex: RawTransactionArgument<string>
    ];
}
export function getIndexBlobId(options: GetIndexBlobIdOptions) {
    const packageAddress = options.package ?? '@local-pkg/pdw';
    const argumentsTypes = [
        `${packageAddress}::memory::MemoryIndex`
    ] satisfies string[];
    const parameterNames = ["memoryIndex"];
    return (tx: Transaction) => tx.moveCall({
        package: packageAddress,
        module: 'memory',
        function: 'get_index_blob_id',
        arguments: normalizeMoveArguments(options.arguments, argumentsTypes, parameterNames),
    });
}
export interface GetGraphBlobIdArguments {
    memoryIndex: RawTransactionArgument<string>;
}
export interface GetGraphBlobIdOptions {
    package?: string;
    arguments: GetGraphBlobIdArguments | [
        memoryIndex: RawTransactionArgument<string>
    ];
}
export function getGraphBlobId(options: GetGraphBlobIdOptions) {
    const packageAddress = options.package ?? '@local-pkg/pdw';
    const argumentsTypes = [
        `${packageAddress}::memory::MemoryIndex`
    ] satisfies string[];
    const parameterNames = ["memoryIndex"];
    return (tx: Transaction) => tx.moveCall({
        package: packageAddress,
        module: 'memory',
        function: 'get_graph_blob_id',
        arguments: normalizeMoveArguments(options.arguments, argumentsTypes, parameterNames),
    });
}
export interface GetVersionArguments {
    memoryIndex: RawTransactionArgument<string>;
}
export interface GetVersionOptions {
    package?: string;
    arguments: GetVersionArguments | [
        memoryIndex: RawTransactionArgument<string>
    ];
}
export function getVersion(options: GetVersionOptions) {
    const packageAddress = options.package ?? '@local-pkg/pdw';
    const argumentsTypes = [
        `${packageAddress}::memory::MemoryIndex`
    ] satisfies string[];
    const parameterNames = ["memoryIndex"];
    return (tx: Transaction) => tx.moveCall({
        package: packageAddress,
        module: 'memory',
        function: 'get_version',
        arguments: normalizeMoveArguments(options.arguments, argumentsTypes, parameterNames),
    });
}
export interface GetMemoryBlobIdArguments {
    memory: RawTransactionArgument<string>;
}
export interface GetMemoryBlobIdOptions {
    package?: string;
    arguments: GetMemoryBlobIdArguments | [
        memory: RawTransactionArgument<string>
    ];
}
export function getMemoryBlobId(options: GetMemoryBlobIdOptions) {
    const packageAddress = options.package ?? '@local-pkg/pdw';
    const argumentsTypes = [
        `${packageAddress}::memory::Memory`
    ] satisfies string[];
    const parameterNames = ["memory"];
    return (tx: Transaction) => tx.moveCall({
        package: packageAddress,
        module: 'memory',
        function: 'get_memory_blob_id',
        arguments: normalizeMoveArguments(options.arguments, argumentsTypes, parameterNames),
    });
}
export interface GetMemoryVectorIdArguments {
    memory: RawTransactionArgument<string>;
}
export interface GetMemoryVectorIdOptions {
    package?: string;
    arguments: GetMemoryVectorIdArguments | [
        memory: RawTransactionArgument<string>
    ];
}
export function getMemoryVectorId(options: GetMemoryVectorIdOptions) {
    const packageAddress = options.package ?? '@local-pkg/pdw';
    const argumentsTypes = [
        `${packageAddress}::memory::Memory`
    ] satisfies string[];
    const parameterNames = ["memory"];
    return (tx: Transaction) => tx.moveCall({
        package: packageAddress,
        module: 'memory',
        function: 'get_memory_vector_id',
        arguments: normalizeMoveArguments(options.arguments, argumentsTypes, parameterNames),
    });
}
export interface GetMemoryCategoryArguments {
    memory: RawTransactionArgument<string>;
}
export interface GetMemoryCategoryOptions {
    package?: string;
    arguments: GetMemoryCategoryArguments | [
        memory: RawTransactionArgument<string>
    ];
}
export function getMemoryCategory(options: GetMemoryCategoryOptions) {
    const packageAddress = options.package ?? '@local-pkg/pdw';
    const argumentsTypes = [
        `${packageAddress}::memory::Memory`
    ] satisfies string[];
    const parameterNames = ["memory"];
    return (tx: Transaction) => tx.moveCall({
        package: packageAddress,
        module: 'memory',
        function: 'get_memory_category',
        arguments: normalizeMoveArguments(options.arguments, argumentsTypes, parameterNames),
    });
}
export interface GetMetadataArguments {
    memory: RawTransactionArgument<string>;
}
export interface GetMetadataOptions {
    package?: string;
    arguments: GetMetadataArguments | [
        memory: RawTransactionArgument<string>
    ];
}
export function getMetadata(options: GetMetadataOptions) {
    const packageAddress = options.package ?? '@local-pkg/pdw';
    const argumentsTypes = [
        `${packageAddress}::memory::Memory`
    ] satisfies string[];
    const parameterNames = ["memory"];
    return (tx: Transaction) => tx.moveCall({
        package: packageAddress,
        module: 'memory',
        function: 'get_metadata',
        arguments: normalizeMoveArguments(options.arguments, argumentsTypes, parameterNames),
    });
}
export interface GetEmbeddingBlobIdArguments {
    metadata: RawTransactionArgument<string>;
}
export interface GetEmbeddingBlobIdOptions {
    package?: string;
    arguments: GetEmbeddingBlobIdArguments | [
        metadata: RawTransactionArgument<string>
    ];
}
export function getEmbeddingBlobId(options: GetEmbeddingBlobIdOptions) {
    const packageAddress = options.package ?? '@local-pkg/pdw';
    const argumentsTypes = [
        `${packageAddress}::memory::MemoryMetadata`
    ] satisfies string[];
    const parameterNames = ["metadata"];
    return (tx: Transaction) => tx.moveCall({
        package: packageAddress,
        module: 'memory',
        function: 'get_embedding_blob_id',
        arguments: normalizeMoveArguments(options.arguments, argumentsTypes, parameterNames),
    });
}
export interface GetContentTypeArguments {
    metadata: RawTransactionArgument<string>;
}
export interface GetContentTypeOptions {
    package?: string;
    arguments: GetContentTypeArguments | [
        metadata: RawTransactionArgument<string>
    ];
}
export function getContentType(options: GetContentTypeOptions) {
    const packageAddress = options.package ?? '@local-pkg/pdw';
    const argumentsTypes = [
        `${packageAddress}::memory::MemoryMetadata`
    ] satisfies string[];
    const parameterNames = ["metadata"];
    return (tx: Transaction) => tx.moveCall({
        package: packageAddress,
        module: 'memory',
        function: 'get_content_type',
        arguments: normalizeMoveArguments(options.arguments, argumentsTypes, parameterNames),
    });
}
export interface GetContentSizeArguments {
    metadata: RawTransactionArgument<string>;
}
export interface GetContentSizeOptions {
    package?: string;
    arguments: GetContentSizeArguments | [
        metadata: RawTransactionArgument<string>
    ];
}
export function getContentSize(options: GetContentSizeOptions) {
    const packageAddress = options.package ?? '@local-pkg/pdw';
    const argumentsTypes = [
        `${packageAddress}::memory::MemoryMetadata`
    ] satisfies string[];
    const parameterNames = ["metadata"];
    return (tx: Transaction) => tx.moveCall({
        package: packageAddress,
        module: 'memory',
        function: 'get_content_size',
        arguments: normalizeMoveArguments(options.arguments, argumentsTypes, parameterNames),
    });
}
export interface GetTopicArguments {
    metadata: RawTransactionArgument<string>;
}
export interface GetTopicOptions {
    package?: string;
    arguments: GetTopicArguments | [
        metadata: RawTransactionArgument<string>
    ];
}
export function getTopic(options: GetTopicOptions) {
    const packageAddress = options.package ?? '@local-pkg/pdw';
    const argumentsTypes = [
        `${packageAddress}::memory::MemoryMetadata`
    ] satisfies string[];
    const parameterNames = ["metadata"];
    return (tx: Transaction) => tx.moveCall({
        package: packageAddress,
        module: 'memory',
        function: 'get_topic',
        arguments: normalizeMoveArguments(options.arguments, argumentsTypes, parameterNames),
    });
}
export interface GetImportanceArguments {
    metadata: RawTransactionArgument<string>;
}
export interface GetImportanceOptions {
    package?: string;
    arguments: GetImportanceArguments | [
        metadata: RawTransactionArgument<string>
    ];
}
export function getImportance(options: GetImportanceOptions) {
    const packageAddress = options.package ?? '@local-pkg/pdw';
    const argumentsTypes = [
        `${packageAddress}::memory::MemoryMetadata`
    ] satisfies string[];
    const parameterNames = ["metadata"];
    return (tx: Transaction) => tx.moveCall({
        package: packageAddress,
        module: 'memory',
        function: 'get_importance',
        arguments: normalizeMoveArguments(options.arguments, argumentsTypes, parameterNames),
    });
}
export interface GetCreatedTimestampArguments {
    metadata: RawTransactionArgument<string>;
}
export interface GetCreatedTimestampOptions {
    package?: string;
    arguments: GetCreatedTimestampArguments | [
        metadata: RawTransactionArgument<string>
    ];
}
export function getCreatedTimestamp(options: GetCreatedTimestampOptions) {
    const packageAddress = options.package ?? '@local-pkg/pdw';
    const argumentsTypes = [
        `${packageAddress}::memory::MemoryMetadata`
    ] satisfies string[];
    const parameterNames = ["metadata"];
    return (tx: Transaction) => tx.moveCall({
        package: packageAddress,
        module: 'memory',
        function: 'get_created_timestamp',
        arguments: normalizeMoveArguments(options.arguments, argumentsTypes, parameterNames),
    });
}
export interface GetUpdatedTimestampArguments {
    metadata: RawTransactionArgument<string>;
}
export interface GetUpdatedTimestampOptions {
    package?: string;
    arguments: GetUpdatedTimestampArguments | [
        metadata: RawTransactionArgument<string>
    ];
}
export function getUpdatedTimestamp(options: GetUpdatedTimestampOptions) {
    const packageAddress = options.package ?? '@local-pkg/pdw';
    const argumentsTypes = [
        `${packageAddress}::memory::MemoryMetadata`
    ] satisfies string[];
    const parameterNames = ["metadata"];
    return (tx: Transaction) => tx.moveCall({
        package: packageAddress,
        module: 'memory',
        function: 'get_updated_timestamp',
        arguments: normalizeMoveArguments(options.arguments, argumentsTypes, parameterNames),
    });
}
export interface GetCustomMetadataArguments {
    metadata: RawTransactionArgument<string>;
}
export interface GetCustomMetadataOptions {
    package?: string;
    arguments: GetCustomMetadataArguments | [
        metadata: RawTransactionArgument<string>
    ];
}
export function getCustomMetadata(options: GetCustomMetadataOptions) {
    const packageAddress = options.package ?? '@local-pkg/pdw';
    const argumentsTypes = [
        `${packageAddress}::memory::MemoryMetadata`
    ] satisfies string[];
    const parameterNames = ["metadata"];
    return (tx: Transaction) => tx.moveCall({
        package: packageAddress,
        module: 'memory',
        function: 'get_custom_metadata',
        arguments: normalizeMoveArguments(options.arguments, argumentsTypes, parameterNames),
    });
}
export interface GetCapabilityIdArguments {
    memory: RawTransactionArgument<string>;
}
export interface GetCapabilityIdOptions {
    package?: string;
    arguments: GetCapabilityIdArguments | [
        memory: RawTransactionArgument<string>
    ];
}
/** Get the capability_id from a memory (if linked to a MemoryCap) */
export function getCapabilityId(options: GetCapabilityIdOptions) {
    const packageAddress = options.package ?? '@local-pkg/pdw';
    const argumentsTypes = [
        `${packageAddress}::memory::Memory`
    ] satisfies string[];
    const parameterNames = ["memory"];
    return (tx: Transaction) => tx.moveCall({
        package: packageAddress,
        module: 'memory',
        function: 'get_capability_id',
        arguments: normalizeMoveArguments(options.arguments, argumentsTypes, parameterNames),
    });
}
export interface HasCapabilityArguments {
    memory: RawTransactionArgument<string>;
}
export interface HasCapabilityOptions {
    package?: string;
    arguments: HasCapabilityArguments | [
        memory: RawTransactionArgument<string>
    ];
}
/** Check if memory is linked to a capability (V2) */
export function hasCapability(options: HasCapabilityOptions) {
    const packageAddress = options.package ?? '@local-pkg/pdw';
    const argumentsTypes = [
        `${packageAddress}::memory::Memory`
    ] satisfies string[];
    const parameterNames = ["memory"];
    return (tx: Transaction) => tx.moveCall({
        package: packageAddress,
        module: 'memory',
        function: 'has_capability',
        arguments: normalizeMoveArguments(options.arguments, argumentsTypes, parameterNames),
    });
}
export interface IsLegacyAccessArguments {
    memory: RawTransactionArgument<string>;
}
export interface IsLegacyAccessOptions {
    package?: string;
    arguments: IsLegacyAccessArguments | [
        memory: RawTransactionArgument<string>
    ];
}
/** Check if memory is using legacy owner-based access */
export function isLegacyAccess(options: IsLegacyAccessOptions) {
    const packageAddress = options.package ?? '@local-pkg/pdw';
    const argumentsTypes = [
        `${packageAddress}::memory::Memory`
    ] satisfies string[];
    const parameterNames = ["memory"];
    return (tx: Transaction) => tx.moveCall({
        package: packageAddress,
        module: 'memory',
        function: 'is_legacy_access',
        arguments: normalizeMoveArguments(options.arguments, argumentsTypes, parameterNames),
    });
}
export interface GetAppIdArguments {
    memory: RawTransactionArgument<string>;
}
export interface GetAppIdOptions {
    package?: string;
    arguments: GetAppIdArguments | [
        memory: RawTransactionArgument<string>
    ];
}
/**
 * Get the app_id from a memory (for context-based querying) Returns None for
 * legacy memories without capability
 */
export function getAppId(options: GetAppIdOptions) {
    const packageAddress = options.package ?? '@local-pkg/pdw';
    const argumentsTypes = [
        `${packageAddress}::memory::Memory`
    ] satisfies string[];
    const parameterNames = ["memory"];
    return (tx: Transaction) => tx.moveCall({
        package: packageAddress,
        module: 'memory',
        function: 'get_app_id',
        arguments: normalizeMoveArguments(options.arguments, argumentsTypes, parameterNames),
    });
}
export interface IsAppContextArguments {
    memory: RawTransactionArgument<string>;
    appId: RawTransactionArgument<string>;
}
export interface IsAppContextOptions {
    package?: string;
    arguments: IsAppContextArguments | [
        memory: RawTransactionArgument<string>,
        appId: RawTransactionArgument<string>
    ];
}
/** Check if memory belongs to a specific app context */
export function isAppContext(options: IsAppContextOptions) {
    const packageAddress = options.package ?? '@local-pkg/pdw';
    const argumentsTypes = [
        `${packageAddress}::memory::Memory`,
        '0x0000000000000000000000000000000000000000000000000000000000000001::string::String'
    ] satisfies string[];
    const parameterNames = ["memory", "appId"];
    return (tx: Transaction) => tx.moveCall({
        package: packageAddress,
        module: 'memory',
        function: 'is_app_context',
        arguments: normalizeMoveArguments(options.arguments, argumentsTypes, parameterNames),
    });
}