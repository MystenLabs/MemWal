import { createOpenRouter } from '@openrouter/ai-sdk-provider'
import { streamText } from 'ai'
import { getPDWClient } from '@/lib/pdw-service'

// OpenRouter provider - official provider for Vercel AI SDK
// Supports hundreds of models through the OpenRouter API
const openrouter = createOpenRouter({
  apiKey: process.env.OPENROUTER_API_KEY!,
})

// Force dynamic rendering - no static pre-rendering
export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

export async function POST(req: Request) {
  try {
    const { messages } = await req.json()

    // Get the latest user message for vector search
    const latestUserMessage = messages.filter((m: any) => m.role === 'user').pop()

    let relevantMemories = ''
    let memorySaved = false
    let savedMemoryContent = ''

    // Search for relevant memories from blockchain using PDW
    if (latestUserMessage?.content) {
      try {
        console.log(`🔍 Processing message: "${latestUserMessage.content.substring(0, 50)}..."`)
        const pdw = await getPDWClient()

        // Step 1: Check for explicit memory commands (supports multiple memories in one prompt)
        // e.g., "Remember that my name is John, I work at Acme Corp, and my favorite color is blue"
        const memoryContents = pdw.ai.extractMultipleMemories(latestUserMessage.content)
        if (memoryContents.length > 0) {
          console.log(`💾 Memory command detected: ${memoryContents.length} memories to save`)
          memoryContents.forEach((m: string, i: number) => console.log(`   ${i + 1}. "${m}"`))

          try {
            if (memoryContents.length === 1) {
              // Single memory - use regular create
              const saveResult = await pdw.memory.create(memoryContents[0], {
                category: 'custom',
                importance: 5,
              })
              memorySaved = true
              savedMemoryContent = memoryContents[0]
              console.log(`✅ Memory saved to blockchain: ${saveResult.id}`)
            } else {
              // Multiple memories - use batch create with Quilt (single transaction!)
              const saveResults = await pdw.memory.createBatch(memoryContents, {
                category: 'custom',
                importance: 5,
              })
              memorySaved = true
              savedMemoryContent = memoryContents.join('; ')
              console.log(`✅ ${saveResults.length} memories saved to blockchain via Quilt batch`)
              saveResults.forEach((r: { id: string }, i: number) => console.log(`   ${i + 1}. ${r.id}`))
            }
          } catch (saveError) {
            console.error('⚠️ Failed to save memory:', saveError)
          }
        }

        console.log(`🔍 PDW search.vector available: ${typeof pdw.search?.vector}`)
        const searchResults = await pdw.search.vector(latestUserMessage.content, {
          limit: 10,  // Increased from 5 to return more memories
          threshold: 0.5,  // Lower threshold to find more results
          fetchContent: true  // Fetch content from Walrus
        })

        console.log(`🔍 Search results: ${JSON.stringify(searchResults?.length ?? 'null')} items`)

        if (searchResults && searchResults.length > 0) {
          console.log(`🔍 First result:`, JSON.stringify(searchResults[0], null, 2))
          relevantMemories = '\n\n📚 **Relevant Memories from Blockchain:**\n' +
            searchResults
              .map((result: any, idx: number) =>
                `${idx + 1}. ${result.content} (relevance: ${(result.score * 100).toFixed(1)}%)`
              )
              .join('\n')

          console.log(`✅ Found ${searchResults.length} relevant memories for RAG`)
        } else {
          console.log(`⚠️ No relevant memories found for query`)
        }
      } catch (memoryError) {
        console.error('⚠️ Memory search failed (continuing without memories):', memoryError)
        // Continue without memories if search fails
      }
    }

    // Build enhanced system prompt with memories
    const memorySavedNotice = memorySaved
      ? `\n\n## IMPORTANT - Memory Just Saved:\nThe user just asked to save: "${savedMemoryContent}"\nThis has been SUCCESSFULLY saved to their blockchain memory. Acknowledge this save in your response with a confirmation like "I've saved that to your blockchain memory" or "Got it, I'll remember that".`
      : ''

    const systemPrompt = `You are a helpful AI assistant for a personal data wallet app. You have access to the user's encrypted memories stored on the Sui blockchain.

## Memory Commands
Users can save information to their blockchain memory using these commands:
- "Remember that [information]" - Save specific information
- "Store in memory: [information]" - Save to blockchain
- "Don't forget [information]" - Save important info
- "Note that [information]" - Quick note to memory
${memorySavedNotice}

## Retrieving Memories
When the user asks questions about themselves (e.g., "What's my name?", "Where do I work?"), reference the memories below if available.
${relevantMemories ? `\n## Your Stored Memories:\n${relevantMemories}\n\nUse these memories to provide personalized responses. Reference them naturally in conversation.` : '\n(No relevant memories found for this query)'}

Always be helpful, conversational, and respect the user's privacy.`

    const result = streamText({
      model: openrouter('google/gemini-2.5-flash'),
      messages,
      system: systemPrompt,
    })

    // Use the proper method based on AI SDK version
    return result.toTextStreamResponse()
  } catch (error) {
    console.error('API Error:', error)
    return new Response(JSON.stringify({ error: 'Failed to process request' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    })
  }
}