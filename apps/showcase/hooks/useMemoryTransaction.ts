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
  blobId?: string
}

interface SaveMemoryResult {
  success: boolean
  memoryId?: string
  blobId?: string
  error?: string
}

/**
 * Hook to save memory using client-side PDW SDK with Slush wallet signing
 *
 * Simplified version that delegates all logic to SDK:
 * - SDK handles: upload to Walrus, encryption, blockchain tx, capability management
 * - App only handles: preparation (embedding, classify) and indexing
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

      // Step 2: Get or initialize PDW client
      console.log('🔧 Step 2: Initializing PDW client...')
      let pdw = client
      if (!pdw) {
        pdw = await initClient()
        if (!pdw) {
          return { success: false, error: 'Failed to initialize PDW client' }
        }
      }

      // Step 3: Use SDK to handle everything (upload, encrypt, blockchain, capability)
      console.log('🚀 Step 3: Creating memory via SDK (handles upload, encryption, blockchain)...')
      const memory = await pdw.memory.create(content, {
        category: prepared.category as any,
        importance: prepared.importance,
        embedding: prepared.embedding // Pass pre-generated embedding for v2.2 encryption
      })

      console.log('✅ Memory created via SDK:', memory.id)

      // Step 4: Index the memory for vector search (server-side)
      console.log('📇 Step 4: Indexing memory for search...')
      try {
        const indexResponse = await fetch('/api/memory/index', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            walletAddress,
            memoryId: memory.id,
            vectorId: memory.vectorId,
            content,
            embedding: prepared.embedding,
            blobId: memory.blobId,
            category: prepared.category,
            importance: prepared.importance,
            isEncrypted: true
          })
        })
        const indexResult = await indexResponse.json()
        if (indexResult.success) {
          console.log('✅ Memory indexed for search')

          // Sync index to Walrus (background, non-blocking)
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
        memoryId: memory.id,
        blobId: memory.blobId,
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
   * Still requires SDK to handle upload, encryption, blockchain
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

      // Use SDK to handle everything
      console.log('🚀 Creating memory via SDK...')
      const memory = await pdw.memory.create(prepared.content, {
        category: prepared.category as any,
        importance: prepared.importance,
        embedding: prepared.embedding // Pass pre-generated embedding for v2.2 encryption
      })

      console.log('✅ Memory created via SDK:', memory.id)

      // Index the memory for vector search
      console.log('📇 Indexing memory for search...')
      try {
        const indexResponse = await fetch('/api/memory/index', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            walletAddress: address,
            memoryId: memory.id,
            vectorId: memory.vectorId,
            content: prepared.content,
            embedding: prepared.embedding,
            blobId: memory.blobId,
            category: prepared.category,
            importance: prepared.importance,
            isEncrypted: true
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
        memoryId: memory.id,
        blobId: memory.blobId,
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
   * Save pre-prepared memories using SDK's createBatch()
   * SDK handles: Quilt batch upload, encryption, blockchain tx, capability
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

      console.log(`📦 Batch creating ${preparedMemories.length} memories via SDK...`)

      // Use SDK's createBatch() which handles everything
      // Pass pre-generated embeddings, importances, and categories for each memory
      const contents = preparedMemories.map(p => p.content)
      const embeddings = preparedMemories.map(p => p.embedding)
      const importances = preparedMemories.map(p => p.importance)
      const categories = preparedMemories.map(p => p.category)

      const memories = await pdw.memory.createBatch(contents, {
        embeddings,     // Pre-generated embeddings from server
        importances,    // Per-memory importance from AI classification
        categories,     // Per-memory category from AI classification
      })

      console.log(`✅ ${memories.length} memories created via SDK`)

      // Index all memories
      let successCount = 0
      let failCount = 0
      const savedMemories: Array<{ memoryId?: string; blobId: string }> = []

      for (let i = 0; i < memories.length; i++) {
        const memory = memories[i]
        const prepared = preparedMemories[i]

        try {
          await fetch('/api/memory/index', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              walletAddress: address,
              memoryId: memory.id,
              vectorId: memory.vectorId,
              content: prepared.content,
              embedding: prepared.embedding,
              blobId: memory.blobId,
              category: prepared.category,
              importance: prepared.importance,
              isEncrypted: true
            })
          })
          successCount++
          savedMemories.push({ memoryId: memory.id, blobId: memory.blobId })
        } catch (e) {
          failCount++
          console.warn(`Index failed for memory ${i}:`, e)
        }
      }

      console.log(`📊 Batch complete: ${successCount} indexed, ${failCount} failed`)

      // Sync index to Walrus (background)
      if (successCount > 0) {
        syncIndexToWalrus(address!)
      }

      return {
        success: successCount > 0,
        successCount,
        failCount,
        memories: savedMemories,
        error: failCount > 0 ? `${failCount}/${preparedMemories.length} memories failed indexing` : undefined
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
   * Legacy: Save memories from raw content (less efficient than pre-prepared)
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

      // Use SDK's createBatch which handles everything
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
