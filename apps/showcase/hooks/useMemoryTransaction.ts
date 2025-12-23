'use client'

import { useCallback, useState } from 'react'
import { usePDWClient } from './usePDWClient'

/**
 * Sync index to Walrus in background (non-blocking)
 * This ensures the local HNSW index is backed up to cloud storage
 */
async function syncIndexToWalrus(walletAddress: string): Promise<void> {
  try {
    console.log('☁️ Syncing index to Walrus (background)...')
    const response = await fetch('/api/index/sync', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ walletAddress })
    })
    const result = await response.json()
    if (result.success) {
      console.log(`☁️ Index synced to Walrus: ${result.data?.blobId}`)
    } else {
      // Don't log error if Walrus backup is just not enabled
      if (!result.error?.includes('not enabled')) {
        console.warn('⚠️ Index Walrus sync skipped:', result.error)
      }
    }
  } catch (error) {
    // Silent fail - this is a background operation
    console.warn('⚠️ Index Walrus sync error:', error)
  }
}

export interface PreparedMemory {
  content: string
  embedding: number[]
  category: string
  importance: number
  graph?: any
  metadata?: {
    createdAt: number
    walletAddress: string
  }
  // Note: blobId is now optional - client will upload to Walrus
  blobId?: string
}

interface SaveMemoryResult {
  success: boolean
  memoryId?: string
  blobId?: string
  error?: string
}

/**
 * Convert category string to numeric code for smart contract
 */
function getCategoryCode(category: string): number {
  const categories: Record<string, number> = {
    'personal': 0,
    'work': 1,
    'health': 2,
    'finance': 3,
    'education': 4,
    'social': 5,
    'travel': 6,
    'hobbies': 7,
    'general': 8,
    'custom': 8,
    'fact': 9,
    'preference': 10,
    'todo': 11,
    'note': 12,
  }
  return categories[category.toLowerCase()] ?? 8 // default to custom
}

/**
 * Hook to save memory using client-side PDW SDK with Slush wallet signing
 *
 * Flow:
 * 1. Prepare on server (embedding, classify) - call /api/memory/prepare
 * 2. Upload to Walrus using PDW client (USER SIGNS - pays storage fee)
 * 3. Register on blockchain using PDW client (USER SIGNS - pays gas fee)
 */
