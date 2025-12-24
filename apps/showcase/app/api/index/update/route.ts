import { NextRequest } from 'next/server';
import { getReadOnlyPDWClient } from '@/lib/pdw-read-only';
import { SuiClient, getFullnodeUrl } from '@mysten/sui/client';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { decodeSuiPrivateKey } from '@mysten/sui/cryptography';
import {
  getMemoryIndex,
  updateMemoryIndexOnChain
} from '@cmdoss/memwal-sdk';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * POST /api/index/update
 * Sync local HNSW index to Walrus AND update on-chain MemoryIndex
 *
 * This endpoint:
 * 1. Uploads local index to Walrus (gets new blobId)
 * 2. Updates the on-chain MemoryIndex with the new INDEX_BLOB_ID
 *
 * Environment variables required:
 * - MEMORY_INDEX_ID: Sui object ID of the MemoryIndex
 * - PACKAGE_ID: PDW smart contract package ID
 * - SUI_PRIVATE_KEY: Private key for signing the update transaction
 *
 * Body: {
 *   walletAddress: string,
 *   graphBlobId?: string  // Optional: also update graph blob ID
 * }
 *
 * Returns:
 * - newIndexBlobId: New Walrus blob ID for the index
 * - newGraphBlobId: Graph blob ID (updated or existing)
 * - onChainUpdated: Whether on-chain update was successful
 * - newVersion: New version of MemoryIndex after update
 */
