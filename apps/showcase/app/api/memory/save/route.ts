import { getReadOnlyPDWClient } from '@/lib/pdw-read-only';
import { NextRequest } from 'next/server';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * POST /api/memory/save
 * Prepare memory data for blockchain saving
 *
 * This endpoint now returns prepared data that the client will use
 * to build and sign the transaction with Slush wallet
 *
 * Body: { content: string, category?: string, walletAddress: string }
 */
export async function POST(req: Request) {
  try {
    const { content, category, walletAddress } = await req.json();

    if (!content || typeof content !== 'string' || content.trim().length === 0) {
      return new Response(JSON.stringify({
        success: false,
        error: 'Content is required'
      }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    if (!walletAddress) {
      return new Response(JSON.stringify({
        success: false,
        error: 'walletAddress is required'
      }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    console.log(`💾 Preparing memory for wallet ${walletAddress}: "${content.substring(0, 50)}..."`);

    const pdw = await getReadOnlyPDWClient(walletAddress);

    // Generate embedding for the content
    const embedding = await pdw.embeddings.generate(content);

    // Classify the content
    const classification = await pdw.classify.content(content);

    // Store content to Walrus (this doesn't need signing)
    const blobResult = await pdw.storage.uploadToWalrus(content);

    return new Response(JSON.stringify({
      success: true,
      prepared: {
        content,
        blobId: blobResult.blobId,
        embedding: Array.from(embedding), // Convert to array for JSON
        category: category || classification?.category || 'custom',
        importance: classification?.importance || 5,
        metadata: {
          createdAt: Date.now(),
          walletAddress,
        }
      },
      message: 'Memory prepared. Sign the transaction with your wallet to save to blockchain.'
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });

  } catch (error) {
    console.error('❌ Memory prepare error:', error);
    return new Response(JSON.stringify({
      success: false,
      error: error instanceof Error ? error.message : 'Failed to prepare memory'
    }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
}
