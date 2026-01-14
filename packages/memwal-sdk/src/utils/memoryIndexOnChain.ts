/**
 * Memory Index On-Chain Utilities
 *
 * Utilities for managing MemoryIndex object on Sui blockchain:
 * - Reading current MemoryIndex state from chain
 * - Updating blob IDs after Walrus sync
 * - Creating new MemoryIndex if doesn't exist
 *
 * Environment Variables:
 * - MEMORY_INDEX_ID: Sui object ID of the MemoryIndex
 * - INDEX_BLOB_ID: Current Walrus blob ID for HNSW index (updated after sync)
 * - GRAPH_BLOB_ID: Current Walrus blob ID for knowledge graph
 */

import { SuiClient } from '@mysten/sui/client';
import { Transaction } from '@mysten/sui/transactions';
import type { Signer } from '@mysten/sui/cryptography';

/**
 * On-chain MemoryIndex object structure
 */
export interface OnChainMemoryIndex {
  /** Sui object ID */
  objectId: string;
  /** Owner address */
  owner: string;
  /** Version number for optimistic locking */
  version: number;
  /** Walrus blob ID for HNSW index */
  indexBlobId: string;
  /** Walrus blob ID for knowledge graph */
  graphBlobId: string;
}

/**
 * Options for getting MemoryIndex from chain
 */
export interface GetMemoryIndexOptions {
  /** Sui client instance */
  client: SuiClient;
  /** MemoryIndex object ID (from MEMORY_INDEX_ID env var) */
  memoryIndexId: string;
}

/**
 * Options for updating MemoryIndex on-chain
 */
export interface UpdateMemoryIndexOnChainOptions {
  /** Sui client instance */
  client: SuiClient;
  /** Signer for transaction */
  signer: Signer;
  /** Package ID of the PDW contract */
  packageId: string;
  /** MemoryIndex object ID */
  memoryIndexId: string;
  /** Current version for optimistic locking */
  expectedVersion: number;
  /** New index blob ID from Walrus */
  newIndexBlobId: string;
  /** New graph blob ID from Walrus */
  newGraphBlobId: string;
  /** Optional gas budget */
  gasBudget?: number;
}

/**
 * Options for creating a new MemoryIndex
 */
export interface CreateMemoryIndexOnChainOptions {
  /** Sui client instance */
  client: SuiClient;
  /** Signer for transaction */
  signer: Signer;
  /** Package ID of the PDW contract */
  packageId: string;
  /** Initial index blob ID (can be placeholder) */
  indexBlobId: string;
  /** Initial graph blob ID (can be placeholder) */
  graphBlobId: string;
  /** Optional gas budget */
  gasBudget?: number;
}

/**
 * Result of updating MemoryIndex
 */
export interface UpdateMemoryIndexResult {
  success: boolean;
  /** Transaction digest */
  digest?: string;
  /** New version number after update */
  newVersion?: number;
  /** Error message if failed */
  error?: string;
}

/**
 * Result of creating MemoryIndex
 */
export interface CreateMemoryIndexResult {
  success: boolean;
  /** Created MemoryIndex object ID */
  memoryIndexId?: string;
  /** Transaction digest */
  digest?: string;
  /** Error message if failed */
  error?: string;
}

/**
 * Read MemoryIndex object from Sui blockchain
 *
 * @param options - Options containing client and memoryIndexId
 * @returns The MemoryIndex object data or null if not found
 *
 * @example
 * ```typescript
 * const memoryIndex = await getMemoryIndex({
 *   client: suiClient,
 *   memoryIndexId: process.env.MEMORY_INDEX_ID!
 * });
 *
 * if (memoryIndex) {
 *   console.log(`Version: ${memoryIndex.version}`);
 *   console.log(`Index Blob: ${memoryIndex.indexBlobId}`);
 * }
 * ```
 */
export async function getMemoryIndex(
  options: GetMemoryIndexOptions
): Promise<OnChainMemoryIndex | null> {
  const { client, memoryIndexId } = options;

  if (!memoryIndexId) {
    console.warn('⚠️ MEMORY_INDEX_ID not provided');
    return null;
  }

  try {
    const object = await client.getObject({
      id: memoryIndexId,
      options: {
        showContent: true,
        showOwner: true,
      }
    });

    if (!object.data?.content || object.data.content.dataType !== 'moveObject') {
      console.warn(`⚠️ MemoryIndex object ${memoryIndexId} not found or not a Move object`);
      return null;
    }

    const fields = (object.data.content as any).fields;
    const owner = object.data.owner;

    // Extract owner address
    let ownerAddress = '';
    if (owner && typeof owner === 'object' && 'AddressOwner' in owner) {
      ownerAddress = (owner as { AddressOwner: string }).AddressOwner;
    }

    return {
      objectId: memoryIndexId,
      owner: ownerAddress,
      version: Number(fields.version || 1),
      indexBlobId: fields.index_blob_id || '',
      graphBlobId: fields.graph_blob_id || '',
    };
  } catch (error) {
    console.error(`❌ Failed to read MemoryIndex ${memoryIndexId}:`, error);
    return null;
  }
}

