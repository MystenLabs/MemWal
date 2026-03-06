/**
 * MemWal V2 — Web App
 *
 * Enoki zkLogin integration with @mysten/dapp-kit
 * Flow: Landing → Sign in with Google (Enoki) → Setup Wizard → Dashboard
 */

import { useEffect, useState, useCallback, createContext, useContext } from 'react'
import {
  createNetworkConfig,
  SuiClientProvider,
  WalletProvider,
  useCurrentAccount,
  useSuiClientContext,
} from '@mysten/dapp-kit'
import { isEnokiNetwork, registerEnokiWallets } from '@mysten/enoki'
import { getJsonRpcFullnodeUrl } from '@mysten/sui/jsonRpc'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { config } from './config'

import LandingPage from './pages/LandingPage'
import Dashboard from './pages/Dashboard'
import SetupWizard from './pages/SetupWizard'
import Playground from './pages/Playground'

import '@mysten/dapp-kit/dist/index.css'

// ============================================================
// Network config
// ============================================================

const { networkConfig } = createNetworkConfig({
  testnet: { url: getJsonRpcFullnodeUrl('testnet'), network: 'testnet' },
  mainnet: { url: getJsonRpcFullnodeUrl('mainnet'), network: 'mainnet' },
})

const queryClient = new QueryClient()

// ============================================================
// Delegate Key Context (stored in localStorage)
// ============================================================

interface DelegateKeyState {
  /** Ed25519 delegate private key (hex) */
  delegateKey: string | null
  /** Ed25519 delegate public key (hex) */
  delegatePublicKey: string | null
  /** Onchain MemWalAccount object ID */
  accountObjectId: string | null
}

interface DelegateKeyContextType extends DelegateKeyState {
  setDelegateKeys: (privateKey: string, publicKey: string, accountId: string) => void
  clearDelegateKeys: () => void
}

const DelegateKeyContext = createContext<DelegateKeyContextType | null>(null)

export function useDelegateKey() {
  const ctx = useContext(DelegateKeyContext)
  if (!ctx) throw new Error('useDelegateKey must be used within provider')
  return ctx
}

function DelegateKeyProvider({ children }: { children: React.ReactNode }) {
  const [state, setState] = useState<DelegateKeyState>(() => {
    const saved = localStorage.getItem('memwal_delegate')
    if (saved) {
      try { return JSON.parse(saved) } catch { /* ignore */ }
    }
    return { delegateKey: null, delegatePublicKey: null, accountObjectId: null }
  })

  const setDelegateKeys = useCallback((privateKey: string, publicKey: string, accountId: string) => {
    const next = { delegateKey: privateKey, delegatePublicKey: publicKey, accountObjectId: accountId }
    localStorage.setItem('memwal_delegate', JSON.stringify(next))
    setState(next)
  }, [])

  const clearDelegateKeys = useCallback(() => {
    localStorage.removeItem('memwal_delegate')
    setState({ delegateKey: null, delegatePublicKey: null, accountObjectId: null })
  }, [])

  return (
    <DelegateKeyContext.Provider value={{ ...state, setDelegateKeys, clearDelegateKeys }}>
      {children}
    </DelegateKeyContext.Provider>
  )
}

// ============================================================
// Enoki wallet registration
// ============================================================

function RegisterEnokiWallets() {
  const { client, network } = useSuiClientContext()

  useEffect(() => {
    if (!isEnokiNetwork(network)) return
    if (!config.enokiApiKey || !config.googleClientId) {
      console.warn('⚠️ Enoki API key or Google Client ID not set. Skipping Enoki wallet registration.')
      return
    }

    const { unregister } = registerEnokiWallets({
      apiKey: config.enokiApiKey,
      providers: {
        google: { clientId: config.googleClientId },
      },
      client,
      network,
    })

    return unregister
  }, [client, network])

  return null
}

// ============================================================
// App content — route based on auth + key state
// ============================================================

function AppContent() {
  const currentAccount = useCurrentAccount()
  const { delegateKey } = useDelegateKey()
  const [page, setPage] = useState(() => window.location.hash.replace('#', '') || '')

  useEffect(() => {
    const onHash = () => setPage(window.location.hash.replace('#', '') || '')
    window.addEventListener('hashchange', onHash)
    return () => window.removeEventListener('hashchange', onHash)
  }, [])

  if (!currentAccount) {
    return <LandingPage />
  }

  if (!delegateKey) {
    return <SetupWizard />
  }

  if (page === 'playground') {
    return <Playground />
  }

  return <Dashboard />
}

// ============================================================
// Root App
// ============================================================

export default function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <SuiClientProvider networks={networkConfig} defaultNetwork={config.suiNetwork}>
        <RegisterEnokiWallets />
        <WalletProvider autoConnect>
          <DelegateKeyProvider>
            <div className="app">
              <AppContent />
            </div>
          </DelegateKeyProvider>
        </WalletProvider>
      </SuiClientProvider>
    </QueryClientProvider>
  )
}