export async function POST(req: NextRequest) {
  const startTime = Date.now();

  try {
    const { walletAddress, graphBlobId } = await req.json();

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
    const memoryIndexId = process.env.MEMORY_INDEX_ID;
    const packageId = process.env.PACKAGE_ID;
    const privateKey = process.env.SUI_PRIVATE_KEY;
    const network = (process.env.SUI_NETWORK as 'testnet' | 'mainnet') || 'testnet';

    if (!memoryIndexId || !packageId || !privateKey) {
      console.warn('⚠️ Missing env variables for on-chain update');
      console.warn(`   MEMORY_INDEX_ID: ${memoryIndexId ? 'set' : 'missing'}`);
      console.warn(`   PACKAGE_ID: ${packageId ? 'set' : 'missing'}`);
      console.warn(`   SUI_PRIVATE_KEY: ${privateKey ? 'set' : 'missing'}`);
    }

    console.log(`\n${'='.repeat(70)}`);
    console.log(`🔄 [/api/index/update] SYNC INDEX AND UPDATE ON-CHAIN`);
    console.log(`${'='.repeat(70)}`);
    console.log(`📍 Wallet: ${walletAddress}`);
    console.log(`📍 Memory Index ID: ${memoryIndexId || 'not set'}`);

    // Get PDW client
    const pdw = await getReadOnlyPDWClient(walletAddress);

    // Check if Walrus backup is enabled
    if (!pdw.index.isWalrusEnabled()) {
      return new Response(JSON.stringify({
        success: false,
        error: 'Walrus backup is not enabled. Configure indexBackup in client settings.'
      }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    // Step 1: Sync index to Walrus
    console.log('\n📤 Step 1: Uploading index to Walrus...');
    const newIndexBlobId = await pdw.index.syncToWalrus(walletAddress);

    if (!newIndexBlobId) {
      return new Response(JSON.stringify({
        success: false,
        error: 'Failed to sync index to Walrus'
      }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    console.log(`   ✅ Index uploaded: ${newIndexBlobId}`);

    // Step 2: Update on-chain MemoryIndex (if configured)
    let onChainUpdated = false;
    let newVersion: number | undefined;
    let txDigest: string | undefined;
    let newGraphBlobId = graphBlobId;

    if (memoryIndexId && packageId && privateKey) {
      console.log('\n⛓️ Step 2: Updating MemoryIndex on-chain...');

      try {
        // Create Sui client and keypair
        const client = new SuiClient({ url: getFullnodeUrl(network) });
        const { secretKey } = decodeSuiPrivateKey(privateKey);
        const keypair = Ed25519Keypair.fromSecretKey(secretKey);

        // Read current MemoryIndex state
        const current = await getMemoryIndex({ client, memoryIndexId });

        if (!current) {
          console.warn('   ⚠️ MemoryIndex not found on-chain, skipping update');
        } else {
          console.log(`   Current version: ${current.version}`);
          console.log(`   Current index blob: ${current.indexBlobId}`);
          console.log(`   Current graph blob: ${current.graphBlobId}`);

          // Use existing graph blob if not provided
          if (!newGraphBlobId) {
            newGraphBlobId = current.graphBlobId;
          }

          // Update on-chain
          const updateResult = await updateMemoryIndexOnChain({
            client,
            signer: keypair,
            packageId,
            memoryIndexId,
            expectedVersion: current.version,
            newIndexBlobId,
            newGraphBlobId,
          });

          if (updateResult.success) {
            onChainUpdated = true;
            newVersion = updateResult.newVersion;
            txDigest = updateResult.digest;
            console.log(`   ✅ On-chain update successful`);
            console.log(`   Transaction: ${txDigest}`);
            console.log(`   New version: ${newVersion}`);
          } else {
            console.warn(`   ⚠️ On-chain update failed: ${updateResult.error}`);
          }
        }
      } catch (chainError) {
        console.error('   ❌ On-chain update error:', chainError);
      }
    } else {
      console.log('\n⚠️ Step 2: Skipping on-chain update (env vars not configured)');
    }

    const duration = Date.now() - startTime;
    console.log(`\n✅ Index update completed in ${(duration / 1000).toFixed(2)}s`);
    console.log(`${'='.repeat(70)}\n`);

    return new Response(JSON.stringify({
      success: true,
      message: onChainUpdated
        ? 'Index synced to Walrus and updated on-chain'
        : 'Index synced to Walrus (on-chain update skipped)',
      data: {
        newIndexBlobId,
        newGraphBlobId: newGraphBlobId || null,
        onChainUpdated,
        newVersion,
        txDigest,
        duration,
        durationFormatted: `${(duration / 1000).toFixed(2)}s`,
        // For convenience, output env var format
        envVars: {
          INDEX_BLOB_ID: newIndexBlobId,
          GRAPH_BLOB_ID: newGraphBlobId || undefined,
        }
      }
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });

  } catch (error) {
    console.error('❌ Index update API error:', error);
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
 * GET /api/index/update?walletAddress=xxx
 * Get current on-chain MemoryIndex state
 */
export async function GET(req: NextRequest) {
  try {
    const walletAddress = req.nextUrl.searchParams.get('walletAddress');

    if (!walletAddress) {
      return new Response(JSON.stringify({
        success: false,
        error: 'walletAddress query parameter is required'
      }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    const memoryIndexId = process.env.MEMORY_INDEX_ID;
    const network = (process.env.SUI_NETWORK as 'testnet' | 'mainnet') || 'testnet';

    if (!memoryIndexId) {
      return new Response(JSON.stringify({
        success: false,
        error: 'MEMORY_INDEX_ID not configured'
      }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    // Read from chain
    const client = new SuiClient({ url: getFullnodeUrl(network) });
    const memoryIndex = await getMemoryIndex({ client, memoryIndexId });

    if (!memoryIndex) {
      return new Response(JSON.stringify({
        success: false,
        error: 'MemoryIndex not found on-chain'
      }), {
        status: 404,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    // Also get local blob ID for comparison
    const pdw = await getReadOnlyPDWClient(walletAddress);
    const localBlobId = pdw.index.getWalrusBlobId(walletAddress);

    return new Response(JSON.stringify({
      success: true,
      data: {
        onChain: {
          objectId: memoryIndex.objectId,
          owner: memoryIndex.owner,
          version: memoryIndex.version,
          indexBlobId: memoryIndex.indexBlobId,
          graphBlobId: memoryIndex.graphBlobId,
        },
        local: {
          blobId: localBlobId || null,
          synced: localBlobId === memoryIndex.indexBlobId,
        }
      }
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });

  } catch (error) {
    console.error('❌ Get MemoryIndex error:', error);
    return new Response(JSON.stringify({
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error'
    }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
}
