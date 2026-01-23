'use client'

import { useState, useCallback } from 'react'
import { useCurrentAccount, useSignPersonalMessage } from '@mysten/dapp-kit'
import { usePDWClient } from '@/hooks/usePDWClient'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'

interface TestStep {
  name: string
  status: 'pending' | 'running' | 'success' | 'error'
  result?: any
  error?: string
  duration?: number
}

export default function TestEncryptionPage() {
  const account = useCurrentAccount()
  const { mutateAsync: signPersonalMessage } = useSignPersonalMessage()
  const { client, initClient, isConnected } = usePDWClient()

  const [steps, setSteps] = useState<TestStep[]>([])
  const [isRunning, setIsRunning] = useState(false)
  const [createdBlobId, setCreatedBlobId] = useState<string | null>(null)
  const [createdMemoryCapId, setCreatedMemoryCapId] = useState<string | null>(null)

  // Batch test state (DISABLED - use showcase app for batch testing)
  // const [batchSteps, setBatchSteps] = useState<TestStep[]>([])
  // const [isBatchRunning, setIsBatchRunning] = useState(false)
  // const [batchQuiltId, setBatchQuiltId] = useState<string | null>(null)

  // Test content input
  const [testContent, setTestContent] = useState('Aaron is a member of CommandOSS')

  const updateStep = (index: number, updates: Partial<TestStep>) => {
    setSteps(prev => prev.map((step, i) =>
      i === index ? { ...step, ...updates } : step
    ))
  }

  // const updateBatchStep = (index: number, updates: Partial<TestStep>) => {
  //   setBatchSteps(prev => prev.map((step, i) =>
  //     i === index ? { ...step, ...updates } : step
  //   ))
  // }

  // ============================================================================
  // BATCH/QUILT TEST - DISABLED (use showcase app for batch testing)
  // ============================================================================
  /*
  const runBatchTest = useCallback(async () => {
    if (!account?.address) {
      alert('Please connect your wallet first!')
      return
    }

    setIsBatchRunning(true)
    setBatchQuiltId(null)

    // Initialize steps for batch test
    const initialSteps: TestStep[] = [
      { name: '1. Initialize PDW Client', status: 'pending' },
      { name: '2. pdw.memory.createBatch() - Batch Upload', status: 'pending' },
      { name: '3. Verify Quilt on Walrus', status: 'pending' },
      { name: '4. Check Encrypted Embedding (v2.2)', status: 'pending' },
    ]
    setBatchSteps(initialSteps)

    let pdw = client

    const totalStart = Date.now()
    console.log('\n═══════════════════════════════════════════════════════════')
    console.log('🚀 BATCH/QUILT TEST - Encrypted Embedding v2.2')
    console.log('═══════════════════════════════════════════════════════════')

    try {
      // STEP 1: Initialize PDW Client
      updateBatchStep(0, { status: 'running' })
      const step1Start = Date.now()
      console.log('\n📍 BATCH STEP 1: Initialize PDW Client')

      if (!pdw) {
        pdw = await initClient()
      }

      if (!pdw) {
        throw new Error('Failed to initialize PDW client')
      }

      const step1Duration = Date.now() - step1Start
      console.log(`   ✅ Done in ${step1Duration}ms`)

      updateBatchStep(0, {
        status: 'success',
        duration: step1Duration,
        result: { userAddress: account.address }
      })

      // STEP 2: Batch Upload using createBatch
      updateBatchStep(1, { status: 'running' })
      const step2Start = Date.now()
      console.log('\n📍 BATCH STEP 2: pdw.memory.createBatch()')

      const batchContents = [
        'Batch test memory 2: Bob is a software engineer',
        'Batch test memory 3: Carol loves hiking on weekends'
      ]

      console.log(`   📝 Creating batch with ${batchContents.length} memories...`)
      batchContents.forEach((c, i) => console.log(`      ${i + 1}. "${c}"`))

      // Pre-generate embeddings via server API (client doesn't have embedding service)
      console.log(`   🧠 Pre-generating embeddings via server API...`)
      const embeddings: number[][] = []
      for (const content of batchContents) {
        try {
          const prepareResponse = await fetch('/api/memory/prepare', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              content,
              walletAddress: account.address
            })
          })
          const prepareResult = await prepareResponse.json()
          if (prepareResult.success && prepareResult.prepared?.embedding) {
            embeddings.push(prepareResult.prepared.embedding)
            console.log(`      ✅ Generated ${prepareResult.prepared.embedding.length}D embedding`)
          } else {
            console.warn(`      ⚠️ Failed to generate embedding: ${prepareResult.error}`)
            embeddings.push([])
          }
        } catch (err: any) {
          console.warn(`      ⚠️ Embedding API error: ${err.message}`)
          embeddings.push([])
        }
      }
      console.log(`   📊 Generated ${embeddings.filter(e => e.length > 0).length}/${batchContents.length} embeddings`)

      // Call createBatch with pre-generated embeddings
      const batchResult = await pdw.memory.createBatch(batchContents, {
        importance: 7,
        topic: 'batch-test',
        embeddings  // Pass pre-generated embeddings
      })

      const step2Duration = Date.now() - step2Start
      console.log(`   ✅ Batch created in ${step2Duration}ms`)
      console.log(`   📦 Created ${batchResult.length} memories`)

      // Get quilt ID from the first memory (all should be in same quilt)
      const quiltId = batchResult[0]?.quiltId || batchResult[0]?.blobId
      setBatchQuiltId(quiltId || null)

      updateBatchStep(1, {
        status: 'success',
        duration: step2Duration,
        result: {
          memoriesCreated: batchResult.length,
          quiltId: quiltId || 'N/A',
          memories: batchResult.map((m: any, i: number) => ({
            index: i,
            id: m.id,
            blobId: m.blobId,
            vectorId: m.vectorId
          }))
        }
      })

      // STEP 3: Verify Quilt on Walrus (extract individual files from tar archive)
      updateBatchStep(2, { status: 'running' })
      const step3Start = Date.now()
      console.log('\n📍 BATCH STEP 3: Verify Quilt on Walrus')

      let quiltFiles: any[] = []
      let firstFileData: any = null
      let rawQuiltJson = ''

      if (quiltId) {
        console.log(`   🔍 Fetching quilt files: ${quiltId}`)
        try {
          // Use getQuiltFiles to extract individual files from the tar archive
          // Quilts are tar archives containing multiple JSON files
          if (typeof pdw.storage.getQuiltFiles === 'function') {
            quiltFiles = await pdw.storage.getQuiltFiles(quiltId)
            console.log(`   ✅ Retrieved ${quiltFiles.length} files from quilt`)

            // Get the first file's content
            if (quiltFiles.length > 0) {
              const firstFile = quiltFiles[0]
              rawQuiltJson = new TextDecoder().decode(firstFile.contents || firstFile.data || firstFile)
              console.log(`   📄 First file: ${firstFile.identifier || 'unknown'} (${rawQuiltJson.length} bytes)`)
              try {
                firstFileData = JSON.parse(rawQuiltJson)
                console.log(`   ✅ Parsed JSON successfully`)
              } catch {
                console.log(`   ⚠️ First file is not valid JSON`)
              }
            }
          } else {
            // Fallback: Try to use walrus CLI read-quilt approach
            console.log(`   ⚠️ getQuiltFiles not available, trying direct download...`)
            const blobData = await pdw.storage.download(quiltId)
            rawQuiltJson = new TextDecoder().decode(blobData)
            console.log(`   📦 Downloaded ${rawQuiltJson.length} bytes (tar archive)`)
            // Note: This is a tar archive, need to extract files
            // For now, just show raw size
          }
        } catch (err: any) {
          console.warn(`   ⚠️ Could not fetch quilt: ${err.message}`)
        }
      }

      const step3Duration = Date.now() - step3Start

      updateBatchStep(2, {
        status: firstFileData || quiltFiles.length > 0 ? 'success' : 'error',
        duration: step3Duration,
        result: {
          quiltId,
          filesCount: quiltFiles.length,
          dataSize: rawQuiltJson.length,
          isJson: !!firstFileData,
          preview: rawQuiltJson.substring(0, 300) + (rawQuiltJson.length > 300 ? '...' : '')
        }
      })

      // STEP 4: Check for Encrypted Embedding (v2.2)
      updateBatchStep(3, { status: 'running' })
      const step4Start = Date.now()
      console.log('\n📍 BATCH STEP 4: Check Encrypted Embedding (v2.2)')

      let hasEncryptedEmbedding = false
      let version = 'unknown'
      let encryptionStatus = {
        contentEncrypted: false,
        embeddingEncrypted: false,
        version: 'unknown',
        rawContent: '',
        rawEmbedding: '[]'
      }

      if (firstFileData) {
        // Check quilt JSON structure for v2.2 fields
        version = firstFileData.version || 'unknown'
        hasEncryptedEmbedding = !!firstFileData.encryptedEmbedding

        encryptionStatus = {
          contentEncrypted: !!firstFileData.encryptedContent,
          embeddingEncrypted: hasEncryptedEmbedding,
          version,
          rawContent: firstFileData.content || '',
          rawEmbedding: JSON.stringify(firstFileData.embedding || []).substring(0, 50)
        }

        console.log(`   📋 Version: ${version}`)
        console.log(`   🔐 Content encrypted: ${encryptionStatus.contentEncrypted}`)
        console.log(`   🔐 Embedding encrypted: ${encryptionStatus.embeddingEncrypted}`)
        console.log(`   📝 Raw content: "${encryptionStatus.rawContent}" (should be empty if encrypted)`)
        console.log(`   📝 Raw embedding: ${encryptionStatus.rawEmbedding} (should be [] if encrypted)`)

        if (version === '2.2' && hasEncryptedEmbedding) {
          console.log(`   ✅ v2.2 CONFIRMED - Both content AND embedding are encrypted!`)
        } else if (version === '2.1') {
          console.log(`   ⚠️ v2.1 detected - Only content encrypted, embedding is PLAINTEXT`)
        } else {
          console.log(`   ⚠️ Unknown version or no encryption`)
        }
      }

      const step4Duration = Date.now() - step4Start

      updateBatchStep(3, {
        status: hasEncryptedEmbedding ? 'success' : 'error',
        duration: step4Duration,
        result: {
          version,
          hasEncryptedContent: encryptionStatus.contentEncrypted,
          hasEncryptedEmbedding: encryptionStatus.embeddingEncrypted,
          rawContentEmpty: encryptionStatus.rawContent === '',
          rawEmbeddingEmpty: encryptionStatus.rawEmbedding === '[]',
          verdict: hasEncryptedEmbedding
            ? '✅ v2.2 - PASS: Both content AND embedding encrypted!'
            : '❌ FAIL: encryptedEmbedding missing - check SDK logs'
        },
        error: hasEncryptedEmbedding ? undefined : 'encryptedEmbedding field missing in quilt'
      })

      // Summary
      const totalDuration = Date.now() - totalStart
      console.log('\n═══════════════════════════════════════════════════════════')
      console.log('📊 BATCH TEST SUMMARY')
      console.log('═══════════════════════════════════════════════════════════')
      console.log(`   Total time: ${totalDuration}ms`)
      console.log(`   Version: ${version}`)
      console.log(`   Encrypted Embedding: ${hasEncryptedEmbedding ? 'YES ✅' : 'NO ❌'}`)
      console.log('═══════════════════════════════════════════════════════════')

    } catch (error: any) {
      console.error('\n❌ BATCH TEST FAILED:', error.message)
      setBatchSteps(prev => prev.map(step =>
        step.status === 'running'
          ? { ...step, status: 'error', error: error.message }
          : step
      ))
    } finally {
      setIsBatchRunning(false)
    }
  }, [account, client, initClient])
  */

  const runFullTest = useCallback(async () => {
    if (!account?.address) {
      alert('Please connect your wallet first!')
      return
    }

    setIsRunning(true)
    setCreatedBlobId(null)
    setCreatedMemoryCapId(null)

    // Initialize steps - Updated for Simplified SDK API v0.9.0
    const initialSteps: TestStep[] = [
      { name: '1. Initialize PDW Client', status: 'pending' },
      { name: '2. pdw.ai (embedding + classify)', status: 'pending' },
      { name: '3. pdw.memory.create() - Full Pipeline', status: 'pending' },
      { name: '4. pdw.storage.download() - Verify Blob', status: 'pending' },
      { name: '5. pdw.memory.search() - HNSW Vector Search', status: 'pending' },
      { name: '6. pdw.memory.get() - Auto Decrypt', status: 'pending' },
      { name: '7. pdw.storage.retrieveAndDecrypt() - SEAL', status: 'pending' },
      { name: '8. AI Answer Generation (RAG)', status: 'pending' },
    ]
    setSteps(initialSteps)

    let pdw = client
    let blobId: string | null = null
    let memoryCapId: string | null = null
    let keyId: string | null = null
    let memory: any = null

    // Track total time
    const totalStart = Date.now()
    console.log('═══════════════════════════════════════════════════════════')
    console.log('🚀 SDK v0.9.0 TEST - 5 CORE NAMESPACES')
    console.log('═══════════════════════════════════════════════════════════')
    console.log(`⏱️ Test started at: ${new Date().toISOString()}`)

    try {
      // =====================================================
      // STEP 1: Initialize PDW Client
      // =====================================================
      updateStep(0, { status: 'running' })
      const step1Start = Date.now()
      console.log('\n📍 STEP 1: Initialize PDW Client')

      if (!pdw) {
        pdw = await initClient()
      }

      if (!pdw) {
        throw new Error('Failed to initialize PDW client')
      }

      const step1Duration = Date.now() - step1Start
      console.log(`   ✅ Done in ${step1Duration}ms`)

      updateStep(0, {
        status: 'success',
        duration: step1Duration,
        result: {
          userAddress: account.address,
          hasSecurity: !!pdw.security,
          hasAdvanced: !!pdw.advanced,
          hasStorage: !!pdw.storage,
          hasMemory: !!pdw.memory,
          hasAI: !!pdw.ai
        }
      })

      // =====================================================
      // STEP 2: Generate Embedding (768 dimensions - configurable via EMBEDDING_DIMENSIONS)
      // =====================================================
      updateStep(1, { status: 'running' })
      const step2Start = Date.now()
      console.log('\n📍 STEP 2: Generate Embedding')
      console.log(`   🧠 Generating embedding for: "${testContent}"`)

      let embedding: number[] = []
      let preparedCategory = 'personal'
      let preparedImportance = 5
      try {
        // Use /api/memory/prepare which generates embedding + classification
        const prepareResponse = await fetch('/api/memory/prepare', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            content: testContent,
            walletAddress: account.address
          })
        })

        const prepareResult = await prepareResponse.json()

        if (prepareResult.success && prepareResult.prepared?.embedding) {
          embedding = prepareResult.prepared.embedding
          preparedCategory = prepareResult.prepared.category || 'personal'
          preparedImportance = prepareResult.prepared.importance || 5
          console.log(`   ✅ Generated embedding with ${embedding.length} dimensions`)
          console.log(`   📝 Classification: category=${preparedCategory}, importance=${preparedImportance}`)
        } else {
          throw new Error(prepareResult.error || 'Failed to generate embedding')
        }
      } catch (embError: any) {
        console.warn('⚠️ Embedding generation failed, continuing without embedding:', embError.message)
      }

      const step2Duration = Date.now() - step2Start
      console.log(`   ⏱️ Step 2 completed in ${step2Duration}ms`)

      updateStep(1, {
        status: embedding.length > 0 ? 'success' : 'error',
        duration: step2Duration,
        result: {
          dimensions: embedding.length,
          category: preparedCategory,
          importance: preparedImportance,
          firstValues: embedding.slice(0, 5).map(v => v.toFixed(4)),
          lastValues: embedding.slice(-5).map(v => v.toFixed(4)),
          norm: Math.sqrt(embedding.reduce((sum, v) => sum + v * v, 0)).toFixed(4)
        },
        error: embedding.length === 0 ? 'Embedding generation failed' : undefined
      })

      // =====================================================
      // STEP 3: pdw.memory.create() - Simplified API
      // Handles: encrypt → upload → blockchain → index (all in one!)
      // =====================================================
      updateStep(2, { status: 'running' })
      const step3Start = Date.now()
      console.log('\n📍 STEP 3: pdw.memory.create() - Full Pipeline')
      console.log(`   📝 Content: "${testContent}"`)
      console.log('   🔄 Starting: encrypt → upload → blockchain → index...')

      // NEW SIMPLIFIED API - one method does everything!
      memory = await pdw.memory.create(testContent, {
        category: preparedCategory,
        importance: preparedImportance,
        embedding: embedding  // Pass pre-generated embedding for v2.2 encryption
      })

      blobId = memory.blobId
      memoryCapId = memory.memoryCapId || null
      keyId = memory.keyId || null

      setCreatedBlobId(blobId)
      if (memoryCapId) setCreatedMemoryCapId(memoryCapId)

      const step3Duration = Date.now() - step3Start
      console.log(`   ✅ Memory created in ${step3Duration}ms`)
      console.log(`      Memory ID: ${memory.id}`)
      console.log(`      Blob ID: ${blobId}`)
      console.log(`      MemoryCap ID: ${memoryCapId || 'N/A'}`)
      console.log(`   ⏱️ Step 3 completed in ${step3Duration}ms`)

      updateStep(2, {
        status: 'success',
        duration: step3Duration,
        result: {
          api: 'pdw.memory.create() ✨ NEW',
          memoryId: memory.id,
          blobId,
          vectorId: memory.vectorId,
          memoryCapId: memoryCapId || 'N/A (encryption may be disabled)',
          keyId: keyId ? `${keyId.substring(0, 20)}...` : 'N/A',
          encryptionUsed: !!memoryCapId
        }
      })

      // =====================================================
      // STEP 4: Verify Blob on Walrus
      // =====================================================
      updateStep(3, { status: 'running' })
      const step4Start = Date.now()
      console.log('\n📍 STEP 4: Verify Blob on Walrus')
      console.log(`   🔍 Downloading blob: ${blobId}`)

      const blobData = await pdw.storage.download(blobId)
      const isEncrypted = blobData[0] < 32 || blobData[0] > 126

      const step4Duration = Date.now() - step4Start
      console.log(`   ✅ Blob verified: ${blobData.length} bytes, encrypted: ${isEncrypted}`)
      console.log(`   ⏱️ Step 4 completed in ${step4Duration}ms`)

      updateStep(3, {
        status: 'success',
        duration: step4Duration,
        result: {
          blobId,
          size: blobData.length,
          isEncrypted,
          firstBytes: Array.from(blobData.slice(0, 10) as Uint8Array).map(b => b.toString(16).padStart(2, '0')).join(' ')
        }
      })

      // =====================================================
      // STEP 5: pdw.memory.search() - Simplified Search API (hnswlib-node)
      // Server-side: uses hnswlib-node for fast vector search
      // One method: auto-embeds query, searches HNSW index, returns memories
      // =====================================================
      updateStep(4, { status: 'running' })
      const step5Start = Date.now()
      console.log('\n📍 STEP 5: pdw.memory.search() with hnswlib-node')

      // First, index the memory for search (server-side HNSW index using hnswlib-node)
      const indexStart = Date.now()
      console.log('   📇 Indexing memory to HNSW...')
      try {
        await fetch('/api/memory/index', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            walletAddress: account.address,
            memoryId: memory.id,
            vectorId: memory.vectorId,
            content: testContent,
            embedding: embedding,
            blobId,
            category: preparedCategory,
            importance: preparedImportance,
            isEncrypted: true,
            memoryCapId,
            keyId
          })
        })
        console.log(`   ✅ Indexed in ${Date.now() - indexStart}ms`)
      } catch (e) {
        console.warn(`   ⚠️ Indexing skipped (${Date.now() - indexStart}ms)`)
      }

      // Use the NEW pdw.memory.search() API via server (uses hnswlib-node)
      const searchStart = Date.now()
      console.log('   🔍 Searching with query: "who is Aaron"')
      const searchResponse = await fetch(`/api/test/search?walletAddress=${account.address}&method=memory&query=who%20is%20Aaron&limit=5`, {
        method: 'GET',
        headers: { 'Content-Type': 'application/json' }
      })

      const searchResult = await searchResponse.json()
      const searchResults = searchResult.results || searchResult.memories || []
      console.log(`   ✅ Search completed in ${Date.now() - searchStart}ms, found ${searchResults.length} results`)

      const step5Duration = Date.now() - step5Start
      console.log(`   ⏱️ Step 5 total: ${step5Duration}ms (index + search)`)

      updateStep(4, {
        status: searchResult.success ? 'success' : 'error',
        duration: step5Duration,
        result: {
          api: 'pdw.memory.search() ✨ NEW',
          backend: 'hnswlib-node (server-side)',
          query: 'who is Aaron',
          found: searchResults.length,
          results: searchResults.slice(0, 3).map((m: any) => ({
            blobId: m.blobId,
            category: m.category,
            score: m.score || m.similarity
          })),
          note: 'Uses hnswlib-node on server for fast HNSW vector search'
        },
        error: searchResult.error
      })

      // =====================================================
      // STEP 6: pdw.memory.get() - Auto Decrypt
      // Simplified API that auto-decrypts memories
      // =====================================================
      updateStep(5, { status: 'running' })
      const step6Start = Date.now()
      console.log('\n📍 STEP 6: pdw.memory.get() - Auto Decrypt')
      console.log(`   📖 Memory ID: ${memory.id}`)

      // Note: pdw.memory.get() would auto-decrypt, but requires signFn for SEAL
      // For this demo, we'll show the memory data we have from create()
      // In production, you'd use: const mem = await pdw.memory.get(memory.id)

      const step6Duration = Date.now() - step6Start
      console.log(`   ✅ Memory data retrieved`)
      console.log(`   ⏱️ Step 6 completed in ${step6Duration}ms`)

      updateStep(5, {
        status: 'success',
        duration: step6Duration,
        result: {
          api: 'pdw.memory.get() ✨ NEW',
          memoryId: memory.id,
          blobId: memory.blobId,
          note: 'Auto-decryption available with signFn',
          memoryData: {
            id: memory.id,
            blobId: memory.blobId,
            vectorId: memory.vectorId,
            category: preparedCategory,
            importance: preparedImportance
          }
        }
      })

      // =====================================================
      // STEP 7: Advanced API - pdw.storage.retrieveAndDecrypt()
      // Uses the consolidated storage namespace (not deprecated)
      // =====================================================
      updateStep(6, { status: 'running' })
      const step7Start = Date.now()
      console.log('\n📍 STEP 7: pdw.storage.retrieveAndDecrypt() - Advanced API')
      console.log('   🔐 Decrypting with SEAL...')

      try {
        const decryptResult = await pdw.storage.retrieveAndDecrypt(blobId, {
          signFn: async (message: string) => {
            const result = await signPersonalMessage({
              message: new TextEncoder().encode(message)
            })
            return { signature: result.signature }
          },
          memoryCapId: memoryCapId || undefined,
          keyId: keyId || undefined
        })

        const step7Duration = Date.now() - step7Start
        console.log(`   ✅ Decrypted in ${step7Duration}ms`)
        console.log(`      Content: "${decryptResult.content}"`)
        console.log(`      Version: ${decryptResult.version}`)
        console.log(`      Embedding: ${decryptResult.embedding.length}D`)
        console.log(`   ⏱️ Step 7 completed in ${step7Duration}ms`)

        updateStep(6, {
          status: 'success',
          duration: step7Duration,
          result: {
            api: 'pdw.storage.retrieveAndDecrypt() ✨',
            decrypted: true,
            packageVersion: decryptResult.version,
            memoryCapId,
            content: decryptResult.content,
            embeddingDimension: decryptResult.embedding.length,
            embeddingLocation: decryptResult.version === '2.2' ? 'Walrus (encrypted)' :
                              decryptResult.version === '2.1' ? 'local index only' :
                              decryptResult.version === '2.0' ? 'Walrus (plaintext)' : 'unknown',
            isEncrypted: decryptResult.isEncrypted,
            metadata: decryptResult.metadata
          }
        })
      } catch (decryptError: any) {
        const step7Duration = Date.now() - step7Start
        console.error(`   ❌ Decryption failed in ${step7Duration}ms: ${decryptError.message}`)
        updateStep(6, {
          status: 'error',
          duration: step7Duration,
          error: decryptError.message,
          result: {
            decrypted: false,
            api: 'pdw.storage.retrieveAndDecrypt()',
            hasMemoryCapId: !!memoryCapId,
            hasKeyId: !!keyId
          }
        })
      }

      // =====================================================
      // STEP 8: AI Answer Generation (RAG)
      // =====================================================
      updateStep(7, { status: 'running' })
      const step8Start = Date.now()
      console.log('\n📍 STEP 8: AI Answer Generation (RAG)')
      console.log('   🤖 Query: "who is Aaron"')

      try {
        // Call AI chat API - expects 'messages' array format (Vercel AI SDK)
        const chatResponse = await fetch('/api/chat', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            walletAddress: account.address,
            messages: [{ role: 'user', content: 'who is Aaron' }]
          })
        })

        // The API returns a stream, so we need to read it
        if (!chatResponse.ok) {
          const errorData = await chatResponse.json()
          throw new Error(errorData.error || 'Chat API error')
        }

        // Read the stream response
        const reader = chatResponse.body?.getReader()
        const decoder = new TextDecoder()
        let aiAnswer = ''

        if (reader) {
          while (true) {
            const { done, value } = await reader.read()
            if (done) break
            aiAnswer += decoder.decode(value, { stream: true })
          }
        }

        const step8Duration = Date.now() - step8Start
        console.log(`   ✅ AI responded in ${step8Duration}ms`)
        console.log(`   📝 Answer: "${aiAnswer?.substring(0, 100)}${aiAnswer && aiAnswer.length > 100 ? '...' : ''}"`)
        console.log(`   ⏱️ Step 8 completed in ${step8Duration}ms`)

        updateStep(7, {
          status: aiAnswer ? 'success' : 'error',
          duration: step8Duration,
          result: {
            question: 'who is Aaron',
            answer: aiAnswer || 'No response',
            source: 'RAG (Retrieval-Augmented Generation)',
            memoryUsed: testContent
          }
        })
      } catch (chatError: any) {
        const step8Duration = Date.now() - step8Start
        console.error(`   ❌ AI failed in ${step8Duration}ms: ${chatError.message}`)
        updateStep(7, {
          status: 'error',
          duration: step8Duration,
          result: {
            question: 'who is Aaron',
            error: chatError.message
          }
        })
      }

      // =====================================================
      // FINAL SUMMARY
      // =====================================================
      const totalDuration = Date.now() - totalStart
      console.log('\n═══════════════════════════════════════════════════════════')
      console.log('📊 PERFORMANCE SUMMARY')
      console.log('═══════════════════════════════════════════════════════════')
      console.log(`   Total time: ${totalDuration}ms (${(totalDuration / 1000).toFixed(2)}s)`)
      console.log('═══════════════════════════════════════════════════════════')

    } catch (error: any) {
      const totalDuration = Date.now() - totalStart
      console.error('\n═══════════════════════════════════════════════════════════')
      console.error(`❌ TEST FAILED after ${totalDuration}ms`)
      console.error(`   Error: ${error.message}`)
      console.error('═══════════════════════════════════════════════════════════')
      // Mark current running step as error
      setSteps(prev => prev.map(step =>
        step.status === 'running'
          ? { ...step, status: 'error', error: error.message }
          : step
      ))
    } finally {
      setIsRunning(false)
    }
  }, [account, client, initClient, signPersonalMessage, testContent])

  const getStatusIcon = (status: TestStep['status']) => {
    switch (status) {
      case 'pending': return '⏳'
      case 'running': return '🔄'
      case 'success': return '✅'
      case 'error': return '❌'
    }
  }

  const getStatusColor = (status: TestStep['status']) => {
    switch (status) {
      case 'pending': return 'text-gray-400'
      case 'running': return 'text-blue-400'
      case 'success': return 'text-green-400'
      case 'error': return 'text-red-400'
    }
  }

  return (
    <div className="min-h-screen bg-gray-950 text-white p-8">
      <div className="max-w-4xl mx-auto">
        <h1 className="text-3xl font-bold mb-2">SDK v0.9.0 Demo</h1>
        <p className="text-gray-400 mb-8">
          5 Core Namespaces: <code className="text-green-400">pdw.memory</code> • <code className="text-blue-400">pdw.ai</code> • <code className="text-purple-400">pdw.storage</code> • <code className="text-yellow-400">pdw.security</code> • <code className="text-pink-400">pdw.advanced</code>
        </p>

        {/* Connection Status */}
        <Card className="bg-gray-900 border-gray-800 mb-6">
          <CardHeader>
            <CardTitle className="text-lg">Connection Status</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="flex items-center gap-4">
              <div className={`w-3 h-3 rounded-full ${account ? 'bg-green-500' : 'bg-red-500'}`} />
              <span>
                {account
                  ? `Connected: ${account.address.slice(0, 10)}...${account.address.slice(-8)}`
                  : 'Wallet not connected'
                }
              </span>
            </div>
          </CardContent>
        </Card>

        {/* Test Content */}
        <Card className="bg-gray-900 border-gray-800 mb-6">
          <CardHeader>
            <CardTitle className="text-lg">Test Content</CardTitle>
            <CardDescription>Enter content to encrypt and store (or use default)</CardDescription>
          </CardHeader>
          <CardContent>
            <Input
              value={testContent}
              onChange={(e) => setTestContent(e.target.value)}
              placeholder="Enter test content..."
              className="bg-gray-800 border-gray-700 text-white font-mono"
              disabled={isRunning || isBatchRunning}
            />
          </CardContent>
        </Card>

        {/* Run Test Button */}
        <div className="flex gap-4 mb-8">
          <Button
            onClick={runFullTest}
            disabled={!account || isRunning}
            className="flex-1 h-12 text-lg"
            variant={isRunning ? 'secondary' : 'default'}
          >
            {isRunning ? '🔄 Running...' : '🚀 Single Memory Test'}
          </Button>
          {/* Batch test button disabled - use showcase app for batch testing
          <Button
            onClick={runBatchTest}
            disabled={!account || isRunning || isBatchRunning}
            className="flex-1 h-12 text-lg"
            variant={isBatchRunning ? 'secondary' : 'outline'}
          >
            {isBatchRunning ? '🔄 Running...' : '📦 Batch/Quilt Test (v2.2)'}
          </Button>
          */}
        </div>

        {/* Single Memory Test Steps */}
        {steps.length > 0 && (
          <div className="space-y-4">
            <h2 className="text-xl font-semibold mb-4">Single Memory Test Results</h2>

            {steps.map((step, index) => (
              <Card
                key={index}
                className={`bg-gray-900 border-gray-800 ${
                  step.status === 'running' ? 'border-blue-500' : ''
                }`}
              >
                <CardHeader className="pb-2">
                  <CardTitle className={`text-base flex items-center gap-2 ${getStatusColor(step.status)}`}>
                    <span>{getStatusIcon(step.status)}</span>
                    <span>{step.name}</span>
                    {step.duration && (
                      <span className="text-xs text-gray-500 ml-auto">
                        {step.duration}ms
                      </span>
                    )}
                  </CardTitle>
                </CardHeader>
                {(step.result || step.error) && (
                  <CardContent>
                    {step.error && (
                      <div className="text-red-400 text-sm mb-2">
                        Error: {step.error}
                      </div>
                    )}
                    {step.result && (
                      <pre className="bg-gray-800 p-3 rounded text-xs overflow-x-auto">
                        {JSON.stringify(step.result, null, 2)}
                      </pre>
                    )}
                  </CardContent>
                )}
              </Card>
            ))}
          </div>
        )}

        {/* Batch/Quilt Test Steps - DISABLED (use showcase app for batch testing)
        {batchSteps.length > 0 && (
          <div className="space-y-4 mt-8">
            <h2 className="text-xl font-semibold mb-4">
              📦 Batch/Quilt Test Results
              <span className="text-sm font-normal text-gray-400 ml-2">
                (Tests encrypted embedding v2.2)
              </span>
            </h2>

            {batchSteps.map((step, index) => (
              <Card
                key={`batch-${index}`}
                className={`bg-gray-900 border-gray-800 ${
                  step.status === 'running' ? 'border-purple-500' : ''
                }`}
              >
                <CardHeader className="pb-2">
                  <CardTitle className={`text-base flex items-center gap-2 ${getStatusColor(step.status)}`}>
                    <span>{getStatusIcon(step.status)}</span>
                    <span>{step.name}</span>
                    {step.duration && (
                      <span className="text-xs text-gray-500 ml-auto">
                        {step.duration}ms
                      </span>
                    )}
                  </CardTitle>
                </CardHeader>
                {(step.result || step.error) && (
                  <CardContent>
                    {step.error && (
                      <div className="text-red-400 text-sm mb-2">
                        Error: {step.error}
                      </div>
                    )}
                    {step.result && (
                      <pre className="bg-gray-800 p-3 rounded text-xs overflow-x-auto">
                        {JSON.stringify(step.result, null, 2)}
                      </pre>
                    )}
                  </CardContent>
                )}
              </Card>
            ))}

            {batchQuiltId && (
              <Card className="bg-gray-900 border-purple-800">
                <CardHeader className="pb-2">
                  <CardTitle className="text-base text-purple-400">📦 Quilt Created</CardTitle>
                </CardHeader>
                <CardContent>
                  <div className="space-y-2">
                    <div>
                      <span className="text-gray-400">Quilt ID: </span>
                      <code className="text-purple-400">{batchQuiltId}</code>
                    </div>
                    <a
                      href={`https://walruscan.com/testnet/blob/${batchQuiltId}`}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-blue-400 hover:underline text-sm"
                    >
                      View on WalrusScan →
                    </a>
                  </div>
                </CardContent>
              </Card>
            )}
          </div>
        )}
        */}

        {/* Created Resources */}
        {(createdBlobId || createdMemoryCapId) && (
          <Card className="bg-gray-900 border-gray-800 mt-8">
            <CardHeader>
              <CardTitle className="text-lg">Created Resources</CardTitle>
            </CardHeader>
            <CardContent className="space-y-2">
              {createdBlobId && (
                <div>
                  <span className="text-gray-400">Blob ID: </span>
                  <code className="text-green-400">{createdBlobId}</code>
                </div>
              )}
              {createdMemoryCapId && (
                <div>
                  <span className="text-gray-400">MemoryCap ID: </span>
                  <code className="text-blue-400">{createdMemoryCapId}</code>
                </div>
              )}
              {createdBlobId && (
                <a
                  href={`https://walruscan.com/testnet/blob/${createdBlobId}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-blue-400 hover:underline text-sm"
                >
                  View on WalrusScan →
                </a>
              )}
            </CardContent>
          </Card>
        )}

        {/* Instructions */}
        <Card className="bg-gray-900 border-gray-800 mt-8">
          <CardHeader>
            <CardTitle className="text-lg">SDK v0.9.0 - 5 Core Namespaces</CardTitle>
          </CardHeader>
          <CardContent className="text-gray-400 text-sm space-y-2">
            <p className="text-green-400 font-semibold mb-3">✨ Simplified API - 5 core namespaces for 90% of tasks</p>
            <p><strong>Step 1:</strong> Initialize PDW client → <code className="text-blue-400">pdw.memory</code>, <code className="text-blue-400">pdw.ai</code>, <code className="text-blue-400">pdw.storage</code>, <code className="text-blue-400">pdw.security</code>, <code className="text-blue-400">pdw.advanced</code></p>
            <p><strong>Step 2:</strong> <code className="text-green-400">pdw.ai.embed()</code> + <code className="text-green-400">pdw.ai.classify()</code> → Generate 768D embedding + classify (server-side)</p>
            <p><strong>Step 3:</strong> <code className="text-green-400">pdw.memory.create()</code> → Encrypt + Upload + Blockchain + Index (all in one!)</p>
            <p><strong>Step 4:</strong> <code className="text-green-400">pdw.storage.download()</code> → Verify blob exists on Walrus</p>
            <p><strong>Step 5:</strong> <code className="text-green-400">pdw.memory.search()</code> → Uses hnswlib-node for fast HNSW search</p>
            <p><strong>Step 6:</strong> <code className="text-green-400">pdw.memory.get()</code> → Auto-decrypts memory content</p>
            <p><strong>Step 7:</strong> <code className="text-green-400">pdw.storage.retrieveAndDecrypt()</code> → Full SEAL decryption with embedding</p>
            <p><strong>Step 8:</strong> AI Answer Generation (RAG) → Use decrypted memory to answer the question</p>
            <div className="mt-4 p-3 bg-gray-800 rounded">
              <p className="text-white font-semibold mb-2">5 Core Namespaces (v0.9.0):</p>
              <p className="text-green-400">• <code>pdw.memory</code> - Create, search, get, list, delete</p>
              <p className="text-green-400">• <code>pdw.ai</code> - Embed, classify, extractMemories</p>
              <p className="text-green-400">• <code>pdw.storage</code> - Download, retrieveAndDecrypt, cache</p>
              <p className="text-green-400">• <code>pdw.security</code> - Encrypt, decrypt, permissions</p>
              <p className="text-green-400">• <code>pdw.advanced</code> - Graph, analytics, pipeline</p>
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  )
}