export function useMemoryTransaction() {
  const { client, initClient, address, isConnected } = usePDWClient()
  const [isPending, setIsPending] = useState(false)

  /**
   * Save memory with full client-side signing
   * User pays for both Walrus storage and blockchain gas
   */
  const saveMemory = useCallback(async (
    walletAddress: string,
    content: string,
    category?: string
  ): Promise<SaveMemoryResult> => {
    if (!isConnected || !address) {
      return { success: false, error: 'Wallet not connected' }
    }

    setIsPending(true)

    try {
      // Step 1: Prepare on server (generate embedding, classify)
      console.log('📝 Step 1: Preparing memory on server...')
      const prepareResponse = await fetch('/api/memory/prepare', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content, category, walletAddress })
      })

      const prepareResult = await prepareResponse.json()
      if (!prepareResult.success) {
        return { success: false, error: prepareResult.error }
      }

      const prepared: PreparedMemory = prepareResult.prepared
      console.log(`✅ Prepared: category=${prepared.category}, importance=${prepared.importance}`)

      // Step 2: Get or initialize PDW client with DappKitSigner
      console.log('🔧 Step 2: Initializing PDW client...')
      let pdw = client
      if (!pdw) {
        pdw = await initClient()
        if (!pdw) {
          return { success: false, error: 'Failed to initialize PDW client' }
        }
      }

      // Step 3: Upload to Walrus (USER SIGNS - pays storage fee)
      // Use storeMemoryPackage() to create proper JSON format for rebuildIndexNode
      console.log('📤 Step 3: Uploading memory package to Walrus (user will sign)...')
      const blobResult = await pdw.storage.storeMemoryPackage({
        content: content,
        contentType: 'text/plain',
        embedding: prepared.embedding,
        metadata: {
          category: prepared.category,
          importance: prepared.importance,
          topic: '',
        },
      })
      console.log(`✅ Walrus upload complete, blobId: ${blobResult.blobId}`)

      // Step 4: Build and execute blockchain transaction (USER SIGNS - pays gas)
      console.log('⛓️ Step 4: Creating memory on blockchain (user will sign)...')
      const vectorId = Date.now() % 4294967295 // Keep within u32 range

      // Use buildCreate() - the correct method in BlockchainNamespace.tx
      const tx = pdw.blockchain.tx.buildCreate({
        category: prepared.category,
        vectorId,
        blobId: blobResult.blobId,
        importance: prepared.importance,
      })

      const txResult = await pdw.blockchain.tx.execute(tx)
      console.log('📋 Transaction result:', txResult.status, txResult.digest)

      if (txResult.status !== 'success') {
        return { success: false, error: txResult.error || 'Transaction failed' }
      }

      // Extract memory object ID
      const memoryObject = txResult.createdObjects?.find(
        (obj: any) => obj.objectType?.includes('::memory::Memory')
      )
      const memoryId = memoryObject?.objectId

      console.log('✅ Memory saved! ID:', memoryId)

      // Step 5: Index the memory for vector search
      console.log('📇 Step 5: Indexing memory for search...')
      try {
        const indexResponse = await fetch('/api/memory/index', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            walletAddress,
            memoryId,
            vectorId,
            content,
            embedding: prepared.embedding,
            blobId: blobResult.blobId,
            category: prepared.category,
            importance: prepared.importance
          })
        })
        const indexResult = await indexResponse.json()
        if (indexResult.success) {
          console.log('✅ Memory indexed for search')

          // Step 6: Sync index to Walrus (background, non-blocking)
          syncIndexToWalrus(walletAddress)
        } else {
          console.warn('⚠️ Memory indexing failed:', indexResult.error)
        }
      } catch (indexError) {
        console.warn('⚠️ Memory indexing error:', indexError)
        // Don't fail the overall operation - memory is saved, just not indexed yet
      }

      return {
        success: true,
        memoryId,
        blobId: blobResult.blobId,
      }
    } catch (error) {
      console.error('❌ Failed to save memory:', error)
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to save memory'
      }
    } finally {
      setIsPending(false)
    }
  }, [client, initClient, address, isConnected])

  /**
   * Save pre-prepared memory (when embedding/classification already done)
   * Still requires Walrus upload and blockchain signing
   */
  const savePreppedMemory = useCallback(async (
    prepared: PreparedMemory
  ): Promise<SaveMemoryResult> => {
    if (!isConnected || !address) {
      return { success: false, error: 'Wallet not connected' }
    }

    setIsPending(true)

    try {
      // Get or initialize PDW client
      let pdw = client
      if (!pdw) {
        pdw = await initClient()
        if (!pdw) {
          return { success: false, error: 'Failed to initialize PDW client' }
        }
      }

      let blobId = prepared.blobId

      // If no blobId, upload to Walrus first (USER SIGNS)
      if (!blobId) {
        console.log('📤 Uploading memory package to Walrus (user will sign)...')
        const blobResult = await pdw.storage.storeMemoryPackage({
          content: prepared.content,
          contentType: 'text/plain',
          embedding: prepared.embedding,
          metadata: {
            category: prepared.category,
            importance: prepared.importance,
            topic: '',
          },
        })
        blobId = blobResult.blobId
        console.log(`✅ Walrus upload complete, blobId: ${blobId}`)
      }

      // Build and execute blockchain transaction (USER SIGNS)
      console.log('⛓️ Creating memory on blockchain (user will sign)...')
      const vectorId = Date.now() % 4294967295

      // Use buildCreate() - the correct method in BlockchainNamespace.tx
      const tx = pdw.blockchain.tx.buildCreate({
        category: prepared.category,
        vectorId,
        blobId,
        importance: prepared.importance,
      })

      const txResult = await pdw.blockchain.tx.execute(tx)

      if (txResult.status !== 'success') {
        return { success: false, error: txResult.error || 'Transaction failed' }
      }

      const memoryObject = txResult.createdObjects?.find(
        (obj: any) => obj.objectType?.includes('::memory::Memory')
      )
      const memoryId = memoryObject?.objectId

      console.log('✅ Memory saved! ID:', memoryId)

      // Index the memory for vector search
      console.log('📇 Indexing memory for search...')
      try {
        const indexResponse = await fetch('/api/memory/index', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            walletAddress: address,
            memoryId,
            vectorId,
            content: prepared.content,
            embedding: prepared.embedding,
            blobId,
            category: prepared.category,
            importance: prepared.importance
          })
        })
        const indexResult = await indexResponse.json()
        if (indexResult.success) {
          console.log('✅ Memory indexed for search')

          // Sync index to Walrus (background, non-blocking)
          syncIndexToWalrus(address!)
        } else {
          console.warn('⚠️ Memory indexing failed:', indexResult.error)
        }
      } catch (indexError) {
        console.warn('⚠️ Memory indexing error:', indexError)
      }

      return {
        success: true,
        memoryId,
        blobId,
      }
    } catch (error) {
      console.error('❌ Failed to save memory:', error)
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to save memory'
      }
    } finally {
      setIsPending(false)
    }
  }, [client, initClient, address, isConnected])

  return {
    saveMemory,
    savePreppedMemory,
    isPending,
    isConnected,
    address,
  }
}

