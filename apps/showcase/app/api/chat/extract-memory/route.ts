import { getReadOnlyPDWClient } from '@/lib/pdw-read-only'

// Force dynamic rendering - no static pre-rendering
export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

/**
 * POST /api/chat/extract-memory
 * Analyze user message and prepare memory data for client-side saving
 *
 * This endpoint performs READ-ONLY operations:
 * - Check if content should be saved (AI analysis)
 * - Generate embedding
 * - Classify content
 * - Extract knowledge graph
 *
 * It does NOT upload to Walrus - client will handle that with DappKitSigner.
 *
 * Body: { userMessage: string, walletAddress: string }
 */
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

    // Use read-only PDW client (no signing capability needed for analysis)
    const pdw = await getReadOnlyPDWClient(walletAddress)

    // Only analyze user message (not AI response)
    const contentToAnalyze = userMessage

    // Step 1: Check for EXPLICIT memory commands first (remember:, note that, etc.)
    const explicitMemories = pdw.ai.extractMultipleMemories(contentToAnalyze)

    if (explicitMemories.length > 0) {
      console.log(`🔍 Explicit memory command detected: ${explicitMemories.length} memories`)
      explicitMemories.forEach((m: string, i: number) => console.log(`   ${i + 1}. "${m}"`))

      // For explicit commands, use the first extracted memory as content
      // (For batch saves, the client should handle the full array via chat's X-Memories-To-Save header)
      const memoryContent = explicitMemories[0]

      // Step 2: Classify the content
      const category = await pdw.classify.category(memoryContent)
      const importance = await pdw.classify.importance(memoryContent)
      console.log(`📝 Classification: category=${category}, importance=${importance}`)

      // Step 3: Generate embedding
      const embedding = await pdw.embeddings.generate(memoryContent)
      console.log(`✅ Embedding generated: ${embedding.length} dimensions`)

      // Step 4: Extract knowledge graph (optional)
      let graphData = null
      try {
        graphData = await pdw.graph.extract(memoryContent)
        if (graphData && graphData.entities.length > 0) {
          console.log('🕸️ Knowledge Graph extracted:')
          console.log('  - Entities:', graphData.entities.map((e: any) => e.name).join(', '))
          console.log('  - Relationships:', graphData.relationships.length)
        }
      } catch (graphError) {
        console.warn('⚠️ Knowledge graph extraction failed:', graphError)
      }

      // Return prepared data for client-side signing
      return Response.json({
        memory: memoryContent,
        saved: false,
        needsClientSigning: true,
        prepared: {
          content: memoryContent,
          embedding: Array.from(embedding),
          category: category || 'general',
          importance: importance || 5,
          graph: graphData,
        }
      })
    }

    // Step 2: Fallback - check if content should be saved using AI analysis
    const shouldSave = await pdw.ai.shouldSave(contentToAnalyze)

    if (!shouldSave) {
      console.log('💭 No explicit command or meaningful personal data detected - skipping')
      return Response.json({
        memory: null,
        saved: false,
        reason: 'No explicit memory command or meaningful personal data detected'
      })
    }

    console.log('🔍 AI detected personal data - preparing for client-side saving...')

    // Step 2: Classify the content
    const category = await pdw.classify.category(contentToAnalyze)
    const importance = await pdw.classify.importance(contentToAnalyze)
    console.log(`📝 Classification: category=${category}, importance=${importance}`)

    // Step 3: Generate embedding
    const embedding = await pdw.embeddings.generate(contentToAnalyze)
    console.log(`✅ Embedding generated: ${embedding.length} dimensions`)

    // NOTE: Walrus upload REMOVED - client will handle with DappKitSigner
    // User pays for storage fee by signing with Slush wallet

    // Step 4: Extract knowledge graph (optional)
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
      // Continue without graph - it's optional
    }

    // Return prepared data for client-side signing
    return Response.json({
      memory: contentToAnalyze,
      saved: false, // Not saved yet - client needs to sign
      needsClientSigning: true,
      prepared: {
        content: contentToAnalyze,
        embedding: Array.from(embedding),
        category: category || 'general',
        importance: importance || 5,
        graph: graphData,
        // NOTE: No blobId - client will upload to Walrus and get blobId
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
