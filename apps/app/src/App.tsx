/**
 * Walrus Memory — Web App
 *
 * Enoki zkLogin integration with @mysten/dapp-kit
 * Flow: Landing → Sign in with Google (Enoki) → Setup Wizard → Dashboard
 */

import { useEffect, useState, useCallback, useRef, createContext, useContext } from 'react'
import {
  ConnectButton,
  createNetworkConfig,
  SuiClientProvider,
  WalletProvider,
  useCurrentAccount,
  useDisconnectWallet,
  useSuiClientContext,
} from '@mysten/dapp-kit'
import { isEnokiNetwork, registerEnokiWallets } from '@mysten/enoki'
import { getJsonRpcFullnodeUrl } from '@mysten/sui/jsonRpc'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { BrowserRouter, Routes, Route, Navigate, useLocation, Link } from 'react-router-dom'
import { ArrowLeft, ShieldCheck } from 'lucide-react'
import { config } from './config'

import LandingPage from './pages/LandingPage'
import Dashboard from './pages/Dashboard'
import SetupWizard from './pages/SetupWizard'
import Playground from './pages/Playground'
import ConnectMcp from './pages/ConnectMcp'
import { useRouteAnalytics } from './hooks/useRouteAnalytics'


import '@mysten/dapp-kit/dist/index.css'

// ============================================================
// Network config
// ============================================================

const { networkConfig } = createNetworkConfig({
  testnet: { url: getJsonRpcFullnodeUrl('testnet'), network: 'testnet' },
  mainnet: { url: getJsonRpcFullnodeUrl('mainnet'), network: 'mainnet' },
})

const queryClient = new QueryClient()
const AUTH_METHOD_KEY = 'memwal_auth_method'
const ENOKI_CALLBACK_PATH = '/auth/enoki/callback'

function getEnokiRedirectUrl() {
  if (config.enokiRedirectUrl) return config.enokiRedirectUrl
  if (import.meta.env.DEV) {
    const port = window.location.port ? `:${window.location.port}` : ''
    return `${window.location.protocol}//localhost${port}${ENOKI_CALLBACK_PATH}`
  }
  return window.location.href.split('#')[0]
}

// ============================================================
// Delegate Key Context (stored in sessionStorage — cleared on tab close, never persists across sessions)
// ============================================================

interface DelegateKeyState {
  /** Ed25519 delegate private key (hex) */
  delegateKey: string | null
  /** Ed25519 delegate public key (hex) */
  delegatePublicKey: string | null
  /** Onchain Walrus Memory account object ID */
  accountObjectId: string | null
}

interface DelegateKeyContextType extends DelegateKeyState {
  setDelegateKeys: (privateKey: string, publicKey: string, accountId: string) => void
  clearDelegateKeys: () => void
}

const DelegateKeyContext = createContext<DelegateKeyContextType | null>(null)

// tunable idle-timeout. 15 minutes by default. Exported so callers/tests can read it.
export const INACTIVITY_TIMEOUT_MS = 15 * 60 * 1000

// Debounce interval for activity events to avoid excessive timer resets.
const ACTIVITY_DEBOUNCE_MS = 1000

// eslint-disable-next-line react-refresh/only-export-components
export function useDelegateKey() {
  const ctx = useContext(DelegateKeyContext)
  if (!ctx) throw new Error('useDelegateKey must be used within provider')
  return ctx
}

