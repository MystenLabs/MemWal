import { google } from '@ai-sdk/google'
import { streamText } from 'ai'
import { getPDWClient } from '@/lib/pdw-service'

// Force dynamic rendering - no static pre-rendering
export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

export async function POST(req: Request) {
  try {
    const { messages } = await req.json()

    // Get the latest user message for vector search
    const latestUserMessage = messages.filter((m: any) => m.role === 'user').pop()
    
    let relevantMemories = ''
    
    // Search for relevant memories from blockchain using PDW
    if (latestUserMessage?.content) {
      try {
        const pdw = await getPDWClient()
        const searchResults = await pdw.search.vector(latestUserMessage.content, { 
          limit: 5 
        })
        
        if (searchResults && searchResults.length > 0) {
          relevantMemories = '\n\n📚 **Relevant Memories from Blockchain:**\n' + 
            searchResults
              .map((result: any, idx: number) => 
                `${idx + 1}. ${result.content} (relevance: ${(result.score * 100).toFixed(1)}%)`
              )
              .join('\n')
          
          console.log(`✅ Found ${searchResults.length} relevant memories for RAG`)
        }
      } catch (memoryError) {
        console.warn('⚠️ Memory search failed (continuing without memories):', memoryError)
        // Continue without memories if search fails
      }
    }

    // Build enhanced system prompt with memories
    const systemPrompt = `You are a helpful AI assistant for a personal data wallet app. You have access to the user's encrypted memories stored on the Sui blockchain.

When the user asks questions, you can reference their personal information stored in the blockchain memories.
${relevantMemories ? `\nHere are relevant memories from the user's blockchain:\n${relevantMemories}\n\nUse these memories to provide personalized responses. Reference them naturally in conversation.` : ''}

Always be helpful, conversational, and respect the user's privacy.`

    const result = streamText({
      model: google('gemini-2.5-flash-lite'),
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