import { getReadOnlyPDWClient } from '@/lib/pdw-read-only'
import { NextRequest, NextResponse } from 'next/server'

// Force dynamic rendering - no static pre-rendering
export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

/**
 * Index a newly created memory into the HNSW search index
 * This is called after a memory is saved on-chain to make it searchable
 */
export async function POST(request: NextRequest) {
  try {
    const body = await request.json()
    const {
      memoryId,
      walletAddress,
      content,
      blobId,
      embedding,
      category,
      importance,
      vectorId,
    } = body

    if (!walletAddress) {
      return NextResponse.json({
        success: false,
        error: 'walletAddress is required'
      }, { status: 400 })
    }

    if (!embedding || !Array.isArray(embedding)) {
      return NextResponse.json({
        success: false,
        error: 'embedding array is required'
      }, { status: 400 })
    }

    const pdw = await getReadOnlyPDWClient(walletAddress)

    // Add the memory to the local HNSW index
    // This makes the memory searchable via semantic search
    // Signature: add(spaceId, vectorId, vector, metadata)
    await pdw.index.add(
      walletAddress,                    // spaceId (user's index)
      vectorId || Date.now(),           // vectorId (unique number)
      embedding,                        // vector array
      {
        memoryId,
        content,
        blobId,
        category,
        importance,
        timestamp: Date.now(),
      }
    )

    console.log(`✅ Memory indexed for wallet ${walletAddress}:`, {
      memoryId,
      blobId,
      vectorId,
      embeddingLength: embedding.length,
    })

    return NextResponse.json({
      success: true,
      indexed: true,
      memoryId,
      blobId,
    })

  } catch (error) {
    console.error('❌ Failed to index memory:', error)

    return NextResponse.json({
      success: false,
      error: error instanceof Error ? error.message : 'Failed to index memory'
    }, { status: 500 })
  }
}
