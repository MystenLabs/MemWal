import { createOpenRouter } from '@openrouter/ai-sdk-provider'
import { streamText } from 'ai'
import { getReadOnlyPDWClient } from '@/lib/pdw-read-only'
import { getChatModel } from '@cmdoss/memwal-sdk'

// OpenRouter provider - official provider for Vercel AI SDK
const openrouter = createOpenRouter({
  apiKey: process.env.OPENROUTER_API_KEY!,
})

// Force dynamic rendering - no static pre-rendering
export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

/**
 * Check if message is a PURE memory save command (no question, no context needed)
 * Pure commands: "remember: X", "remember X, Y", "store in memory: X"
 * NOT pure (mixed): "remember that I like pizza and what's my name?"
 */
function isPureMemorySaveCommand(message: string): boolean {
  const lowerMessage = message.toLowerCase().trim()

  // Memory command patterns that indicate PURE save intent
  const purePatterns = [
    /^remember[:\s]/i,           // "remember: X" or "remember X"
    /^store\s+(in\s+)?memory[:\s]/i,  // "store in memory: X"
    /^save[:\s]/i,               // "save: X"
    /^note[:\s]/i,               // "note: X"
    /^don'?t\s+forget[:\s]/i,    // "don't forget: X"
    /^memo[:\s]/i,               // "memo: X"
  ]

  // Check if starts with a memory command pattern
  const startsWithMemoryCommand = purePatterns.some(pattern => pattern.test(lowerMessage))
  if (!startsWithMemoryCommand) {
    return false
  }

  // Check for question indicators that would need search/RAG
  const questionIndicators = [
    /\?/,                        // Contains question mark
    /what('s|\s+is)/i,           // "what's" or "what is"
    /who('s|\s+is)/i,            // "who's" or "who is"
    /where('s|\s+is)/i,          // "where's" or "where is"
    /when('s|\s+is)/i,           // "when's" or "when is"
    /how('s|\s+is|\s+do)/i,      // "how's", "how is", "how do"
    /why('s|\s+is|\s+do)/i,      // "why's", "why is", "why do"
    /\band\s+(?:what|who|where|when|how|why|can|do|is|are)/i,  // "and what/who/etc"
    /\btell\s+me\b/i,            // "tell me"
    /\bdo\s+you\s+know\b/i,      // "do you know"
  ]

  // If contains question indicators, it's NOT a pure memory command
  const hasQuestion = questionIndicators.some(pattern => pattern.test(lowerMessage))

  return !hasQuestion
}

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
        console.log(`\n${'='.repeat(70)}`)
        console.log(`🔍 [/api/chat] MEMORY SEARCH & RETRIEVAL`)
        console.log(`${'='.repeat(70)}`)
        console.log(`📍 Wallet: ${walletAddress}`)
        console.log(`📍 Query: "${latestUserMessage.content.substring(0, 100)}..."`)

        console.log(`\n🔧 Step 1: Getting PDW client...`)
        const pdw = await getReadOnlyPDWClient(walletAddress)
        console.log(`   ✅ PDW client ready`)

        // Check services
        const services = (pdw as any).getServices?.() || (pdw as any).services || {}
        console.log(`   Services: memoryIndex=${!!services.memoryIndex}, vector=${!!services.vector}`)

        // Check index stats
        try {
          const stats = pdw.index.getStats(walletAddress)
          console.log(`   📊 Index stats: ${JSON.stringify(stats)}`)
        } catch (e) {
          console.log(`   ⚠️ Could not get index stats: ${e}`)
        }

        // Step 1: Check for explicit memory commands (supports multiple memories in one prompt)
        console.log(`\n🔧 Step 2: Checking for memory commands...`)
        const memoryContents = pdw.ai.extractMultipleMemories(latestUserMessage.content)

        // Check if this is a PURE memory command (only saving, no question)
        // Pure memory commands start with remember/store/note/don't forget and contain ONLY memory content
        const isPureMemoryCommand = memoryContents.length > 0 && isPureMemorySaveCommand(latestUserMessage.content)

        if (memoryContents.length > 0) {
          console.log(`   💾 Memory command detected: ${memoryContents.length} memories to save`)
          console.log(`   📝 Pure memory command: ${isPureMemoryCommand ? 'YES (skipping search)' : 'NO (will search for context)'}`)
          memoryContents.forEach((m: string, i: number) => console.log(`   ${i + 1}. "${m}"`))

          // Instead of saving server-side, return memories to save to client
          // Client will handle transaction signing with Slush wallet
          memoriesToSave = memoryContents
          memorySaved = true // Flag for prompt
          savedMemoryContent = memoryContents.join('; ')
        } else {
          console.log(`   No memory commands detected`)
        }

        // Skip search for pure memory commands to improve performance
        // Pure memory commands don't need RAG context - user just wants to save data
        if (!isPureMemoryCommand) {
          console.log(`\n🔧 Step 3: Performing memory search...`)
          console.log(`   memory.search available: ${typeof pdw.memory?.search}`)

          // Step 3a: Ensure index is loaded from disk (fixes cross-process issue)
          // Next.js API routes may run in different processes, so we need to
          // explicitly load the persisted index before searching
          try {
            console.log(`   Loading index for wallet: ${walletAddress.substring(0, 10)}...`)
            // Check if index file exists and try to trigger loading
            const { hasExistingIndexNode, loadIndexNode } = await import('@cmdoss/memwal-sdk')
            const hasIndex = await hasExistingIndexNode(walletAddress)
            console.log(`   Index exists on disk: ${hasIndex}`)

            if (hasIndex) {
              // Try to load index into memory via getStats (triggers lazy loading)
              const stats = pdw.index.getStats(walletAddress)
              console.log(`   Index stats after load attempt: ${JSON.stringify(stats)}`)
            }
          } catch (loadErr) {
            console.log(`   ⚠️ Index pre-load check: ${loadErr}`)
          }

          const searchStartTime = Date.now()
          // Use NEW pdw.memory.search() API instead of legacy pdw.search.vector()
          const searchResults = await pdw.memory.search(latestUserMessage.content, {
            limit: 10,
            threshold: 0.3,  // Lower threshold for better recall
            includeContent: true
          })
          const searchDuration = Date.now() - searchStartTime

          console.log(`   Search completed in ${searchDuration}ms`)
          console.log(`   Results: ${searchResults?.length ?? 0} items`)

          if (searchResults && searchResults.length > 0) {
            console.log(`\n📋 Search Results:`)
            searchResults.forEach((result: any, idx: number) => {
              // New API uses 'similarity', legacy uses 'score'
              const score = result.similarity ?? result.score ?? 0
              console.log(`   ${idx + 1}. score=${(score * 100).toFixed(1)}%, content="${(result.content || '').substring(0, 50)}..."`)
            })
            relevantMemories = '\n\n📚 **Relevant Memories from Blockchain:**\n' +
              searchResults
                .map((result: any, idx: number) => {
                  const score = result.similarity ?? result.score ?? 0
                  return `${idx + 1}. ${result.content} (relevance: ${(score * 100).toFixed(1)}%)`
                })
                .join('\n')

            console.log(`\n✅ Found ${searchResults.length} relevant memories for RAG`)
          } else {
            console.log(`\n⚠️ No relevant memories found for query`)
          }
        } else {
          console.log(`\n🔧 Step 3: Skipping search (pure memory command)`)
          console.log(`   ⚡ Optimization: No RAG needed for save-only commands`)
        }
        console.log(`${'='.repeat(70)}\n`)
      } catch (memoryError) {
        console.error('❌ Memory search failed (continuing without memories):', memoryError)
        if (memoryError instanceof Error) {
          console.error('   Stack:', memoryError.stack)
        }
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
      model: openrouter(getChatModel()),
      messages,
      system: systemPrompt,
    })

    // Create response with memories to save in header
    const response = result.toTextStreamResponse()

    // Add memories to save as custom header for client to handle
    // Use Base64 encoding to handle Unicode characters in memory content
    if (memoriesToSave.length > 0) {
      const jsonStr = JSON.stringify(memoriesToSave)
      // Encode to Base64 to handle Unicode characters (HTTP headers only support ASCII)
      const base64Encoded = Buffer.from(jsonStr, 'utf-8').toString('base64')
      response.headers.set('X-Memories-To-Save', base64Encoded)
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
