/**
 * WalrusStorageManager - Core Walrus Storage Operations
 *
 * Handles blob upload/download using the Walrus distributed storage network.
 * Extracted from StorageService for better separation of concerns.
 *
 * Features:
 * - writeBlobFlow() for single blob uploads
 * - Upload relay support (preferred on testnet)
 * - Content integrity via blob_id
 * - Direct blob retrieval from Walrus
 *
 * Performance: ~10-13 seconds per upload on testnet
 */

import { SuiClient, getFullnodeUrl } from '@mysten/sui/client';
import { WalrusClient } from '@mysten/walrus';
import type { ClientWithExtensions } from '@mysten/sui/experimental';
import type { UnifiedSigner } from '../../client/signers/UnifiedSigner';

export interface WalrusStorageConfig {
  suiClient?: SuiClient;
  network?: 'testnet' | 'mainnet';
  maxFileSize?: number;
  timeout?: number;
  useUploadRelay?: boolean;
  epochs?: number;
}

export interface BlobUploadOptions {
  signer: UnifiedSigner;
  epochs?: number;
  deletable?: boolean;
  useUploadRelay?: boolean;
  encrypt?: boolean;
  metadata?: Record<string, string>;
}

export interface WalrusUploadResult {
  blobId: string;
  blobObjectId?: string;
  isEncrypted: boolean;
  storageEpochs: number;
  uploadTimeMs: number;
  contentSize: number;
}

export interface WalrusRetrievalResult {
  content: Uint8Array;
  source: 'walrus';
  retrievalTime: number;
  blobSize: number;
}

/**
 * WalrusStorageManager - Manages core Walrus storage operations
 *
 * Handles all low-level Walrus interactions including:
 * - Client creation and configuration
 * - Blob upload via writeBlobFlow
 * - Blob retrieval from distributed storage
 */
export class WalrusStorageManager {
  private suiClient: ClientWithExtensions<{ jsonRpc: SuiClient; walrus: WalrusClient }>;
  private walrusWithRelay: WalrusClient;
  private walrusWithoutRelay: WalrusClient;
  private config: WalrusStorageConfig;

  constructor(config: WalrusStorageConfig) {
    this.config = config;

    // Setup clients synchronously
    const clients = this.createClients();
    this.suiClient = clients.suiClient;
    this.walrusWithRelay = clients.walrusWithRelay;
    this.walrusWithoutRelay = clients.walrusWithoutRelay;
  }

  /**
   * Create Walrus clients with upload relay support
   */
  private createClients() {
    const network = this.config.network || 'testnet';
    const baseClient = this.config.suiClient || new SuiClient({
      url: getFullnodeUrl(network),
      network: network,
    });

    const uploadRelayHost = network === 'mainnet'
      ? 'https://upload-relay.mainnet.walrus.space'
      : 'https://upload-relay.testnet.walrus.space';

    // Client with upload relay (preferred)
    const clientWithRelay = baseClient.$extend(
      WalrusClient.experimental_asClientExtension({
        network: network,
        uploadRelay: {
          host: uploadRelayHost,
          sendTip: { max: 1_000 },
          timeout: 60_000,
        },
        storageNodeClientOptions: {
          timeout: 60_000,
        },
      })
    );

    // Client without upload relay (fallback)
    const clientWithoutRelay = baseClient.$extend(
      WalrusClient.experimental_asClientExtension({
        network: network,
        storageNodeClientOptions: {
          timeout: 60_000,
        },
      })
    );

    return {
      suiClient: clientWithRelay,
      walrusWithRelay: clientWithRelay.walrus,
      walrusWithoutRelay: clientWithoutRelay.walrus,
    };
  }

