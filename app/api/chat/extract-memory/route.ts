import { getPDWClient, shouldSaveAsMemory, classifyContent } from '@/lib/pdw-service'

// Force dynamic rendering - no static pre-rendering
export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

export async function POST(req: Request) {
  try {
    const { userMessage } = await req.json()

    // Only analyze user message (not AI response)
    // User messages contain the actual personal information we want to learn
    const contentToAnalyze = userMessage

    // Step 1: Check if this should be saved as a memory
    const shouldSave = await shouldSaveAsMemory(contentToAnalyze)

    if (!shouldSave) {
      console.log('💭 No meaningful personal data detected - skipping blockchain storage')
      return Response.json({
        memory: null,
        saved: false,
        reason: 'No meaningful personal data detected'
      })
    }

    console.log('🔍 Personal data detected in user message - storing on blockchain...')

    // Step 2: Classify the content
    const classification = await classifyContent(contentToAnalyze)

    // Step 3: Store on blockchain using PDW
    const pdw = await getPDWClient()

    const memoryData = await pdw.memory.create(contentToAnalyze, {
      category: classification?.category || 'general',
      importance: classification?.importance || 5,
    })

    console.log('✅ Memory stored on blockchain!')
    console.log('📍 Memory ID:', memoryData.id)
    console.log('🗄️ Blob ID:', memoryData.blobId)
    console.log('📊 Category:', classification?.category)
    console.log('⭐ Importance:', classification?.importance)

    // Step 4: Extract knowledge graph (entities and relationships)
    try {
      const graphExtraction = await pdw.graph.extract(contentToAnalyze)

      if (graphExtraction && graphExtraction.entities.length > 0) {
        console.log('🕸️ Knowledge Graph extracted:')
        console.log('  - Entities:', graphExtraction.entities.map((e: any) => e.name).join(', '))
        console.log('  - Relationships:', graphExtraction.relationships.length)
      }
    } catch (graphError) {
      console.warn('⚠️ Knowledge graph extraction failed:', graphError)
      // Continue even if graph extraction fails
    }

    return Response.json({
      memory: contentToAnalyze,
      saved: true,
      memoryId: memoryData.id,
      blobId: memoryData.blobId,
      category: classification?.category,
      importance: classification?.importance,
      blockchainTx: true,
    })
  } catch (error) {
    console.error('❌ Memory extraction/storage error:', error)
    return Response.json({
      memory: null,
      saved: false,
      error: error instanceof Error ? error.message : 'Unknown error'
    }, { status: 200 })
  }
}






