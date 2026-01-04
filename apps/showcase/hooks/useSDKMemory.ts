'use client'

import { useCallback, useState } from 'react'
import { usePDWClient } from './usePDWClient'

export interface MemorySaveResult {
  success: boolean
  memoryId?: string
  blobId?: string
  error?: string
}

export interface MemorySaveStatus {
  stage: 'idle' | 'preparing' | 'uploading' | 'signing' | 'indexing' | 'done' | 'error'
  message: string
}

/**
 * Hook to save memories using full SDK flow with DappKitSigner
 *
 * This demonstrates the proper way to use the SDK:
 * - SDK handles Walrus upload
 * - SDK handles blockchain transaction (with wallet signing via adapter)
 * - SDK handles local indexing
 *
 * Flow:
 * 1. pdw.memory.create() is called
 * 2. SDK generates embedding
 * 3. SDK uploads to Walrus (triggers wallet popup)
 * 4. SDK saves to blockchain (triggers wallet popup)
 * 5. SDK indexes locally
 *
 * @example
 * ```typescript
 * const { saveMemory, isPending, status } = useSDKMemory()
 *
 * const result = await saveMemory('I love TypeScript', {
 *   category: 'preference',
 *   importance: 8,
 * })
 * ```
 */
export function useSDKMemory() {
  const { pdw, isReady, walletAddress } = usePDWClient()

  const [isPending, setIsPending] = useState(false)
  const [status, setStatus] = useState<MemorySaveStatus>({ stage: 'idle', message: '' })

  /**
   * Save memory using SDK's full flow
   *
   * @param content - Memory content to save
   * @param options - Optional category, importance, topic
   */
  const saveMemory = useCallback(async (
    content: string,
    options?: {
      category?: 'fact' | 'preference' | 'todo' | 'note' | 'general'
      importance?: number
      topic?: string
    }
  ): Promise<MemorySaveResult> => {
    if (!isReady || !pdw) {
      return { success: false, error: 'SDK not ready. Please connect wallet.' }
    }

    setIsPending(true)
    setStatus({ stage: 'preparing', message: 'Preparing memory...' })

    try {
      // SDK handles everything:
      // 1. Generate embedding
      // 2. Upload to Walrus (wallet popup)
      // 3. Save to blockchain (wallet popup)
      // 4. Index locally
      const memory = await pdw.memory.create(content, {
        category: options?.category || 'general',
        importance: options?.importance || 5,
        topic: options?.topic,
        onProgress: (stage, percent) => {
          // Map SDK stages to our status
          const stageMap: Record<string, MemorySaveStatus['stage']> = {
            'analyzing': 'preparing',
            'classifying': 'preparing',
            'generating embedding': 'preparing',
            'encrypting': 'preparing',
            'uploading to Walrus': 'uploading',
            'registering on blockchain': 'signing',
            'indexing vector': 'indexing',
            'extracting knowledge graph': 'indexing',
            'complete': 'done',
          }

          setStatus({
            stage: stageMap[stage] || 'preparing',
            message: `${stage} (${percent}%)`,
          })
        },
      })

      setStatus({ stage: 'done', message: 'Memory saved successfully!' })

      return {
        success: true,
        memoryId: memory.id,
        blobId: memory.blobId,
      }

    } catch (error) {
      console.error('❌ SDK memory save failed:', error)
      setStatus({
        stage: 'error',
        message: error instanceof Error ? error.message : 'Save failed',
      })
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Save failed',
      }
    } finally {
      setIsPending(false)
    }
  }, [pdw, isReady])

  /**
   * Search memories using SDK
   */
  const searchMemories = useCallback(async (
    query: string,
    options?: { limit?: number; category?: string }
  ) => {
    if (!isReady || !pdw) {
      throw new Error('SDK not ready')
    }

    return await pdw.search.vector(query, {
      limit: options?.limit || 10,
      category: options?.category,
      fetchContent: true,
    })
  }, [pdw, isReady])

  /**
   * Reset status to idle
   */
  const resetStatus = useCallback(() => {
    setStatus({ stage: 'idle', message: '' })
  }, [])

  return {
    saveMemory,
    searchMemories,
    isPending,
    status,
    resetStatus,
    isReady,
    walletAddress,
  }
}
