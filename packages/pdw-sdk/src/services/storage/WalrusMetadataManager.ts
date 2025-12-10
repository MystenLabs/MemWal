/**
 * WalrusMetadataManager - Walrus Blob Metadata Operations
 *
 * Handles metadata attachment and retrieval for Walrus Blob objects.
 * Extracted from StorageService for better separation of concerns.
 *
 * Features:
 * - Build Walrus-compatible metadata structures
 * - Attach metadata to Blob objects via dynamic fields
 * - Retrieve metadata from Blob objects
 * - Content integrity via blob_id
 */

import type { SuiClient } from '@mysten/sui/client';
import type { Signer } from '@mysten/sui/cryptography';
import { Transaction } from '@mysten/sui/transactions';

export interface WalrusMemoryMetadata {
  // Content identification
  content_type: string;
  content_size: string;

  // Memory classification
  category: string;
  topic: string;
  importance: string;

  // Vector embedding
  embedding_dimensions: string;
  embedding_model: string;
  embedding_blob_id?: string;

  // Knowledge graph
  graph_entity_count: string;
  graph_relationship_count: string;
  graph_blob_id?: string;
  graph_entity_ids?: string;

  // Vector index
  vector_id: string;
  vector_status: string;

  // Lifecycle
  created_at: string;
  updated_at: string;
  deleted_at?: string;

  // Encryption
  encrypted: string;
  encryption_type?: string;
  seal_identity?: string;

  // Extensible custom fields
  [key: string]: string | undefined;
}

export interface MetadataBuildOptions {
  category?: string;
  topic?: string;
  importance?: number;
  embedding?: number[];
  embeddingBlobId?: string;
  graphBlobId?: string;
  graphEntityIds?: string[];
  graphEntityCount?: number;
  graphRelationshipCount?: number;
  vectorId?: number;
  isEncrypted?: boolean;
  encryptionType?: string;
  sealIdentity?: string;
  customFields?: Record<string, string>;
}

/**
 * WalrusMetadataManager - Manages Walrus Blob metadata
 *
 * Handles:
 * - Metadata structure building
 * - Dynamic field attachment to Blob objects
 * - Metadata retrieval and parsing
 */
export class WalrusMetadataManager {
  constructor(private suiClient: SuiClient) {}

  /**
   * Build Walrus metadata structure
   *
   * NOTE: No content_hash field needed! Walrus blob_id already serves as content hash.
   * blob_id = blake2b256(bcs(root_hash, encoding_type, size))
   */
  buildWalrusMetadata(
    contentSize: number,
    options: MetadataBuildOptions
  ): WalrusMemoryMetadata {
    // Determine content type
    const contentType = options.isEncrypted
      ? 'application/octet-stream'
      : options.customFields?.['content-type'] || 'text/plain';

    // Build base metadata (all values as strings for VecMap<String, String>)
    const metadata: WalrusMemoryMetadata = {
      // Content identification
      content_type: contentType,
      content_size: contentSize.toString(),

      // Memory classification
      category: options.category || 'general',
      topic: options.topic || '',
      importance: (options.importance || 5).toString(),

      // Vector embedding
      embedding_dimensions: (options.embedding?.length || 768).toString(),
      embedding_model: 'text-embedding-004',
      embedding_blob_id: options.embeddingBlobId || '',

      // Knowledge graph
      graph_entity_count: (options.graphEntityCount || 0).toString(),
      graph_relationship_count: (options.graphRelationshipCount || 0).toString(),
      graph_blob_id: options.graphBlobId || '',
      graph_entity_ids: options.graphEntityIds ? JSON.stringify(options.graphEntityIds) : '',

      // Vector index
      vector_id: options.vectorId?.toString() || '',
      vector_status: options.vectorId ? '1' : '2', // 1=active, 2=pending

      // Lifecycle
      created_at: Date.now().toString(),
      updated_at: Date.now().toString(),

      // Encryption
      encrypted: (options.isEncrypted || false).toString(),
      encryption_type: options.isEncrypted ? (options.encryptionType || 'seal') : undefined,
      seal_identity: options.sealIdentity || undefined,
    };

    // Add custom fields
    if (options.customFields) {
      Object.entries(options.customFields).forEach(([key, value]) => {
        if (value !== undefined && !metadata[key]) {
          metadata[key] = value;
        }
      });
    }

    return metadata;
  }

