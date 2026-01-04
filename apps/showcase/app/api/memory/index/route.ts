import { getReadOnlyPDWClient } from '@/lib/pdw-read-only'

// Force dynamic rendering
export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

/**
 * POST /api/memory/index
 * Add a newly created memory to the local HNSW index for vector search
 *
 * This endpoint should be called AFTER the memory is successfully created on-chain.
 * It adds the embedding to the local HNSW index so vector search can find it.
 *
 * Body: {
 *   walletAddress: string,
 *   memoryId: string,
 *   vectorId: number,
 *   content: string,
 *   embedding: number[],
 *   blobId: string,
 *   category: string,
 *   importance: number
 * }
 */
export async function POST(req: Request) {
  const startTime = Date.now()

  try {
    const body = await req.json()
    const {
      walletAddress,
      memoryId,
      vectorId,
      content,
      embedding,
      blobId,
      category,
      importance
    } = body

    if (!walletAddress || !embedding || !Array.isArray(embedding)) {
      return Response.json({
        success: false,
        error: 'walletAddress and embedding array are required'
      }, { status: 400 })
    }

    console.log(`\n${'='.repeat(70)}`)
    console.log(`📝 [/api/memory/index] INDEXING MEMORY`)
    console.log(`${'='.repeat(70)}`)
    console.log(`📍 Working directory: ${process.cwd()}`)
    console.log(`📍 Expected index dir: ${process.cwd()}/.pdw-indexes`)
    console.log(`📋 Request Details:`)
    console.log(`   walletAddress: ${walletAddress}`)
    console.log(`   memoryId: ${memoryId}`)
    console.log(`   vectorId: ${vectorId}`)
    console.log(`   embedding dims: ${embedding.length}`)
    console.log(`   blobId: ${blobId}`)
    console.log(`   category: ${category}`)
    console.log(`   importance: ${importance}`)
    console.log(`   content: "${content?.slice(0, 100) || '(empty)'}${content?.length > 100 ? '...' : ''}" (${content?.length || 0} chars)`)

    // Get PDW client (this will use/create the singleton HNSW service)
    console.log(`\n🔧 Step 1: Getting PDW client...`)
    const pdw = await getReadOnlyPDWClient(walletAddress)
    console.log(`   ✅ PDW client ready`)

    // Check what services are available
    const services = (pdw as any).getServices?.() || (pdw as any).services || {}
    console.log(`   Services: memoryIndex=${!!services.memoryIndex}, vector=${!!services.vector}, sharedHnswService=${!!services.sharedHnswService}`)

    // Add to local HNSW index via the index namespace
    console.log(`\n🔧 Step 2: Adding to HNSW index...`)
    try {
      await pdw.index.add(
        walletAddress,  // spaceId
        vectorId,       // vectorId (number)
        embedding,      // vector array
        {               // metadata
          memoryObjectId: memoryId,
          blobId: blobId,
          category: category || 'general',
          importance: importance || 5,
          content: content,
          timestamp: Date.now(),
          isEncrypted: false
        }
      )
      console.log(`   ✅ pdw.index.add() completed`)

      // Flush to ensure it's persisted
      console.log(`\n🔧 Step 3: Flushing index to disk...`)
      await pdw.index.flush(walletAddress)
      console.log(`   ✅ pdw.index.flush() completed`)

      // Check if index file was created
      console.log(`\n🔧 Step 4: Verifying index files...`)
      const fs = await import('fs/promises')
      const indexDir = './.pdw-indexes'
      try {
        const files = await fs.readdir(indexDir)
        console.log(`   📁 Index directory contents: ${files.length > 0 ? files.join(', ') : '(empty)'}`)

        // Check for specific index file
        const safeAddress = walletAddress.replace(/[^a-zA-Z0-9]/g, '_')
        const expectedFile = `${safeAddress}.hnsw`
        if (files.includes(expectedFile)) {
          const stats = await fs.stat(`${indexDir}/${expectedFile}`)
          console.log(`   📄 ${expectedFile}: ${stats.size} bytes, modified ${stats.mtime}`)
        } else {
          console.log(`   ⚠️ Expected file ${expectedFile} not found`)
        }
      } catch (e) {
        console.log(`   ❌ Index directory check failed: ${e}`)
      }

      const duration = Date.now() - startTime
      console.log(`\n✅ Memory indexed successfully in ${duration}ms`)
      console.log(`${'='.repeat(70)}\n`)

      return Response.json({
        success: true,
        indexed: true,
        vectorId,
        duration
      })
    } catch (indexError: any) {
      console.error(`\n❌ pdw.index.add() failed:`, indexError.message)
      console.error(`   Stack: ${indexError.stack}`)

      // Fallback: trigger rebuild from blockchain
      try {
        const { rebuildIndexNode } = await import('@cmdoss/memwal-sdk')
        const { getFullnodeUrl, SuiClient } = await import('@mysten/sui/client')

        const network = (process.env.SUI_NETWORK as 'testnet' | 'mainnet') || 'testnet'
        const client = new SuiClient({ url: getFullnodeUrl(network) })

        console.log('🔄 Triggering index rebuild to include new memory...')

        // Run rebuild in background (don't await)
        rebuildIndexNode({
          userAddress: walletAddress,
          client,
          packageId: process.env.PACKAGE_ID!,
          force: true,
          onProgress: (current, total, status) => {
            console.log(`[Index Rebuild] ${current}/${total}: ${status}`)
          }
        }).then((result) => {
          if (result.success) {
            console.log(`✅ Index rebuild complete: ${result.indexedMemories}/${result.totalMemories} memories indexed`)
          }
        }).catch((error) => {
          console.error('❌ Index rebuild failed:', error)
        })

        return Response.json({
          success: true,
          indexed: false,
          rebuildTriggered: true,
          message: 'Index rebuild triggered in background'
        })
      } catch (rebuildError) {
        console.error('❌ Fallback rebuild also failed:', rebuildError)
        return Response.json({
          success: false,
          error: 'Failed to index memory'
        }, { status: 500 })
      }
    }
  } catch (error) {
    console.error('❌ Memory indexing error:', error)
    return Response.json({
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error'
    }, { status: 500 })
  }
}
