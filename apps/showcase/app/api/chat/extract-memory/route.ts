import { getReadOnlyPDWClient } from '@/lib/pdw-read-only'

// Force dynamic rendering - no static pre-rendering
export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

export async function POST(req: Request) {
  try {
    const { userMessage, walletAddress } = await req.json()

    if (!walletAddress) {
      return Response.json({
        memory: null,
        saved: false,
        error: 'walletAddress is required'
      }, { status: 400 })
    }

    const pdw = await getReadOnlyPDWClient(walletAddress)

    // Only analyze user message (not AI response)
    const contentToAnalyze = userMessage

    // Step 1: Check if this should be saved as a memory
    const shouldSave = await pdw.ai.shouldSave(contentToAnalyze)

    if (!shouldSave) {
      console.log('💭 No meaningful personal data detected - skipping blockchain storage')
      return Response.json({
        memory: null,
        saved: false,
        reason: 'No meaningful personal data detected'
      })
    }

    console.log('🔍 Personal data detected in user message - preparing for blockchain storage...')

    // Step 2: Classify the content
    const classification = await pdw.classify.content(contentToAnalyze)

    // Step 3: Prepare memory data (client will sign transaction)
    // Generate embedding
    const embedding = await pdw.embeddings.generate(contentToAnalyze)

    // Upload to Walrus (doesn't need signing)
    const blobResult = await pdw.storage.uploadToWalrus(contentToAnalyze)

    // Extract knowledge graph
    let graphData = null
    try {
      graphData = await pdw.graph.extract(contentToAnalyze)
      if (graphData && graphData.entities.length > 0) {
        console.log('🕸️ Knowledge Graph extracted:')
        console.log('  - Entities:', graphData.entities.map((e: any) => e.name).join(', '))
        console.log('  - Relationships:', graphData.relationships.length)
      }
    } catch (graphError) {
      console.warn('⚠️ Knowledge graph extraction failed:', graphError)
    }

    // Return prepared data for client-side transaction signing
    return Response.json({
      memory: contentToAnalyze,
      saved: false, // Not saved yet - client needs to sign
      needsClientSigning: true,
      prepared: {
        content: contentToAnalyze,
        blobId: blobResult.blobId,
        embedding: Array.from(embedding),
        category: classification?.category || 'general',
        importance: classification?.importance || 5,
        graph: graphData,
      }
    })
  } catch (error) {
    console.error('❌ Memory extraction error:', error)
    return Response.json({
      memory: null,
      saved: false,
      error: error instanceof Error ? error.message : 'Unknown error'
    }, { status: 200 })
  }
}
