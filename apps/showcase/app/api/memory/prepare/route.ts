import { getReadOnlyPDWClient } from '@/lib/pdw-read-only'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

/**
 * POST /api/memory/prepare
 * Prepare memory data for client-side saving (READ-ONLY operations)
 *
 * This endpoint does NOT upload to Walrus or sign any transactions.
 * It only performs AI operations that require the server's API key:
 * - Generate embedding
 * - Classify content (category, importance)
 * - Extract knowledge graph
 *
 * The client will then:
 * 1. Upload to Walrus (user signs with Slush wallet)
 * 2. Register on blockchain (user signs with Slush wallet)
 *
 * Body: { content: string, category?: string, walletAddress: string }
 */
export async function POST(req: Request) {
  try {
    const { content, category, walletAddress } = await req.json()

    if (!content || typeof content !== 'string' || content.trim().length === 0) {
      return Response.json({
        success: false,
        error: 'Content is required'
      }, { status: 400 })
    }

    if (!walletAddress) {
      return Response.json({
        success: false,
        error: 'walletAddress is required'
      }, { status: 400 })
    }

    console.log(`📝 Preparing memory for wallet ${walletAddress}: "${content.substring(0, 50)}..."`)

    // Use read-only PDW client (no signing capability needed)
    const pdw = await getReadOnlyPDWClient(walletAddress)

    // Generate embedding for the content
    const embedding = await pdw.embeddings.generate(content)
    console.log(`✅ Embedding generated: ${embedding.length} dimensions`)

    // Classify the content
    const classifiedCategory = category || await pdw.classify.category(content)
    const classifiedImportance = await pdw.classify.importance(content)
    console.log(`📝 Classification: category=${classifiedCategory}, importance=${classifiedImportance}`)

    // Extract knowledge graph (optional, may fail)
    let graphData = null
    try {
      graphData = await pdw.graph.extract(content)
      if (graphData && graphData.entities.length > 0) {
        console.log('🕸️ Knowledge Graph extracted:')
        console.log('  - Entities:', graphData.entities.map((e: any) => e.name).join(', '))
        console.log('  - Relationships:', graphData.relationships.length)
      }
    } catch (graphError) {
      console.warn('⚠️ Knowledge graph extraction failed:', graphError)
      // Continue without graph - it's optional
    }

    // Return prepared data (NO blobId - client will upload to Walrus)
    return Response.json({
      success: true,
      prepared: {
        content,
        embedding: Array.from(embedding),
        category: classifiedCategory || 'general',
        importance: classifiedImportance || 5,
        graph: graphData,
        metadata: {
          createdAt: Date.now(),
          walletAddress,
        }
      },
      message: 'Memory prepared. Use client-side SDK to upload to Walrus and register on blockchain.'
    })

  } catch (error) {
    console.error('❌ Memory prepare error:', error)
    return Response.json({
      success: false,
      error: error instanceof Error ? error.message : 'Failed to prepare memory'
    }, { status: 500 })
  }
}