function DelegateKeyProvider({ children }: { children: React.ReactNode }) {
  const [state, setState] = useState<DelegateKeyState>(() => {
    const saved = sessionStorage.getItem('memwal_delegate')
    if (saved) {
      try { return JSON.parse(saved) } catch { /* ignore */ }
    }
    return { delegateKey: null, delegatePublicKey: null, accountObjectId: null }
  })

  const setDelegateKeys = useCallback((privateKey: string, publicKey: string, accountId: string) => {
    const next = { delegateKey: privateKey, delegatePublicKey: publicKey, accountObjectId: accountId }
    sessionStorage.setItem('memwal_delegate', JSON.stringify(next))
    setState(next)
  }, [])

  const clearDelegateKeys = useCallback(() => {
    // Best-effort zeroization: overwrite the private-key string reference before nulling.
    // JS strings are immutable so true wipe is impossible, but we at least drop the last
    // live reference held by this provider.
    setState((prev) => {
      if (prev.delegateKey) {
        // Reassign to a placeholder of same length to encourage GC of the original buffer.
        // (best-effort — V8 may still retain the interned string)
        void prev.delegateKey.replace(/./g, '\0')
      }
      return { delegateKey: null, delegatePublicKey: null, accountObjectId: null }
    })
    sessionStorage.removeItem('memwal_delegate')
  }, [])

  // ============================================================
  // Idle-timeout — wipe in-memory key material and disconnect after inactivity.
  // ============================================================
  const { mutateAsync: disconnect } = useDisconnectWallet()
  const hasKey = state.delegateKey !== null
  const timerRef = useRef<number | null>(null)
  const lastResetRef = useRef<number>(0)

  useEffect(() => {
    if (!hasKey) return

    const triggerWipe = () => {
      clearDelegateKeys()
      // Fire-and-forget disconnect; redirect to landing regardless.
      Promise.resolve(disconnect()).catch(() => { /* ignore */ })
      try {
        if (window.location.pathname !== '/') {
          window.location.assign('/')
        }
      } catch { /* ignore */ }
    }

    const scheduleTimer = () => {
      if (timerRef.current !== null) {
        window.clearTimeout(timerRef.current)
      }
      timerRef.current = window.setTimeout(triggerWipe, INACTIVITY_TIMEOUT_MS)
    }

    const onActivity = () => {
      const now = Date.now()
      if (now - lastResetRef.current < ACTIVITY_DEBOUNCE_MS) return
      lastResetRef.current = now
      scheduleTimer()
    }

    // Start timer on mount.
    scheduleTimer()

    const events: Array<keyof WindowEventMap> = ['mousemove', 'keydown', 'click', 'scroll', 'touchstart']
    const opts: AddEventListenerOptions = { passive: true }
    events.forEach((ev) => window.addEventListener(ev, onActivity, opts))

    return () => {
      events.forEach((ev) => window.removeEventListener(ev, onActivity, opts))
      if (timerRef.current !== null) {
        window.clearTimeout(timerRef.current)
        timerRef.current = null
      }
    }
  }, [hasKey, clearDelegateKeys, disconnect])

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
      console.warn('Enoki API key or Google Client ID not set. Skipping Enoki wallet registration.')
      return
    }

    const { unregister } = registerEnokiWallets({
      apiKey: config.enokiApiKey,
      providers: {
        google: {
          clientId: config.googleClientId,
          redirectUrl: getEnokiRedirectUrl(),
        },
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
  const location = useLocation()
  const dashboardSearchParams = new URLSearchParams(location.search)
  const explicitDashboardPreview = import.meta.env.DEV && dashboardSearchParams.get('preview') === '1'
  const isDashboardPreview = explicitDashboardPreview
  const dashboardPreviewState =
    dashboardSearchParams.get('state') === 'empty'
      ? 'empty'
      : dashboardSearchParams.get('state') === 'ready'
          ? 'ready'
          : 'empty'

  return (
    <Routes>
      <Route path="/" element={<LandingPage />} />
      <Route path="/dashboard" element={
        !currentAccount && !isDashboardPreview ? <DashboardConnectGate /> : (
          <Dashboard previewMode={isDashboardPreview} previewState={dashboardPreviewState} />
        )
      } />
      <Route path="/setup" element={
        !currentAccount ? <Navigate to="/" replace /> :
        delegateKey ? <Navigate to="/dashboard" replace /> : <SetupWizard />
      } />
      <Route path="/playground" element={
        !currentAccount ? <Navigate to="/" replace /> :
        delegateKey ? <Playground /> : <Navigate to="/dashboard" replace />
      } />
      <Route path="/connect/mcp" element={<ConnectMcp />} />
      <Route path={ENOKI_CALLBACK_PATH} element={<EnokiCallback />} />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  )
}

function EnokiCallback() {
  return (
    <div className="dash-page">
      <main className="dash-shell dash-connect-shell">
        <section className="dash-connect-card">
          <span className="dashboard-cta-icon-wrap" aria-hidden="true">
            <ShieldCheck size={26} className="dashboard-cta-icon" />
          </span>
          <div>
            <p className="dash-connect-kicker">google sign-in</p>
            <h1>Completing sign-in</h1>
            <p>This popup will close automatically.</p>
          </div>
        </section>
      </main>
    </div>
  )
}

function DashboardConnectGate() {
  const rememberWalletIntent = useCallback(() => {
    sessionStorage.setItem(AUTH_METHOD_KEY, 'wallet')
  }, [])

  return (
    <div className="dash-page">
      <nav className="dash-nav">
        <div className="dash-nav-inner">
          <Link to="/" className="dash-logo" aria-label="Walrus Memory home">
            <span>walrus</span>
            <span>memory</span>
          </Link>
          <Link to="/" className="dash-outline-button">
            <ArrowLeft size={13} /> Back home
          </Link>
        </div>
      </nav>

      <main className="dash-shell dash-connect-shell">
        <section className="dash-connect-card">
          <span className="dashboard-cta-icon-wrap" aria-hidden="true">
            <ShieldCheck size={26} className="dashboard-cta-icon" />
          </span>
          <div>
            <p className="dash-connect-kicker">real wallet required</p>
            <h1>Connect wallet to open Dashboard</h1>
            <p>
              Use the wallet that owns your Walrus Memory account, then
              create or import a delegate key for the interactive demo.
            </p>
          </div>
          <div className="dash-connect-actions" onClick={rememberWalletIntent}>
            <ConnectButton connectText="Connect wallet" />
          </div>
        </section>
      </main>
    </div>
  )
}

function AnalyticsTracker() {
  useRouteAnalytics()
  return null
}

// ============================================================
// Root App
// ============================================================

export default function App() {
  return (
    <BrowserRouter>
      <AnalyticsTracker />
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
    </BrowserRouter>
  )
}
