/**
 * BlobAttributesManager - Sui Dynamic Field Operations for Blob Objects
 *
 * Handles mutable on-chain metadata via Sui dynamic fields.
 * Extracted from StorageService for better separation of concerns.
 *
 * Features:
 * - Set/get/update/remove dynamic fields
 * - On-chain indexing and querying
 * - Mutable metadata (unlike Walrus blob content)
 * - Query by attribute filters
 */

import type { SuiClient } from '@mysten/sui/client';
import type { Signer } from '@mysten/sui/cryptography';
import { Transaction } from '@mysten/sui/transactions';

export interface BlobQueryResult {
  blobObjectId: string;
  blobId: string;
  attributes: Record<string, string>;
}

/**
 * BlobAttributesManager - Manages Sui dynamic fields on Blob objects
 *
 * Dynamic fields enable:
 * - Mutable on-chain metadata
 * - Query/filter by attributes
 * - Indexed searchability
 * - No re-upload needed for metadata changes
 */
export class BlobAttributesManager {
  constructor(private suiClient: SuiClient) {}

  /**
   * Set attributes on a Walrus Blob object
   *
   * Adds dynamic fields to the Sui Blob object for:
   * - On-chain metadata indexing
   * - Queryable attributes
   * - Mutable metadata
   */
  async setBlobAttributes(
    blobObjectId: string,
    attributes: Record<string, string>,
    signer: Signer
  ): Promise<string> {
    try {
      console.log(`🏷️  Setting ${Object.keys(attributes).length} attributes on blob ${blobObjectId.slice(0, 10)}...`);

      const tx = new Transaction();

      // Add each attribute as a dynamic field
      for (const [key, value] of Object.entries(attributes)) {
        tx.moveCall({
          target: '0x2::dynamic_field::add',
          arguments: [
            tx.object(blobObjectId),
            tx.pure.string(key),
            tx.pure.string(value),
          ],
          typeArguments: [
            '0x1::string::String',
            '0x1::string::String',
          ],
        });

        console.log(`   ✓ ${key}: ${value.slice(0, 50)}${value.length > 50 ? '...' : ''}`);
      }

      tx.setSender(signer.toSuiAddress());

      const result = await signer.signAndExecuteTransaction({
        transaction: tx,
        client: this.suiClient,
      });

      console.log(`✅ Attributes set successfully!`);
      console.log(`   Transaction: ${result.digest}`);

      return result.digest;

    } catch (error) {
      console.error(`❌ Failed to set blob attributes:`, error);
      throw new Error(`Failed to set blob attributes: ${error}`);
    }
  }

  /**
   * Get attributes from a Walrus Blob object
   */
  async getBlobAttributes(
    blobObjectId: string,
    attributeKeys?: string[]
  ): Promise<Record<string, string>> {
    try {
      console.log(`🔍 Fetching attributes from blob ${blobObjectId.slice(0, 10)}...`);

      const attributes: Record<string, string> = {};

      // Get the object
      const object = await this.suiClient.getObject({
        id: blobObjectId,
        options: {
          showContent: true,
          showOwner: true,
        },
      });

      if (!object.data) {
        throw new Error(`Blob object not found: ${blobObjectId}`);
      }

      // Get dynamic fields
      const dynamicFields = await this.suiClient.getDynamicFields({
        parentId: blobObjectId,
      });

      console.log(`   Found ${dynamicFields.data.length} dynamic fields`);

      // Fetch each dynamic field value
      for (const field of dynamicFields.data) {
        const fieldName = field.name.value as string;

        // Skip if filtering and this field isn't in the list
        if (attributeKeys && !attributeKeys.includes(fieldName)) {
          continue;
        }

        try {
          const fieldData = await this.suiClient.getDynamicFieldObject({
            parentId: blobObjectId,
            name: {
              type: '0x1::string::String',
              value: fieldName,
            },
          });

          if (fieldData.data?.content?.dataType === 'moveObject') {
            const value = (fieldData.data.content as any).fields.value;
            attributes[fieldName] = value;
            console.log(`   ✓ ${fieldName}: ${value.slice(0, 50)}${value.length > 50 ? '...' : ''}`);
          }
        } catch (err) {
          console.warn(`   ⚠️  Could not fetch field ${fieldName}:`, err);
        }
      }

      console.log(`✅ Retrieved ${Object.keys(attributes).length} attributes`);

      return attributes;

    } catch (error) {
      console.error(`❌ Failed to get blob attributes:`, error);
      throw new Error(`Failed to get blob attributes: ${error}`);
    }
  }

