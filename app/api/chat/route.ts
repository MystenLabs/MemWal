import { createOpenRouter } from '@openrouter/ai-sdk-provider'
import { streamText } from 'ai'
import { getReadOnlyPDWClient } from '@/lib/pdw-read-only'

// OpenRouter provider - official provider for Vercel AI SDK
const openrouter = createOpenRouter({
  apiKey: process.env.OPENROUTER_API_KEY!,
})

// Force dynamic rendering - no static pre-rendering
export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

export async function POST(req: Request) {
  try {
    const { messages, walletAddress } = await req.json()

    if (!walletAddress) {
      return new Response(JSON.stringify({ error: 'walletAddress is required' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      })
    }

    // Get the latest user message for vector search
    const latestUserMessage = messages.filter((m: any) => m.role === 'user').pop()

    let relevantMemories = ''
    let memorySaved = false
    let savedMemoryContent = ''
    let memoriesToSave: string[] = []

    // Search for relevant memories from blockchain using PDW
    if (latestUserMessage?.content) {
      try {
        console.log(`🔍 Processing message for wallet ${walletAddress}: "${latestUserMessage.content.substring(0, 50)}..."`)
        const pdw = await getReadOnlyPDWClient(walletAddress)

        // Step 1: Check for explicit memory commands (supports multiple memories in one prompt)
        const memoryContents = pdw.ai.extractMultipleMemories(latestUserMessage.content)
        if (memoryContents.length > 0) {
          console.log(`💾 Memory command detected: ${memoryContents.length} memories to save`)
          memoryContents.forEach((m: string, i: number) => console.log(`   ${i + 1}. "${m}"`))

          // Instead of saving server-side, return memories to save to client
          // Client will handle transaction signing with Slush wallet
          memoriesToSave = memoryContents
          memorySaved = true // Flag for prompt
          savedMemoryContent = memoryContents.join('; ')
        }

        console.log(`🔍 PDW search.vector available: ${typeof pdw.search?.vector}`)
        const searchResults = await pdw.search.vector(latestUserMessage.content, {
          limit: 10,
          threshold: 0.5,
          fetchContent: true
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
      }
    }

    // Build enhanced system prompt with memories
    const memorySavedNotice = memorySaved
      ? `\n\n## IMPORTANT - Memory Will Be Saved:\nThe user just asked to save: "${savedMemoryContent}"\nThis will be saved to their blockchain memory after they approve the transaction. Acknowledge this in your response with something like "I'll save that to your blockchain memory" or "Got it, I'll remember that (pending your approval)".`
      : ''

    const systemPrompt = `You are a helpful AI assistant for a personal data wallet app. You have access to the user's encrypted memories stored on the Sui blockchain.

## Your Capabilities
1. **Personal Memory**: Access and reference user's stored memories from blockchain
2. **General Knowledge**: Answer questions about any topic using your training knowledge
3. **Memory Management**: Help users save and organize their personal information

## Memory Commands
Users can save information to their blockchain memory using these commands:
- "Remember that [information]" - Save specific information
- "Store in memory: [information]" - Save to blockchain
- "Don't forget [information]" - Save important info
- "Note that [information]" - Quick note to memory
${memorySavedNotice}

## How to Respond
- For **personal questions** (name, hometown, preferences): Use stored memories below
- For **general knowledge** (facts, places, how-to): Use your training knowledge freely
- For **questions about stored memories**: Reference the memories and provide context
${relevantMemories ? `\n## User's Stored Memories:\n${relevantMemories}\n\nUse these memories to personalize responses when relevant.` : '\n(No relevant memories found for this query)'}

Be helpful, conversational, and combine personal memories with general knowledge when appropriate.`

    const result = streamText({
      model: openrouter('google/gemini-2.5-flash'),
      messages,
      system: systemPrompt,
    })

    // Create response with memories to save in header
    const response = result.toTextStreamResponse()

    // Add memories to save as custom header for client to handle
    if (memoriesToSave.length > 0) {
      response.headers.set('X-Memories-To-Save', JSON.stringify(memoriesToSave))
    }

    return response
  } catch (error) {
    console.error('API Error:', error)
    return new Response(JSON.stringify({ error: 'Failed to process request' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    })
  }
}
