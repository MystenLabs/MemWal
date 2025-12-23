'use client'

import { useMemo, useState, useCallback } from 'react'
import { useCurrentAccount, useSignAndExecuteTransaction, useSuiClient } from '@mysten/dapp-kit'

// Dynamic import to avoid SSR issues with browser-only SDK
let DappKitSigner: any = null
let SimplePDWClient: any = null

async function loadSDK() {
  if (!DappKitSigner || !SimplePDWClient) {
    const sdk = await import('@cmdoss/memwal-sdk/browser')
    DappKitSigner = sdk.DappKitSigner
    SimplePDWClient = sdk.SimplePDWClient
  }
  return { DappKitSigner, SimplePDWClient }
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
  const { mutateAsync: signAndExecute } = useSignAndExecuteTransaction()

  const [client, setClient] = useState<any | null>(null)
  const [signer, setSigner] = useState<any | null>(null)
  const [isReady, setIsReady] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Initialize the PDW client with DappKitSigner
  const initClient = useCallback(async () => {
    if (!account?.address) {
      setError('Wallet not connected')
      return null
    }

    try {
      setError(null)

      // Load SDK dynamically
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
    }
  }, [account?.address, suiClient, signAndExecute])

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