/**
 * Hook to save multiple memories in batch
 * Each memory requires Walrus upload + blockchain registration
 */
export function useBatchMemoryTransaction() {
  const { client, initClient, address, isConnected } = usePDWClient()
  const [isPending, setIsPending] = useState(false)

  const saveMemories = useCallback(async (
    walletAddress: string,
    contents: string[],
    category?: string
  ): Promise<SaveMemoryResult> => {
    if (!isConnected || !address) {
      return { success: false, error: 'Wallet not connected' }
    }

    if (contents.length === 0) {
      return { success: false, error: 'No contents to save' }
    }

    setIsPending(true)

    try {
      // Get or initialize PDW client
      let pdw = client
      if (!pdw) {
        pdw = await initClient()
        if (!pdw) {
          return { success: false, error: 'Failed to initialize PDW client' }
        }
      }

      // Prepare all memories on server (parallel)
      console.log(`📝 Preparing ${contents.length} memories on server...`)
      const preparePromises = contents.map(content =>
        fetch('/api/memory/prepare', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ content, category, walletAddress })
        }).then(res => res.json())
      )

      const prepareResults = await Promise.all(preparePromises)

      // Check for errors
      const errors = prepareResults.filter(r => !r.success)
      if (errors.length > 0) {
        return { success: false, error: errors[0].error }
      }

      // Upload each to Walrus and create on blockchain
      // Note: Each upload requires user signature
      let successCount = 0
      for (let i = 0; i < prepareResults.length; i++) {
        const prepared = prepareResults[i].prepared
        const content = contents[i]

        try {
          // Step 1: Upload to Walrus using storeMemoryPackage (proper JSON format)
          console.log(`📤 [${i + 1}/${contents.length}] Uploading memory package to Walrus...`)
          const blobResult = await pdw.storage.storeMemoryPackage({
            content: content,
            contentType: 'text/plain',
            embedding: prepared.embedding,
            metadata: {
              category: prepared.category,
              importance: prepared.importance,
              topic: '',
            },
          })

          // Step 2: Create on blockchain
          console.log(`⛓️ [${i + 1}/${contents.length}] Creating on blockchain...`)
          const vectorId = (Date.now() + i) % 4294967295

          // Use buildCreate() - the correct method in BlockchainNamespace.tx
          const tx = pdw.blockchain.tx.buildCreate({
            category: prepared.category,
            vectorId,
            blobId: blobResult.blobId,
            importance: prepared.importance,
          })

          const txResult = await pdw.blockchain.tx.execute(tx)

          if (txResult.status === 'success') {
            successCount++

            // Step 3: Index the memory for search
            const memoryObject = txResult.createdObjects?.find(
              (obj: any) => obj.objectType?.includes('::memory::Memory')
            )
            const memoryId = memoryObject?.objectId

            console.log(`📇 [${i + 1}/${contents.length}] Indexing memory...`)
            try {
              const indexResponse = await fetch('/api/memory/index', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                  walletAddress,
                  memoryId,
                  vectorId,
                  content,
                  embedding: prepared.embedding,
                  blobId: blobResult.blobId,
                  category: prepared.category,
                  importance: prepared.importance
                })
              })
              const indexResult = await indexResponse.json()
              if (indexResult.success) {
                console.log(`   ✅ Memory ${i + 1} indexed`)
              } else {
                console.warn(`   ⚠️ Memory ${i + 1} indexing failed:`, indexResult.error)
              }
            } catch (indexError) {
              console.warn(`   ⚠️ Memory ${i + 1} indexing error:`, indexError)
            }
          }
        } catch (err) {
          console.error(`❌ Failed to save memory ${i + 1}:`, err)
        }
      }

      console.log(`✅ ${successCount}/${contents.length} memories saved`)

      // Sync index to Walrus after batch indexing (background, non-blocking)
      if (successCount > 0) {
        syncIndexToWalrus(walletAddress)
      }

      return {
        success: successCount > 0,
        error: successCount < contents.length
          ? `Only ${successCount}/${contents.length} memories saved`
          : undefined
      }
    } catch (error) {
      console.error('❌ Failed to save memories:', error)
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to save memories'
      }
    } finally {
      setIsPending(false)
    }
  }, [client, initClient, address, isConnected])

  return {
    saveMemories,
    isPending,
    isConnected,
  }
}
