import { getReadOnlyPDWClient } from '@/lib/pdw-read-only'
import { NextRequest, NextResponse } from 'next/server'

// Force dynamic rendering - no static pre-rendering
export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

export async function GET(request: NextRequest) {
  try {
    // Get wallet address from query params or headers
    const walletAddress = request.nextUrl.searchParams.get('walletAddress')
      || request.headers.get('x-wallet-address')

    if (!walletAddress) {
      return NextResponse.json({
        memories: [],
        count: 0,
        success: false,
        error: 'Wallet address is required. Pass walletAddress query param or x-wallet-address header.'
      }, { status: 400 })
    }

    const pdw = await getReadOnlyPDWClient(walletAddress)

    // Get all memories from the blockchain
    const allMemories = await pdw.memory.list?.() || []

    console.log(`📋 Fetched ${allMemories.length} memories for wallet: ${walletAddress}`)

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

    return NextResponse.json({
      memories: [],
      count: 0,
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error'
    })
  }
}

export async function DELETE() {
  return NextResponse.json({
    message: 'Delete all memories endpoint - not implemented yet',
    success: false,
  })
}