  /**
   * Upload blob using writeBlobFlow pattern
   *
   * This is the core upload method for single blobs.
   * Uses the official Walrus writeBlobFlow: encode → register → upload → certify
   *
   * @param data - Blob data as Uint8Array
   * @param options - Upload options including signer and metadata
   * @returns Upload result with blob ID and timing
   */
  async uploadBlob(
    data: Uint8Array,
    options: BlobUploadOptions
  ): Promise<WalrusUploadResult> {
    const startTime = performance.now();

    try {
      // Select client based on upload relay preference
      const walrusClient = (options.useUploadRelay ?? this.config.useUploadRelay ?? true)
        ? this.walrusWithRelay
        : this.walrusWithoutRelay;

      // Detect SEAL encryption from metadata
      const isSealEncrypted = !!(
        options.metadata?.['encryption-type']?.includes('seal') &&
        options.metadata?.['encrypted'] === 'true'
      );

      if (isSealEncrypted) {
        console.log(`🔐 Uploading SEAL encrypted binary data (${data.length} bytes)`);
      }

      // Create writeBlobFlow
      const flow = walrusClient.writeBlobFlow({ blob: data });

      // Step 1: Encode blob
      await flow.encode();

      // Get signer address
      const signerAddress = options.signer.getAddress();

      // Step 2: Register blob on-chain
      const registerTx = flow.register({
        epochs: options.epochs || this.config.epochs || 3,
        deletable: options.deletable ?? true,
        owner: signerAddress,
      });

      registerTx.setSender(signerAddress);
      const { digest: registerDigest } = await options.signer.signAndExecuteTransaction(registerTx);

      // Step 3: Upload to storage
      await flow.upload({ digest: registerDigest });

      // Step 4: Certify blob on-chain
      const certifyTx = flow.certify();
      certifyTx.setSender(signerAddress);
      await options.signer.signAndExecuteTransaction(certifyTx);

      // Get blob info
      const blob = await flow.getBlob();
      const uploadTimeMs = performance.now() - startTime;

      console.log(`✅ Blob uploaded successfully`);
      console.log(`   Blob ID: ${blob.blobId}`);
      console.log(`   Size: ${data.length} bytes`);
      console.log(`   Upload time: ${uploadTimeMs.toFixed(1)}ms`);

      return {
        blobId: blob.blobId,
        blobObjectId: blob.blobObject?.id?.id,
        isEncrypted: isSealEncrypted,
        storageEpochs: options.epochs || this.config.epochs || 3,
        uploadTimeMs,
        contentSize: data.length,
      };

    } catch (error) {
      throw new Error(`Blob upload failed: ${error}`);
    }
  }

  /**
   * Retrieve blob by ID from Walrus
   *
   * @param blobId - The Walrus blob ID
   * @returns Blob content as Uint8Array
   */
  async getBlob(blobId: string): Promise<Uint8Array> {
    try {
      console.log(`📥 Retrieving blob ${blobId} from Walrus...`);
      const content = await this.suiClient.walrus.readBlob({ blobId });
      console.log(`✅ Retrieved ${content.length} bytes from Walrus`);
      return content;
    } catch (error) {
      console.error(`❌ Failed to retrieve blob ${blobId}:`, error);
      throw new Error(`Failed to retrieve blob ${blobId}: ${error}`);
    }
  }

  /**
   * Retrieve blob with detailed timing and metadata
   *
   * @param blobId - The Walrus blob ID
   * @returns Retrieval result with timing information
   */
  async retrieveBlob(blobId: string): Promise<WalrusRetrievalResult> {
    const startTime = Date.now();

    try {
      console.log(`🔄 WALRUS RETRIEVAL: ${blobId}`);

      const content = await this.suiClient.walrus.readBlob({ blobId });
      const retrievalTime = Date.now() - startTime;

      console.log(`✅ WALRUS RETRIEVAL SUCCESS:`);
      console.log(`   Blob ID: ${blobId}`);
      console.log(`   Content size: ${content.length} bytes`);
      console.log(`   Retrieval time: ${retrievalTime}ms`);

      return {
        content,
        source: 'walrus' as const,
        retrievalTime,
        blobSize: content.length
      };

    } catch (error) {
      const retrievalTime = Date.now() - startTime;
      console.error(`❌ WALRUS RETRIEVAL FAILED:`);
      console.error(`   Blob ID: ${blobId}`);
      console.error(`   Time elapsed: ${retrievalTime}ms`);

      throw new Error(`Walrus retrieval failed for ${blobId}: ${error}`);
    }
  }

  /**
   * Get Walrus client (with or without relay)
   */
  getWalrusClient(useRelay: boolean = true): WalrusClient {
    return useRelay ? this.walrusWithRelay : this.walrusWithoutRelay;
  }

  /**
   * Get Sui client with Walrus extension
   */
  getSuiClient(): ClientWithExtensions<{ jsonRpc: SuiClient; walrus: WalrusClient }> {
    return this.suiClient;
  }

  /**
   * Get storage statistics
   */
  getStats() {
    return {
      network: this.config.network || 'testnet',
      useUploadRelay: this.config.useUploadRelay ?? true,
      epochs: this.config.epochs || 3,
      maxFileSize: this.config.maxFileSize || Number.MAX_SAFE_INTEGER,
    };
  }
}
