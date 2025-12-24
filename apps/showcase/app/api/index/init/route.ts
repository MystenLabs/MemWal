import { NextRequest } from 'next/server';
import { SuiClient, getFullnodeUrl } from '@mysten/sui/client';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { decodeSuiPrivateKey } from '@mysten/sui/cryptography';
import {
  createMemoryIndexOnChain,
  getMemoryIndex,
  uploadPlaceholderToWalrus
} from '@cmdoss/memwal-sdk';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * POST /api/index/init
 * Initialize MemoryIndex on-chain (if not exists)
 *
 * This endpoint:
 * 1. Checks if MEMORY_INDEX_ID env var points to an existing MemoryIndex
 * 2. If not found, checks if user already has a MemoryIndex on-chain
 * 3. If no existing MemoryIndex, creates new one with placeholder blobs
 *
 * Environment variables required:
 * - PACKAGE_ID: PDW smart contract package ID
 * - SUI_PRIVATE_KEY: Private key for signing the creation transaction
 * - WALRUS_PUBLISHER: Walrus publisher URL for uploading placeholders
 *
 * Optional:
 * - MEMORY_INDEX_ID: If set, will validate it exists on-chain
 *
 * Body: {
 *   walletAddress: string,
 *   force?: boolean  // If true, create new even if one exists
 * }
 *
 * Returns:
 * - memoryIndexId: Sui object ID of the MemoryIndex
 * - indexBlobId: Initial Walrus blob ID for index
 * - graphBlobId: Initial Walrus blob ID for graph
 * - created: Whether a new one was created or existing found
 */
