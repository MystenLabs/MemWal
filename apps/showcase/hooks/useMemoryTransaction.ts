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

interface BatchSaveResult {
  success: boolean
  successCount: number
  failCount: number
  memories?: Array<{ memoryId?: string; blobId: string }>
  error?: string
}

/**
 * Hook to save multiple memories in batch using Walrus Quilt
 * Uses SDK's memory.createBatch() for efficient single-transaction batch upload
 */
export function useBatchMemoryTransaction() {
  const { client, initClient, address, isConnected } = usePDWClient()
  const [isPending, setIsPending] = useState(false)

  /**
   * Save pre-prepared memories using Walrus Quilt batch upload
   * ~90% gas savings compared to individual uploads
   */
  const savePreppedMemoriesBatch = useCallback(async (
    preparedMemories: PreparedMemory[]
  ): Promise<BatchSaveResult> => {
    if (!isConnected || !address) {
      return { success: false, successCount: 0, failCount: preparedMemories.length, error: 'Wallet not connected' }
    }

    if (preparedMemories.length === 0) {
      return { success: false, successCount: 0, failCount: 0, error: 'No memories to save' }
    }

    // For single memory, use regular save
    if (preparedMemories.length === 1) {
      // Import savePreppedMemory behavior for single item
      const prepared = preparedMemories[0]
      setIsPending(true)
      try {
        let pdw = client
        if (!pdw) {
          pdw = await initClient()
          if (!pdw) {
            return { success: false, successCount: 0, failCount: 1, error: 'Failed to initialize PDW client' }
          }
        }

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

        const vectorId = Date.now() % 4294967295
        const tx = pdw.blockchain.tx.buildCreate({
          category: prepared.category,
          vectorId,
          blobId: blobResult.blobId,
          importance: prepared.importance,
        })

        const txResult = await pdw.blockchain.tx.execute(tx)

        if (txResult.status !== 'success') {
          return { success: false, successCount: 0, failCount: 1, error: txResult.error || 'Transaction failed' }
        }

        const memoryObject = txResult.createdObjects?.find(
          (obj: any) => obj.objectType?.includes('::memory::Memory')
        )
        const memoryId = memoryObject?.objectId

        // Index the memory
        try {
          await fetch('/api/memory/index', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              walletAddress: address,
              memoryId,
              vectorId,
              content: prepared.content,
              embedding: prepared.embedding,
              blobId: blobResult.blobId,
              category: prepared.category,
              importance: prepared.importance
            })
          })
        } catch (e) {
          console.warn('Index failed:', e)
        }

        syncIndexToWalrus(address!)

        return {
          success: true,
          successCount: 1,
          failCount: 0,
          memories: [{ memoryId, blobId: blobResult.blobId }]
        }
      } catch (error) {
        return {
          success: false,
          successCount: 0,
          failCount: 1,
          error: error instanceof Error ? error.message : 'Failed to save memory'
        }
      } finally {
        setIsPending(false)
      }
    }

    setIsPending(true)

    try {
      // Get or initialize PDW client
      let pdw = client
      if (!pdw) {
        pdw = await initClient()
        if (!pdw) {
          return { success: false, successCount: 0, failCount: preparedMemories.length, error: 'Failed to initialize PDW client' }
        }
      }

      console.log(`📦 Batch uploading ${preparedMemories.length} memories using Walrus Quilt...`)

      // Prepare batch memories for QuiltBatchManager
      // IMPORTANT: Format as JSON package (same as single upload via storeMemoryPackage)
      // This ensures sync-missing can parse the content correctly
      const batchMemories = preparedMemories.map((prepared, i) => {
        // Create JSON package matching StorageService.uploadMemoryPackage format
        const memoryPackage = {
          content: prepared.content,
          embedding: prepared.embedding,
          metadata: {
            category: prepared.category,
            importance: prepared.importance,
            topic: '',
          },
          timestamp: Date.now(),
          version: '1.0'
        }
        const packageJson = JSON.stringify(memoryPackage)

        return {
          content: prepared.content,
          category: prepared.category as 'general' | 'preference' | 'fact' | 'todo' | 'note',
          importance: prepared.importance,
          topic: '',
          embedding: prepared.embedding,
          encryptedContent: new TextEncoder().encode(packageJson),  // JSON package, not raw text!
          id: `memory-${Date.now()}-${i}`
        }
      })

      // Step 1: Batch upload to Walrus using Quilt (requires user to sign 2 transactions)
      // - Transaction 1: Register blob on-chain
      // - Transaction 2: Certify upload on-chain
      console.log('📤 Uploading batch to Walrus via Quilt (user will sign 2 transactions)...')

      // Get signer from PDW client config (same as storeMemoryPackage does internally)
      const pdwConfig = pdw.getConfig()

      const quiltResult = await pdw.storage.uploadMemoryBatch(
        batchMemories,
        {
          signer: pdwConfig.signer,  // Pass signer from PDW config
          epochs: 3,
          userAddress: pdwConfig.userAddress
        }
      )

      console.log(`✅ Quilt upload complete: ${quiltResult.files.length} files in ${quiltResult.uploadTimeMs}ms`)

      // Step 2: Register each memory on blockchain
      const savedMemories: Array<{ memoryId?: string; blobId: string }> = []
      let successCount = 0
      let failCount = 0

      for (let i = 0; i < quiltResult.files.length; i++) {
        const file = quiltResult.files[i]
        const prepared = preparedMemories[i]

        try {
          console.log(`⛓️ [${i + 1}/${quiltResult.files.length}] Registering on blockchain...`)
          const vectorId = (Date.now() + i) % 4294967295

          const tx = pdw.blockchain.tx.buildCreate({
            category: prepared.category,
            vectorId,
            blobId: file.blobId,
            importance: prepared.importance,
          })

          const txResult = await pdw.blockchain.tx.execute(tx)

          if (txResult.status === 'success') {
            successCount++
            const memoryObject = txResult.createdObjects?.find(
              (obj: any) => obj.objectType?.includes('::memory::Memory')
            )
            const memoryId = memoryObject?.objectId
            savedMemories.push({ memoryId, blobId: file.blobId })

            // Index the memory
            try {
              await fetch('/api/memory/index', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                  walletAddress: address,
                  memoryId,
                  vectorId,
                  content: prepared.content,
                  embedding: prepared.embedding,
                  blobId: file.blobId,
                  category: prepared.category,
                  importance: prepared.importance
                })
              })
              console.log(`   ✅ Memory ${i + 1} registered and indexed`)
            } catch (indexError) {
              console.warn(`   ⚠️ Memory ${i + 1} indexing failed:`, indexError)
            }
          } else {
            failCount++
            console.error(`   ❌ Memory ${i + 1} blockchain registration failed:`, txResult.error)
          }
        } catch (err) {
          failCount++
          console.error(`   ❌ Memory ${i + 1} failed:`, err)
        }
      }

      console.log(`\n📊 Batch complete: ${successCount} succeeded, ${failCount} failed`)

      // Sync index to Walrus (background)
      if (successCount > 0) {
        syncIndexToWalrus(address!)
      }

      return {
        success: successCount > 0,
        successCount,
        failCount,
        memories: savedMemories,
        error: failCount > 0 ? `${failCount}/${preparedMemories.length} memories failed` : undefined
      }
    } catch (error) {
      console.error('❌ Batch save failed:', error)
      return {
        success: false,
        successCount: 0,
        failCount: preparedMemories.length,
        error: error instanceof Error ? error.message : 'Failed to save memories'
      }
    } finally {
      setIsPending(false)
    }
  }, [client, initClient, address, isConnected])

  /**
   * Legacy: Save memories one by one (less efficient)
   */
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
      let pdw = client
      if (!pdw) {
        pdw = await initClient()
        if (!pdw) {
          return { success: false, error: 'Failed to initialize PDW client' }
        }
      }

      // Use SDK's createBatch which uses Quilt internally
      console.log(`📦 Creating ${contents.length} memories via SDK batch...`)
      const memories = await pdw.memory.createBatch(contents, {
        category: category as any,
        importance: 5
      })

      console.log(`✅ ${memories.length} memories created`)

      // Sync index to Walrus (background)
      syncIndexToWalrus(walletAddress)

      return {
        success: true,
        memoryId: memories[0]?.id
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
    savePreppedMemoriesBatch,
    isPending,
    isConnected,
  }
}
