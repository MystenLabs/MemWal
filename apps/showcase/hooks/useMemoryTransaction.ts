'use client'

import { useSignAndExecuteTransaction, useSuiClient } from '@mysten/dapp-kit'
import { Transaction } from '@mysten/sui/transactions'
import { useCallback, useState } from 'react'

export interface PreparedMemory {
  content: string
  blobId: string
  embedding: number[]
  category: string
  importance: number
  metadata?: {
    createdAt: number
    walletAddress: string
  }
  graph?: any
}

interface SaveMemoryResult {
  success: boolean
  memoryId?: string
  error?: string
}

/**
 * Hook to save memory to blockchain using Slush wallet for signing
 */
export function useMemoryTransaction() {
  const suiClient = useSuiClient()
  const { mutateAsync: signAndExecute } = useSignAndExecuteTransaction()
  const [isPending, setIsPending] = useState(false)

  const packageId = process.env.NEXT_PUBLIC_PACKAGE_ID

  const saveMemory = useCallback(async (
    walletAddress: string,
    content: string,
    category?: string
  ): Promise<SaveMemoryResult> => {
    if (!packageId) {
      return { success: false, error: 'NEXT_PUBLIC_PACKAGE_ID not configured' }
    }

    setIsPending(true)

    try {
      // Step 1: Prepare memory data on server (embedding, classification, Walrus upload)
      const prepareResponse = await fetch('/api/memory/save', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content, category, walletAddress })
      })

      const prepareResult = await prepareResponse.json()

      if (!prepareResult.success) {
        return { success: false, error: prepareResult.error }
      }

      const prepared: PreparedMemory = prepareResult.prepared

      // Step 2: Build transaction to save memory to blockchain
      const tx = new Transaction()

      // Call the smart contract's create_memory function
      tx.moveCall({
        target: `${packageId}::memory::create_memory`,
        arguments: [
          tx.pure.string(prepared.blobId),           // blob_id
          tx.pure.vector('u64', prepared.embedding), // embedding
          tx.pure.u8(getCategoryCode(prepared.category)), // category
          tx.pure.u8(prepared.importance),           // importance
        ],
      })

      // Step 3: Sign and execute with Slush wallet
      const result = await signAndExecute({
        transaction: tx,
      })

      console.log('✅ Memory saved to blockchain:', result)

      // Extract memory object ID from transaction result
      const memoryId = result.effects?.created?.[0]?.reference?.objectId

      return {
        success: true,
        memoryId,
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
  }, [packageId, signAndExecute])

  /**
   * Save pre-prepared memory directly to blockchain
   * Use this when data is already prepared by extract-memory endpoint
   */
  const savePreppedMemory = useCallback(async (
    prepared: PreparedMemory
  ): Promise<SaveMemoryResult> => {
    if (!packageId) {
      return { success: false, error: 'NEXT_PUBLIC_PACKAGE_ID not configured' }
    }

    setIsPending(true)

    try {
      // Build transaction to save memory to blockchain
      const tx = new Transaction()

      // Call the smart contract's create_memory function
      tx.moveCall({
        target: `${packageId}::memory::create_memory`,
        arguments: [
          tx.pure.string(prepared.blobId),           // blob_id
          tx.pure.vector('u64', prepared.embedding), // embedding
          tx.pure.u8(getCategoryCode(prepared.category)), // category
          tx.pure.u8(prepared.importance),           // importance
        ],
      })

      // Sign and execute with Slush wallet
      const result = await signAndExecute({
        transaction: tx,
      })

      console.log('✅ Memory saved to blockchain:', result)

      // Extract memory object ID from transaction result
      const memoryId = result.effects?.created?.[0]?.reference?.objectId

      return {
        success: true,
        memoryId,
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
  }, [packageId, signAndExecute])

  return {
    saveMemory,
    savePreppedMemory,
    isPending,
  }
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
    'custom': 8,
  }
  return categories[category.toLowerCase()] ?? 8 // default to custom
}

/**
 * Hook to save multiple memories in a batch transaction
 */
export function useBatchMemoryTransaction() {
  const { mutateAsync: signAndExecute } = useSignAndExecuteTransaction()
  const [isPending, setIsPending] = useState(false)

  const packageId = process.env.NEXT_PUBLIC_PACKAGE_ID

  const saveMemories = useCallback(async (
    walletAddress: string,
    contents: string[],
    category?: string
  ): Promise<SaveMemoryResult> => {
    if (!packageId) {
      return { success: false, error: 'NEXT_PUBLIC_PACKAGE_ID not configured' }
    }

    if (contents.length === 0) {
      return { success: false, error: 'No contents to save' }
    }

    setIsPending(true)

    try {
      // Prepare all memories in parallel
      const preparePromises = contents.map(content =>
        fetch('/api/memory/save', {
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

      // Build batch transaction
      const tx = new Transaction()

      for (const result of prepareResults) {
        const prepared: PreparedMemory = result.prepared

        tx.moveCall({
          target: `${packageId}::memory::create_memory`,
          arguments: [
            tx.pure.string(prepared.blobId),
            tx.pure.vector('u64', prepared.embedding),
            tx.pure.u8(getCategoryCode(prepared.category)),
            tx.pure.u8(prepared.importance),
          ],
        })
      }

      // Sign and execute batch with Slush wallet
      const result = await signAndExecute({
        transaction: tx,
      })

      console.log(`✅ ${contents.length} memories saved to blockchain:`, result)

      return { success: true }
    } catch (error) {
      console.error('❌ Failed to save memories:', error)
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to save memories'
      }
    } finally {
      setIsPending(false)
    }
  }, [packageId, signAndExecute])

  return {
    saveMemories,
    isPending,
  }
}