export async function POST(req: NextRequest) {
  const startTime = Date.now();

  try {
    const { walletAddress, force = false } = await req.json();

    if (!walletAddress) {
      return new Response(JSON.stringify({
        success: false,
        error: 'walletAddress is required'
      }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    // Check required env variables
    const packageId = process.env.PACKAGE_ID;
    const privateKey = process.env.SUI_PRIVATE_KEY;
    const walrusPublisher = process.env.WALRUS_PUBLISHER ||
      process.env.NEXT_PUBLIC_WALRUS_PUBLISHER ||
      'https://publisher.walrus-testnet.walrus.space/v1/blobs';
    const network = (process.env.SUI_NETWORK as 'testnet' | 'mainnet') || 'testnet';
    const existingMemoryIndexId = process.env.MEMORY_INDEX_ID;

    if (!packageId || !privateKey) {
      return new Response(JSON.stringify({
        success: false,
        error: 'PACKAGE_ID and SUI_PRIVATE_KEY environment variables are required'
      }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    console.log(`\n${'='.repeat(70)}`);
    console.log(`🚀 [/api/index/init] INITIALIZE MEMORY INDEX`);
    console.log(`${'='.repeat(70)}`);
    console.log(`📍 Wallet: ${walletAddress}`);
    console.log(`📍 Package: ${packageId}`);
    console.log(`📍 Existing MEMORY_INDEX_ID: ${existingMemoryIndexId || 'not set'}`);

    // Create Sui client and keypair
    const client = new SuiClient({ url: getFullnodeUrl(network) });
    const { secretKey } = decodeSuiPrivateKey(privateKey);
    const keypair = Ed25519Keypair.fromSecretKey(secretKey);
    const signerAddress = keypair.toSuiAddress();

    console.log(`📍 Signer: ${signerAddress}`);

    // Step 1: Check if MEMORY_INDEX_ID exists on-chain
    if (existingMemoryIndexId && !force) {
      console.log('\n🔍 Step 1: Checking existing MEMORY_INDEX_ID...');
      const existing = await getMemoryIndex({ client, memoryIndexId: existingMemoryIndexId });

      if (existing) {
        console.log(`   ✅ Found existing MemoryIndex`);
        console.log(`   Version: ${existing.version}`);
        console.log(`   Index Blob: ${existing.indexBlobId}`);
        console.log(`   Graph Blob: ${existing.graphBlobId}`);

        const duration = Date.now() - startTime;
        return new Response(JSON.stringify({
          success: true,
          message: 'Using existing MemoryIndex from MEMORY_INDEX_ID',
          data: {
            memoryIndexId: existingMemoryIndexId,
            indexBlobId: existing.indexBlobId,
            graphBlobId: existing.graphBlobId,
            version: existing.version,
            created: false,
            duration,
            envVars: {
              MEMORY_INDEX_ID: existingMemoryIndexId,
              INDEX_BLOB_ID: existing.indexBlobId,
              GRAPH_BLOB_ID: existing.graphBlobId,
            }
          }
        }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' }
        });
      }

      console.log(`   ⚠️ MEMORY_INDEX_ID not found on-chain, will check owned objects`);
    }

    // Step 2: Check if user already has a MemoryIndex
    if (!force) {
      console.log('\n🔍 Step 2: Checking for existing MemoryIndex owned by user...');
      const ownedObjects = await client.getOwnedObjects({
        owner: signerAddress,
        filter: {
          StructType: `${packageId}::memory::MemoryIndex`,
        },
        options: {
          showContent: true,
        }
      });

      if (ownedObjects.data.length > 0) {
        const existingObject = ownedObjects.data[0];
        const objectId = existingObject.data?.objectId;

        if (objectId) {
          const fields = (existingObject.data?.content as any)?.fields;
          const version = Number(fields?.version || 1);
          const indexBlobId = fields?.index_blob_id || '';
          const graphBlobId = fields?.graph_blob_id || '';

          console.log(`   ✅ Found existing MemoryIndex owned by user`);
          console.log(`   Object ID: ${objectId}`);
          console.log(`   Version: ${version}`);

          const duration = Date.now() - startTime;
          return new Response(JSON.stringify({
            success: true,
            message: 'Found existing MemoryIndex owned by user',
            data: {
              memoryIndexId: objectId,
              indexBlobId,
              graphBlobId,
              version,
              created: false,
              duration,
              envVars: {
                MEMORY_INDEX_ID: objectId,
                INDEX_BLOB_ID: indexBlobId,
                GRAPH_BLOB_ID: graphBlobId,
              }
            }
          }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' }
          });
        }
      }

      console.log(`   No existing MemoryIndex found`);
    }

    // Step 3: Create placeholder blobs on Walrus
    console.log('\n📤 Step 3: Uploading placeholder blobs to Walrus...');

    const indexBlobId = await uploadPlaceholderToWalrus(walrusPublisher, 'index');
    console.log(`   Index placeholder: ${indexBlobId}`);

    const graphBlobId = await uploadPlaceholderToWalrus(walrusPublisher, 'graph');
    console.log(`   Graph placeholder: ${graphBlobId}`);

    // Step 4: Create MemoryIndex on-chain
    console.log('\n⛓️ Step 4: Creating MemoryIndex on-chain...');

    const createResult = await createMemoryIndexOnChain({
      client,
      signer: keypair,
      packageId,
      indexBlobId,
      graphBlobId,
    });

    if (!createResult.success) {
      return new Response(JSON.stringify({
        success: false,
        error: `Failed to create MemoryIndex: ${createResult.error}`
      }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    const memoryIndexId = createResult.memoryIndexId!;

    const duration = Date.now() - startTime;
    console.log(`\n✅ MemoryIndex initialized in ${(duration / 1000).toFixed(2)}s`);
    console.log(`${'='.repeat(70)}`);
    console.log(`\n📋 Add these to your .env file:`);
    console.log(`   MEMORY_INDEX_ID=${memoryIndexId}`);
    console.log(`   INDEX_BLOB_ID=${indexBlobId}`);
    console.log(`   GRAPH_BLOB_ID=${graphBlobId}`);
    console.log(`${'='.repeat(70)}\n`);

    return new Response(JSON.stringify({
      success: true,
      message: 'MemoryIndex created successfully',
      data: {
        memoryIndexId,
        indexBlobId,
        graphBlobId,
        version: 1,
        created: true,
        txDigest: createResult.digest,
        duration,
        envVars: {
          MEMORY_INDEX_ID: memoryIndexId,
          INDEX_BLOB_ID: indexBlobId,
          GRAPH_BLOB_ID: graphBlobId,
        }
      }
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });

  } catch (error) {
    console.error('❌ Index init API error:', error);
    return new Response(JSON.stringify({
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error'
    }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
}

/**
 * GET /api/index/init
 * Get current MemoryIndex configuration status
 */
export async function GET(req: NextRequest) {
  try {
    const memoryIndexId = process.env.MEMORY_INDEX_ID;
    const packageId = process.env.PACKAGE_ID;
    const hasPrivateKey = !!process.env.SUI_PRIVATE_KEY;
    const network = (process.env.SUI_NETWORK as 'testnet' | 'mainnet') || 'testnet';

    const config = {
      memoryIndexId: memoryIndexId || null,
      packageId: packageId || null,
      hasPrivateKey,
      network,
      configured: !!(memoryIndexId && packageId && hasPrivateKey),
    };

    // If MEMORY_INDEX_ID is set, try to read it from chain
    let onChainData = null;
    if (memoryIndexId && packageId) {
      try {
        const client = new SuiClient({ url: getFullnodeUrl(network) });
        const memoryIndex = await getMemoryIndex({ client, memoryIndexId });

        if (memoryIndex) {
          onChainData = {
            objectId: memoryIndex.objectId,
            owner: memoryIndex.owner,
            version: memoryIndex.version,
            indexBlobId: memoryIndex.indexBlobId,
            graphBlobId: memoryIndex.graphBlobId,
          };
        }
      } catch (err) {
        console.warn('Failed to read MemoryIndex from chain:', err);
      }
    }

    return new Response(JSON.stringify({
      success: true,
      data: {
        config,
        onChain: onChainData,
      }
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });

  } catch (error) {
    console.error('❌ Get config error:', error);
    return new Response(JSON.stringify({
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error'
    }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
}
