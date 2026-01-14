'use client'

import { useState, useCallback } from 'react'
import { useCurrentAccount, useSignPersonalMessage } from '@mysten/dapp-kit'
import { usePDWClient } from '@/hooks/usePDWClient'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'

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

  const updateStep = (index: number, updates: Partial<TestStep>) => {
    setSteps(prev => prev.map((step, i) =>
      i === index ? { ...step, ...updates } : step
    ))
  }

  const runFullTest = useCallback(async () => {
    if (!account?.address) {
      alert('Please connect your wallet first!')
      return
    }

    setIsRunning(true)
    setCreatedBlobId(null)
    setCreatedMemoryCapId(null)

    // Initialize steps
    const initialSteps: TestStep[] = [
      { name: '1. Initialize PDW Client', status: 'pending' },
      { name: '2. Generate Embedding (3072 dimensions)', status: 'pending' },
      { name: '3. Create Memory (Encrypt + Upload)', status: 'pending' },
      { name: '4. Verify Blob on Walrus', status: 'pending' },
      { name: '5. Index Memory Locally', status: 'pending' },
      { name: '6. Query: "who is Aaron"', status: 'pending' },
      { name: '7. Decrypt Memory Content', status: 'pending' },
      { name: '8. Full Retrieve Test', status: 'pending' },
      { name: '9. AI Answer Generation', status: 'pending' },
    ]
    setSteps(initialSteps)

    let pdw = client
    let blobId: string | null = null
    let memoryCapId: string | null = null
    let keyId: string | null = null

    try {
      // =====================================================
      // STEP 1: Initialize PDW Client
      // =====================================================
      updateStep(0, { status: 'running' })
      const step1Start = Date.now()

      if (!pdw) {
        pdw = await initClient()
      }

      if (!pdw) {
        throw new Error('Failed to initialize PDW client')
      }

      updateStep(0, {
        status: 'success',
        duration: Date.now() - step1Start,
        result: {
          userAddress: account.address,
          hasEncryption: !!pdw.encryption,
          hasCapability: !!pdw.capability,
          hasStorage: !!pdw.storage
        }
      })

      // =====================================================
      // STEP 2: Generate Embedding (3072 dimensions)
      // =====================================================
      updateStep(1, { status: 'running' })
      const step2Start = Date.now()

      console.log('🧠 Generating embedding for: "Aaron is a member of CommandOSS"')

      let embedding: number[] = []
      let preparedCategory = 'personal'
      let preparedImportance = 5
      try {
        // Use /api/memory/prepare which generates embedding + classification
        const prepareResponse = await fetch('/api/memory/prepare', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            content: 'Aaron is a member of CommandOSS',
            walletAddress: account.address
          })
        })

        const prepareResult = await prepareResponse.json()

        if (prepareResult.success && prepareResult.prepared?.embedding) {
          embedding = prepareResult.prepared.embedding
          preparedCategory = prepareResult.prepared.category || 'personal'
          preparedImportance = prepareResult.prepared.importance || 5
          console.log(`✅ Generated embedding with ${embedding.length} dimensions`)
          console.log(`📝 Classification: category=${preparedCategory}, importance=${preparedImportance}`)
        } else {
          throw new Error(prepareResult.error || 'Failed to generate embedding')
        }
      } catch (embError: any) {
        console.warn('⚠️ Embedding generation failed, continuing without embedding:', embError.message)
      }

      updateStep(1, {
        status: embedding.length > 0 ? 'success' : 'error',
        duration: Date.now() - step2Start,
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
      // STEP 3: Create Memory (Encrypt + Upload to Walrus)
      // =====================================================
      updateStep(2, { status: 'running' })
      const step3Start = Date.now()

      console.log('📝 Creating memory with content: "Aaron is a member of CommandOSS"')

      // Use storage.storeMemoryPackage which now uses capability-based encryption
      const uploadResult = await pdw.storage.storeMemoryPackage({
        content: 'Aaron is a member of CommandOSS',
        contentType: 'text/plain',
        embedding: embedding,  // Root level - correct API design
        metadata: {
          category: preparedCategory,
          importance: preparedImportance,
          createdAt: Date.now()
        }
      })

      blobId = uploadResult.blobId
      memoryCapId = (uploadResult as any).memoryCapId
      keyId = (uploadResult as any).keyId

      setCreatedBlobId(blobId)
      if (memoryCapId) setCreatedMemoryCapId(memoryCapId)

      updateStep(2, {
        status: 'success',
        duration: Date.now() - step3Start,
        result: {
          blobId,
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

      const blobData = await pdw.storage.download(blobId)
      const isEncrypted = blobData[0] < 32 || blobData[0] > 126

      updateStep(3, {
        status: 'success',
        duration: Date.now() - step4Start,
        result: {
          blobId,
          size: blobData.length,
          isEncrypted,
          firstBytes: Array.from(blobData.slice(0, 10) as Uint8Array).map(b => b.toString(16).padStart(2, '0')).join(' ')
        }
      })

      // =====================================================
      // STEP 5: Index Memory Locally
      // =====================================================
      updateStep(4, { status: 'running' })
      const step5Start = Date.now()

      // Call server-side indexing API - use the embedding we generated
      const indexResponse = await fetch('/api/memory/index', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          walletAddress: account.address,
          memoryId: `test-${Date.now()}`,
          vectorId: Date.now() % 4294967295,
          content: 'Aaron is a member of CommandOSS',
          embedding: embedding, // Use the embedding we generated in step 2
          blobId,
          category: preparedCategory,
          importance: preparedImportance,
          isEncrypted: true,
          memoryCapId,
          keyId
        })
      })

      const indexResult = await indexResponse.json()

      updateStep(4, {
        status: indexResult.success ? 'success' : 'error',
        duration: Date.now() - step5Start,
        result: indexResult,
        error: indexResult.error
      })

      // =====================================================
      // STEP 6: Query Memories
      // =====================================================
      updateStep(5, { status: 'running' })
      const step6Start = Date.now()

      // Query via server-side search API
      const searchResponse = await fetch('/api/test/search', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          walletAddress: account.address,
          query: 'who is Aaron',  // Semantic search query
          limit: 5
        })
      })

      const searchResult = await searchResponse.json()

      // API returns "results" not "memories"
      const searchResults = searchResult.results || searchResult.memories || []

      updateStep(5, {
        status: searchResult.success ? 'success' : 'error',
        duration: Date.now() - step6Start,
        result: {
          found: searchResults.length,
          results: searchResults.slice(0, 3).map((m: any) => ({
            blobId: m.blobId,
            category: m.category,
            score: m.score || m.similarity
          }))
        },
        error: searchResult.error
      })

      // =====================================================
      // STEP 7: Decrypt Memory Content (using SDK method)
      // =====================================================
      updateStep(6, { status: 'running' })
      const step7Start = Date.now()

      // Use SDK's retrieveAndDecrypt method - handles all version detection and decryption
      try {
        console.log('🔐 Using pdw.storage.retrieveAndDecrypt()...')

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

        console.log('✅ Decryption complete via SDK')
        console.log(`   Content: "${decryptResult.content}"`)
        console.log(`   Version: ${decryptResult.version}`)
        console.log(`   Embedding: ${decryptResult.embedding.length}D`)

        updateStep(6, {
          status: 'success',
          duration: Date.now() - step7Start,
          result: {
            decrypted: true,
            method: `SDK retrieveAndDecrypt (${decryptResult.version})`,
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
        console.error('❌ SDK decryption failed:', decryptError.message)
        updateStep(6, {
          status: 'error',
          duration: Date.now() - step7Start,
          error: decryptError.message,
          result: {
            decrypted: false,
            method: 'SDK retrieveAndDecrypt',
            hasMemoryCapId: !!memoryCapId,
            hasKeyId: !!keyId
          }
        })
      }

      // =====================================================
      // STEP 8: Full Retrieve Test (using SDK retrieveAndDecrypt again)
      // =====================================================
      updateStep(7, { status: 'running' })
      const step8Start = Date.now()

      console.log('========== STEP 8: FULL RETRIEVE TEST ==========')
      console.log('🔍 Calling pdw.storage.retrieveAndDecrypt again (reuses cached session)')

      try {
        // Use retrieveAndDecrypt - session key should be cached by SDK
        const fullRetrieveResult = await pdw.storage.retrieveAndDecrypt(blobId, {
          signFn: async (message: string) => {
            const result = await signPersonalMessage({
              message: new TextEncoder().encode(message)
            })
            return { signature: result.signature }
          },
          memoryCapId: memoryCapId || undefined,
          keyId: keyId || undefined
        })

        console.log('✅ Full retrieve complete')
        console.log(`   Content: "${fullRetrieveResult.content}"`)
        console.log(`   Embedding: ${fullRetrieveResult.embedding.length}D`)
        console.log(`   Version: ${fullRetrieveResult.version}`)
        console.log('================================================')

        updateStep(7, {
          status: 'success',
          duration: Date.now() - step8Start,
          result: {
            method: 'SDK retrieveAndDecrypt',
            version: fullRetrieveResult.version,
            content: fullRetrieveResult.content,
            embeddingDimension: fullRetrieveResult.embedding.length,
            isEncrypted: fullRetrieveResult.isEncrypted,
            hasContent: !!fullRetrieveResult.content
          }
        })
      } catch (retrieveError: any) {
        console.error('❌ Full retrieve failed:', retrieveError.message)
        updateStep(7, {
          status: 'error',
          duration: Date.now() - step8Start,
          result: {
            method: 'SDK retrieveAndDecrypt',
            error: retrieveError.message
          }
        })
      }

      // =====================================================
      // STEP 9: AI Answer Generation (RAG)
      // =====================================================
      updateStep(8, { status: 'running' })
      const step9Start = Date.now()

      console.log('========== STEP 9: AI ANSWER GENERATION ==========')
      console.log('🤖 Generating answer for: "who is Aaron"')

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

        console.log('🤖 AI Response:', aiAnswer)

        updateStep(8, {
          status: aiAnswer ? 'success' : 'error',
          duration: Date.now() - step9Start,
          result: {
            question: 'who is Aaron',
            answer: aiAnswer || 'No response',
            source: 'RAG (Retrieval-Augmented Generation)',
            memoryUsed: 'Aaron is a member of CommandOSS'
          }
        })
      } catch (chatError: any) {
        console.error('❌ AI Answer generation failed:', chatError.message)
        updateStep(8, {
          status: 'error',
          duration: Date.now() - step9Start,
          result: {
            question: 'who is Aaron',
            error: chatError.message
          }
        })
      }

    } catch (error: any) {
      console.error('Test failed:', error)
      // Mark current running step as error
      setSteps(prev => prev.map(step =>
        step.status === 'running'
          ? { ...step, status: 'error', error: error.message }
          : step
      ))
    } finally {
      setIsRunning(false)
    }
  }, [account, client, initClient, signPersonalMessage])

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
        <h1 className="text-3xl font-bold mb-2">Encryption Test Workflow</h1>
        <p className="text-gray-400 mb-8">
          Test the full encrypt → upload → index → query → decrypt flow
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
            <CardDescription>This content will be encrypted and stored</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="bg-gray-800 p-4 rounded-lg font-mono">
              "Aaron is a member of CommandOSS"
            </div>
          </CardContent>
        </Card>

        {/* Run Test Button */}
        <Button
          onClick={runFullTest}
          disabled={!account || isRunning}
          className="w-full mb-8 h-12 text-lg"
          variant={isRunning ? 'secondary' : 'default'}
        >
          {isRunning ? '🔄 Running Test...' : '🚀 Run Full Encryption Test'}
        </Button>

        {/* Test Steps */}
        {steps.length > 0 && (
          <div className="space-y-4">
            <h2 className="text-xl font-semibold mb-4">Test Results</h2>

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
            <CardTitle className="text-lg">What This Test Does</CardTitle>
          </CardHeader>
          <CardContent className="text-gray-400 text-sm space-y-2">
            <p><strong>Step 1:</strong> Initialize PDW client with encryption enabled</p>
            <p><strong>Step 2:</strong> Generate 3072-dimension vector embedding using Gemini (server-side)</p>
            <p><strong>Step 3:</strong> <code>pdw.storage.storeMemoryPackage()</code> → Encrypt content + embedding (v2.2) → Upload to Walrus</p>
            <p><strong>Step 4:</strong> Verify blob exists on Walrus and check if encrypted</p>
            <p><strong>Step 5:</strong> Index memory locally for vector search</p>
            <p><strong>Step 6:</strong> Query with semantic search: "who is Aaron"</p>
            <p><strong>Step 7:</strong> <code>pdw.storage.retrieveAndDecrypt()</code> → Decrypt content and embedding</p>
            <p><strong>Step 8:</strong> Full retrieve test (demonstrates session reuse)</p>
            <p><strong>Step 9:</strong> AI Answer Generation (RAG) → Use decrypted memory to answer the question</p>
          </CardContent>
        </Card>
      </div>
    </div>
  )
}