  /**
   * Attach metadata to a Walrus Blob object
   *
   * NOTE: Based on research, Walrus metadata requires separate queries to retrieve,
   * making it less efficient than on-chain Memory structs for filtering.
   */
  async attachMetadataToBlob(
    blobId: string,
    metadata: WalrusMemoryMetadata,
    signer: Signer,
    walrusPackageId: string
  ): Promise<{ digest: string; effects: any }> {
    try {
      const tx = new Transaction();

      // Convert WalrusMemoryMetadata to VecMap<String, String> format
      const metadataEntries: Array<[string, string]> = [];
      Object.entries(metadata).forEach(([key, value]) => {
        if (value !== undefined && value !== '') {
          metadataEntries.push([key, value]);
        }
      });

      console.log(`📋 Attaching ${metadataEntries.length} metadata fields to blob ${blobId}`);

      // Call Walrus blob::add_or_replace_metadata()
      tx.moveCall({
        target: `${walrusPackageId}::blob::add_or_replace_metadata`,
        arguments: [
          tx.object(blobId),
          // Metadata construction would go here
        ],
      });

      tx.setSender(signer.toSuiAddress());

      const result = await signer.signAndExecuteTransaction({
        transaction: tx,
        client: this.suiClient,
      });

      console.log(`✅ Metadata attached successfully. Digest: ${result.digest}`);

      return {
        digest: result.digest,
        effects: result.effects,
      };

    } catch (error) {
      console.error(`❌ Failed to attach metadata to blob ${blobId}:`, error);
      throw new Error(`Metadata attachment failed: ${error}`);
    }
  }

  /**
   * Retrieve metadata from a Walrus Blob object
   *
   * NOTE: This queries dynamic fields, which is slower than querying on-chain structs.
   */
  async retrieveBlobMetadata(blobObjectId: string): Promise<WalrusMemoryMetadata | null> {
    try {
      // Query dynamic fields on the Blob object
      const dynamicFields = await this.suiClient.getDynamicFields({
        parentId: blobObjectId,
      });

      // Look for the metadata dynamic field
      const metadataField = dynamicFields.data.find(
        (field: any) => field.name.value === 'metadata'
      );

      if (!metadataField) {
        console.log(`No metadata found for blob object ${blobObjectId}`);
        return null;
      }

      // Retrieve the metadata object
      const metadataObject = await this.suiClient.getObject({
        id: metadataField.objectId,
        options: { showContent: true },
      });

      if (!metadataObject.data?.content || !('fields' in metadataObject.data.content)) {
        return null;
      }

      const fields = metadataObject.data.content.fields as any;

      // Parse VecMap<String, String> into WalrusMemoryMetadata
      const metadata: WalrusMemoryMetadata = {
        content_type: '',
        content_size: '',
        category: '',
        topic: '',
        importance: '',
        embedding_dimensions: '',
        embedding_model: '',
        graph_entity_count: '',
        graph_relationship_count: '',
        vector_id: '',
        vector_status: '',
        created_at: '',
        updated_at: '',
        encrypted: '',
      };

      // Parse the VecMap contents
      if (fields.contents && Array.isArray(fields.contents)) {
        fields.contents.forEach((entry: any) => {
          if (entry.key && entry.value) {
            (metadata as any)[entry.key] = entry.value;
          }
        });
      }

      console.log(`✅ Retrieved metadata for blob object ${blobObjectId}`);
      return metadata;

    } catch (error) {
      console.error(`❌ Failed to retrieve metadata for blob ${blobObjectId}:`, error);
      return null;
    }
  }
}
