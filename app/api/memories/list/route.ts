import { getPDWClient } from '@/lib/pdw-service'
import { NextResponse } from 'next/server'

// Force dynamic rendering - no static pre-rendering
export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

export async function GET() {
  try {
    const pdw = await getPDWClient()
    
    // Get all memories from the blockchain
    // Using the search.vector with empty query returns all memories
    const allMemories = await pdw.memory.list?.() || []
    
    console.log(`📋 Fetched ${allMemories.length} memories from blockchain`)

    // Format memories for frontend
    const formattedMemories = allMemories.map((memory: any) => ({
      id: memory.id,
      content: memory.content,
      blobId: memory.blobId,
      category: memory.category,
      importance: memory.importance,
      createdAt: memory.createdAt || Date.now(),
    }))

    return NextResponse.json({ 
      memories: formattedMemories,
      count: formattedMemories.length,
      success: true,
    })
  } catch (error) {
    console.error('❌ Failed to fetch memories:', error)
    
    // Return empty array instead of error to allow graceful degradation
    return NextResponse.json({ 
      memories: [],
      count: 0,
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error'
    })
  }
}

export async function DELETE() {
  try {
    // This endpoint would delete all memories (use with caution!)
    // For now, we'll just return a message
    return NextResponse.json({ 
      message: 'Delete all memories endpoint - not implemented yet',
      success: false,
    })
  } catch (error) {
    console.error('❌ Failed to delete memories:', error)
    return NextResponse.json({ 
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error'
    }, { status: 500 })
  }
}