/**
 * Update MemoryIndex on-chain with new blob IDs
 *
 * Call this after uploading index/graph to Walrus to update the on-chain reference.
 * Uses optimistic locking (expectedVersion must match current version).
 *
 * @param options - Update options
 * @returns Result with success status and new version
 *
 * @example
 * ```typescript
 * // First, read current state
 * const current = await getMemoryIndex({ client, memoryIndexId });
 *
 * // Then upload to Walrus and get new blob ID
 * const newBlobId = await uploadIndexToWalrus();
 *
 * // Finally, update on-chain
 * const result = await updateMemoryIndexOnChain({
 *   client,
 *   signer: keypair,
 *   packageId: process.env.PACKAGE_ID!,
 *   memoryIndexId: process.env.MEMORY_INDEX_ID!,
 *   expectedVersion: current.version,
 *   newIndexBlobId: newBlobId,
 *   newGraphBlobId: current.graphBlobId, // Keep existing if not changed
 * });
 * ```
 */
export async function updateMemoryIndexOnChain(
  options: UpdateMemoryIndexOnChainOptions
): Promise<UpdateMemoryIndexResult> {
  const {
    client,
    signer,
    packageId,
    memoryIndexId,
    expectedVersion,
    newIndexBlobId,
    newGraphBlobId,
    gasBudget = 10_000_000,
  } = options;

  try {
    console.log(`\n📝 Updating MemoryIndex on-chain...`);
    console.log(`   Object ID: ${memoryIndexId}`);
    console.log(`   Expected version: ${expectedVersion}`);
    console.log(`   New index blob: ${newIndexBlobId}`);
    console.log(`   New graph blob: ${newGraphBlobId}`);

    const tx = new Transaction();
    tx.setGasBudget(gasBudget);

    // Convert strings to vector<u8> for Move
    const newIndexBlobIdBytes = Array.from(new TextEncoder().encode(newIndexBlobId));
    const newGraphBlobIdBytes = Array.from(new TextEncoder().encode(newGraphBlobId));

    tx.moveCall({
      target: `${packageId}::memory::update_memory_index`,
      arguments: [
        tx.object(memoryIndexId),                     // &mut MemoryIndex
        tx.pure.u64(expectedVersion),                 // expected_version: u64
        tx.pure.vector('u8', newIndexBlobIdBytes),    // new_index_blob_id: vector<u8>
        tx.pure.vector('u8', newGraphBlobIdBytes),    // new_graph_blob_id: vector<u8>
      ]
    });

    const result = await client.signAndExecuteTransaction({
      transaction: tx,
      signer,
      options: {
        showEffects: true,
        showObjectChanges: true,
      },
    });

    if (result.effects?.status?.status !== 'success') {
      const error = result.effects?.status?.error || 'Unknown error';
      console.error(`❌ Transaction failed: ${error}`);
      return { success: false, error };
    }

    const newVersion = expectedVersion + 1;
    console.log(`✅ MemoryIndex updated successfully`);
    console.log(`   Transaction: ${result.digest}`);
    console.log(`   New version: ${newVersion}`);

    return {
      success: true,
      digest: result.digest,
      newVersion,
    };
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    console.error(`❌ Failed to update MemoryIndex:`, errorMsg);
    return { success: false, error: errorMsg };
  }
}

/**
 * Create a new MemoryIndex on-chain
 *
 * Use this when setting up a new wallet or if MEMORY_INDEX_ID doesn't exist.
 *
 * @param options - Creation options
 * @returns Result with created object ID
 *
 * @example
 * ```typescript
 * const result = await createMemoryIndexOnChain({
 *   client,
 *   signer: keypair,
 *   packageId: process.env.PACKAGE_ID!,
 *   indexBlobId: 'placeholder-index',
 *   graphBlobId: 'placeholder-graph',
 * });
 *
 * if (result.success) {
 *   console.log(`Created MemoryIndex: ${result.memoryIndexId}`);
 *   // Save to .env: MEMORY_INDEX_ID=${result.memoryIndexId}
 * }
 * ```
 */