  /**
   * Update blob attributes (replaces existing values)
   */
  async updateBlobAttributes(
    blobObjectId: string,
    attributes: Record<string, string>,
    signer: Signer
  ): Promise<string> {
    try {
      console.log(`📝 Updating ${Object.keys(attributes).length} attributes on blob ${blobObjectId.slice(0, 10)}...`);

      const tx = new Transaction();

      // For each attribute, remove old value and add new value
      for (const [key, value] of Object.entries(attributes)) {
        // Remove existing field (if it exists)
        tx.moveCall({
          target: '0x2::dynamic_field::remove_if_exists',
          arguments: [
            tx.object(blobObjectId),
            tx.pure.string(key),
          ],
          typeArguments: [
            '0x1::string::String',
            '0x1::string::String',
          ],
        });

        // Add new field
        tx.moveCall({
          target: '0x2::dynamic_field::add',
          arguments: [
            tx.object(blobObjectId),
            tx.pure.string(key),
            tx.pure.string(value),
          ],
          typeArguments: [
            '0x1::string::String',
            '0x1::string::String',
          ],
        });

        console.log(`   ✓ Updated ${key}: ${value.slice(0, 50)}${value.length > 50 ? '...' : ''}`);
      }

      tx.setSender(signer.toSuiAddress());

      const result = await signer.signAndExecuteTransaction({
        transaction: tx,
        client: this.suiClient,
      });

      console.log(`✅ Attributes updated successfully!`);
      console.log(`   Transaction: ${result.digest}`);

      return result.digest;

    } catch (error) {
      console.error(`❌ Failed to update blob attributes:`, error);
      throw new Error(`Failed to update blob attributes: ${error}`);
    }
  }

  /**
   * Remove specific attributes from a blob
   */
  async removeBlobAttributes(
    blobObjectId: string,
    attributeKeys: string[],
    signer: Signer
  ): Promise<string> {
    try {
      console.log(`🗑️  Removing ${attributeKeys.length} attributes from blob ${blobObjectId.slice(0, 10)}...`);

      const tx = new Transaction();

      for (const key of attributeKeys) {
        tx.moveCall({
          target: '0x2::dynamic_field::remove_if_exists',
          arguments: [
            tx.object(blobObjectId),
            tx.pure.string(key),
          ],
          typeArguments: [
            '0x1::string::String',
            '0x1::string::String',
          ],
        });

        console.log(`   ✓ Removed ${key}`);
      }

      tx.setSender(signer.toSuiAddress());

      const result = await signer.signAndExecuteTransaction({
        transaction: tx,
        client: this.suiClient,
      });

      console.log(`✅ Attributes removed successfully!`);
      console.log(`   Transaction: ${result.digest}`);

      return result.digest;

    } catch (error) {
      console.error(`❌ Failed to remove blob attributes:`, error);
      throw new Error(`Failed to remove blob attributes: ${error}`);
    }
  }

  /**
   * Query memories by attributes
   *
   * Finds all Blob objects with specific attribute values
   */
  async queryMemoriesByAttributes(
    filters: Record<string, string>,
    owner: string,
    walrusPackageId: string
  ): Promise<BlobQueryResult[]> {
    try {
      console.log(`🔍 Querying memories with filters:`, filters);

      const results: BlobQueryResult[] = [];

      // Get all Blob objects owned by user
      const ownedObjects = await this.suiClient.getOwnedObjects({
        owner,
        filter: {
          StructType: `${walrusPackageId}::blob::Blob`,
        },
        options: {
          showContent: true,
          showType: true,
        },
      });

      console.log(`   Found ${ownedObjects.data.length} blob objects`);

      // Filter by attributes
      for (const obj of ownedObjects.data) {
        if (!obj.data?.objectId) continue;

        try {
          // Get attributes for this blob
          const attributes = await this.getBlobAttributes(
            obj.data.objectId,
            Object.keys(filters)
          );

          // Check if all filters match
          const matches = Object.entries(filters).every(
            ([key, value]) => attributes[key] === value
          );

          if (matches) {
            // Extract blob ID from content
            const content = obj.data.content as any;
            const blobId = content?.fields?.blob_id;

            results.push({
              blobObjectId: obj.data.objectId,
              blobId,
              attributes,
            });

            console.log(`   ✓ Match: ${obj.data.objectId.slice(0, 10)}...`);
          }
        } catch (err) {
          console.warn(`   ⚠️  Error checking ${obj.data.objectId}:`, err);
        }
      }

      console.log(`✅ Found ${results.length} matching memories`);

      return results;

    } catch (error) {
      console.error(`❌ Failed to query memories:`, error);
      throw new Error(`Failed to query memories: ${error}`);
    }
  }
}
