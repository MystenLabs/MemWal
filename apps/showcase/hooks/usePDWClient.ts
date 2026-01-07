'use client'

import { useMemo, useState, useCallback } from 'react'
import { useCurrentAccount, useSignAndExecuteTransaction, useSuiClient } from '@mysten/dapp-kit'

// Dynamic import to avoid SSR issues with browser-only SDK
// Use singleton promise pattern for efficient SDK loading
let sdkPromise: Promise<{ DappKitSigner: any; SimplePDWClient: any }> | null = null
let cachedSDK: { DappKitSigner: any; SimplePDWClient: any } | null = null

async function loadSDK() {
  // Return cached SDK immediately if available
  if (cachedSDK) {
    return cachedSDK
  }

  // Use singleton promise to prevent multiple concurrent imports
  if (!sdkPromise) {
    sdkPromise = import('@cmdoss/memwal-sdk/browser').then((sdk) => {
      cachedSDK = {
        DappKitSigner: sdk.DappKitSigner,
        SimplePDWClient: sdk.SimplePDWClient,
      }
      return cachedSDK
    })
  }

  return sdkPromise
}

// Pre-load SDK in background when module loads (browser only)
if (typeof window !== 'undefined') {
  // Use requestIdleCallback for non-blocking preload
  if ('requestIdleCallback' in window) {
    (window as any).requestIdleCallback(() => loadSDK())
  } else {
    // Fallback: load after a short delay
    setTimeout(() => loadSDK(), 100)
  }
}

export interface UsePDWClientReturn {
  client: any | null
  signer: any | null
  initClient: () => Promise<any | null>
  isConnected: boolean
  isReady: boolean
  address: string | undefined
  error: string | null
}

/**
 * Hook to create SimplePDWClient with DappKitSigner for client-side operations
 *
 * This allows the user to sign transactions with Slush wallet for:
 * - Walrus storage uploads (user pays storage fee)
 * - Sui blockchain transactions (user pays gas fee)
 */
export function usePDWClient(): UsePDWClientReturn {
  const account = useCurrentAccount()
  const suiClient = useSuiClient()

  // Configure useSignAndExecuteTransaction with custom execute to get full effects
  // By default, dapp-kit only returns digest. We need effects for status checking.
  const { mutateAsync: signAndExecute } = useSignAndExecuteTransaction({
    execute: async ({ bytes, signature }) =>
      await suiClient.executeTransactionBlock({
        transactionBlock: bytes,
        signature,
        options: {
          showRawEffects: true,
          showEffects: true,
          showObjectChanges: true,
          showEvents: true,
        },
      }),
  })

  const [client, setClient] = useState<any | null>(null)
  const [signer, setSigner] = useState<any | null>(null)
  const [isReady, setIsReady] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [isInitializing, setIsInitializing] = useState(false)

  // Initialize the PDW client with DappKitSigner
  const initClient = useCallback(async () => {
    if (!account?.address) {
      setError('Wallet not connected')
      return null
    }

    // Return existing client if already initialized for this address
    if (client && isReady) {
      return client
    }

    // Prevent concurrent initialization
    if (isInitializing) {
      // Wait for current initialization to complete
      return new Promise((resolve) => {
        const checkReady = setInterval(() => {
          if (!isInitializing) {
            clearInterval(checkReady)
            resolve(client)
          }
        }, 100)
        // Timeout after 10s
        setTimeout(() => {
          clearInterval(checkReady)
          resolve(null)
        }, 10000)
      })
    }

    setIsInitializing(true)

    try {
      setError(null)

      // Load SDK dynamically (uses cached version if already loaded)
      const { DappKitSigner: SignerClass, SimplePDWClient: ClientClass } = await loadSDK()

      // Create DappKitSigner
      const newSigner = new SignerClass({
        address: account.address,
        client: suiClient,
        signAndExecuteTransaction: signAndExecute,
      })
      setSigner(newSigner)

      // Get config from environment
      const packageId = process.env.NEXT_PUBLIC_PACKAGE_ID
      const network = (process.env.NEXT_PUBLIC_SUI_NETWORK as 'testnet' | 'mainnet') || 'testnet'
      const walrusAggregator = process.env.NEXT_PUBLIC_WALRUS_AGGREGATOR || 'https://aggregator.walrus-testnet.walrus.space'
      const walrusPublisher = process.env.NEXT_PUBLIC_WALRUS_PUBLISHER || 'https://publisher.walrus-testnet.walrus.space'

      if (!packageId) {
        throw new Error('NEXT_PUBLIC_PACKAGE_ID not configured')
      }

      // Create SimplePDWClient
      const pdwClient = new ClientClass({
        signer: newSigner,
        userAddress: account.address,
        network,
        sui: {
          packageId,
          network,
        },
        walrus: {
          aggregatorUrl: walrusAggregator,
          publisherUrl: walrusPublisher,
        },
        features: {
          enableLocalIndexing: false, // Browser doesn't support hnswlib-node
          enableEncryption: false,
          enableKnowledgeGraph: false, // Keep it simple for client-side
        },
      })

      // Wait for client to be ready
      await pdwClient.ready()

      setClient(pdwClient)
      setIsReady(true)
      console.log('✅ Client-side PDW Client initialized with DappKitSigner')

      return pdwClient
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : 'Failed to initialize PDW client'
      console.error('❌ Failed to initialize client-side PDW Client:', err)
      setError(errorMessage)
      setIsReady(false)
      return null
    } finally {
      setIsInitializing(false)
    }
  }, [account?.address, suiClient, signAndExecute, client, isReady, isInitializing])

  return {
    client,
    signer,
    initClient,
    isConnected: !!account?.address,
    isReady,
    address: account?.address,
    error,
  }
}

/**
 * Hook to get or initialize PDW client
 * Auto-initializes when wallet is connected
 */
export function usePDWClientAuto() {
  const pdw = usePDWClient()
  const [initialized, setInitialized] = useState(false)

  // Auto-initialize when connected
  useMemo(() => {
    if (pdw.isConnected && !pdw.client && !initialized) {
      setInitialized(true)
      pdw.initClient()
    }
  }, [pdw.isConnected, pdw.client, initialized, pdw.initClient])

  return pdw
}