export async function createMemoryIndexOnChain(
  options: CreateMemoryIndexOnChainOptions
): Promise<CreateMemoryIndexResult> {
  const {
    client,
    signer,
    packageId,
    indexBlobId,
    graphBlobId,
    gasBudget = 10_000_000,
  } = options;

  try {
    console.log(`\n📝 Creating new MemoryIndex on-chain...`);
    console.log(`   Package ID: ${packageId}`);
    console.log(`   Index blob: ${indexBlobId}`);
    console.log(`   Graph blob: ${graphBlobId}`);

    const tx = new Transaction();
    tx.setGasBudget(gasBudget);

    // Convert strings to vector<u8> for Move
    const indexBlobIdBytes = Array.from(new TextEncoder().encode(indexBlobId));
    const graphBlobIdBytes = Array.from(new TextEncoder().encode(graphBlobId));

    tx.moveCall({
      target: `${packageId}::memory::create_memory_index`,
      arguments: [
        tx.pure.vector('u8', indexBlobIdBytes),
        tx.pure.vector('u8', graphBlobIdBytes),
      ]
    });

    const result = await client.signAndExecuteTransaction({
      transaction: tx,
      signer,
      options: {
        showEffects: true,
        showObjectChanges: true,
      },
    });

    if (result.effects?.status?.status !== 'success') {
      const error = result.effects?.status?.error || 'Unknown error';
      console.error(`❌ Transaction failed: ${error}`);
      return { success: false, error };
    }

    // Find the created MemoryIndex object
    const createdObject = result.objectChanges?.find(
      (change) => change.type === 'created' && change.objectType?.includes('::memory::MemoryIndex')
    );

    if (!createdObject || createdObject.type !== 'created') {
      return { success: false, error: 'MemoryIndex object not found in transaction result' };
    }

    const memoryIndexId = createdObject.objectId;
    console.log(`✅ MemoryIndex created successfully`);
    console.log(`   Object ID: ${memoryIndexId}`);
    console.log(`   Transaction: ${result.digest}`);
    console.log(`\n   Add to .env:`);
    console.log(`   MEMORY_INDEX_ID=${memoryIndexId}`);

    return {
      success: true,
      memoryIndexId,
      digest: result.digest,
    };
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    console.error(`❌ Failed to create MemoryIndex:`, errorMsg);
    return { success: false, error: errorMsg };
  }
}

/**
 * Sync index to Walrus and update on-chain MemoryIndex
 *
 * Convenience function that combines:
 * 1. Reading current MemoryIndex state
 * 2. Uploading index to Walrus
 * 3. Updating on-chain blob ID
 *
 * @param options - Combined sync options
 * @returns Result with new blob ID and transaction digest
 */
export interface SyncAndUpdateOptions {
  client: SuiClient;
  signer: Signer;
  packageId: string;
  memoryIndexId: string;
  /** Function to upload index to Walrus, returns new blob ID */
  uploadToWalrus: () => Promise<string>;
  /** Optional: also update graph blob ID */
  newGraphBlobId?: string;
}

export interface SyncAndUpdateResult {
  success: boolean;
  newIndexBlobId?: string;
  newGraphBlobId?: string;
  digest?: string;
  newVersion?: number;
  error?: string;
}

export async function syncIndexAndUpdateOnChain(
  options: SyncAndUpdateOptions
): Promise<SyncAndUpdateResult> {
  const {
    client,
    signer,
    packageId,
    memoryIndexId,
    uploadToWalrus,
    newGraphBlobId,
  } = options;

  try {
    // Step 1: Read current state
    console.log(`\n🔍 Reading current MemoryIndex state...`);
    const current = await getMemoryIndex({ client, memoryIndexId });

    if (!current) {
      return { success: false, error: 'MemoryIndex not found on-chain' };
    }

    console.log(`   Current version: ${current.version}`);
    console.log(`   Current index blob: ${current.indexBlobId}`);

    // Step 2: Upload to Walrus
    console.log(`\n☁️ Uploading index to Walrus...`);
    const newIndexBlobId = await uploadToWalrus();
    console.log(`   New index blob: ${newIndexBlobId}`);

    // Step 3: Update on-chain
    const graphBlobId = newGraphBlobId || current.graphBlobId;
    const updateResult = await updateMemoryIndexOnChain({
      client,
      signer,
      packageId,
      memoryIndexId,
      expectedVersion: current.version,
      newIndexBlobId,
      newGraphBlobId: graphBlobId,
    });

    if (!updateResult.success) {
      return { success: false, error: updateResult.error };
    }

    return {
      success: true,
      newIndexBlobId,
      newGraphBlobId: graphBlobId,
      digest: updateResult.digest,
      newVersion: updateResult.newVersion,
    };
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    return { success: false, error: errorMsg };
  }
}

/**
 * Upload placeholder blob to Walrus
 * Used when creating initial MemoryIndex
 */
export async function uploadPlaceholderToWalrus(
  walrusPublisherUrl: string,
  type: 'index' | 'graph'
): Promise<string> {
  const content = JSON.stringify({
    type: type === 'index' ? 'hnsw-index-placeholder' : 'knowledge-graph',
    version: 1,
    created: new Date().toISOString(),
    note: type === 'index'
      ? 'Placeholder for HNSW index. Actual index synced after adding memories.'
      : 'Empty knowledge graph. Will be populated as memories are processed.',
    ...(type === 'graph' ? { nodes: [], edges: [] } : {}),
  });

  const response = await fetch(walrusPublisherUrl, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/octet-stream' },
    body: new TextEncoder().encode(content),
  });

  if (!response.ok) {
    throw new Error(`Walrus upload failed: ${response.status}`);
  }

  const result = await response.json();

  // Handle different response formats
  let blobId: string;
  if (result.newlyCreated?.blobObject?.blobId) {
    blobId = result.newlyCreated.blobObject.blobId;
  } else if (result.alreadyCertified?.blobId) {
    blobId = result.alreadyCertified.blobId;
  } else if (result.blobId) {
    blobId = result.blobId;
  } else {
    throw new Error('Could not extract blobId from Walrus response');
  }

  return blobId;
}
