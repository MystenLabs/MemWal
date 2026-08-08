/**
 * Walrus Memory — Web App
 *
 * Enoki zkLogin integration with @mysten/dapp-kit
 * Flow: Landing → Sign in with Google (Enoki) → Setup Wizard → Dashboard
 */

import { useEffect, useState, useCallback, useRef, createContext, useContext } from 'react'
import {
  createNetworkConfig,
  SuiClientProvider,
  WalletProvider,
  useAutoConnectWallet,
  useCurrentAccount,
  useDisconnectWallet,
  useSuiClientContext,
} from '@mysten/dapp-kit'
import { isEnokiNetwork, registerEnokiWallets } from '@mysten/enoki'
import {
  getJsonRpcFullnodeUrl,
  SuiJsonRpcClient,
  type SuiJsonRpcClientOptions,
} from '@mysten/sui/jsonRpc'
import { SuiGrpcClient } from '@mysten/sui/grpc'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { BrowserRouter, Routes, Route, Navigate, useLocation } from 'react-router-dom'
import { config } from './config'

import LandingPage from './pages/LandingPage'
import Dashboard from './pages/Dashboard'
import SetupWizard from './pages/SetupWizard'
import Playground from './pages/Playground'
import ConnectMcp from './pages/ConnectMcp'
import ConnectApp from './pages/ConnectApp'
import { useRouteAnalytics } from './hooks/useRouteAnalytics'


import '@mysten/dapp-kit/dist/index.css'

// ============================================================
// Network config
// ============================================================

// VITE_SUI_RPC_URL overrides the public fullnode for the active network only
// (mirrors the relayer's SUI_RPC_URL — the public mainnet pool serves
// stale/slow reads under load). VITE_SUI_GRPC_URL takes precedence for the
// active real network; the explicit local browser suite remains JSON-RPC.
function jsonRpcUrlFor(network: 'testnet' | 'mainnet'): string {
  if (network === config.suiNetwork && config.suiRpcUrl) {
    return config.suiRpcUrl
  }
  return getJsonRpcFullnodeUrl(network)
}

const { networkConfig } = createNetworkConfig({
  testnet: { url: jsonRpcUrlFor('testnet'), network: 'testnet' },
  mainnet: { url: jsonRpcUrlFor('mainnet'), network: 'mainnet' },
  localnet: { url: config.suiRpcUrl || 'http://127.0.0.1:9000', network: 'localnet' },
})

// Opt-in gRPC for the active network. Every provider consumer uses the shared
// compatibility helpers in utils/suiClientCompat.ts; sponsored execution stays
// server-side, so the browser never needs a cross-transport execute shim.
function createClientForNetwork(name: string, cfg: SuiJsonRpcClientOptions) {
  if (name !== 'localnet' && name === config.suiNetwork && config.suiGrpcUrl) {
    return new SuiGrpcClient({ network: name, baseUrl: config.suiGrpcUrl }) as unknown as SuiJsonRpcClient
  }
  return new SuiJsonRpcClient(cfg)
}

const queryClient = new QueryClient()

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
          // Pin the Google OAuth redirect_uri to the app origin root by default — a
          // URL already registered for this client (the dashboard sign-in uses it,
          // which is why dashboard Google login works). Enoki otherwise defaults
          // to window.location.href, so signing in from
          // /connect/mcp?...&connectState=... would send a redirect_uri with a
          // non-registered path + query → Google rejects it (redirect_uri_mismatch).
          // The /connect/mcp params survive the round-trip via sessionStorage
          // (ConnectMcp persists them; PostAuthRedirect restores them). WALM-86.
          // VITE_ENOKI_REDIRECT_URL lets a deployment override this root when a
          // registered redirect URI differs from window.location.origin.
          redirectUrl: config.enokiRedirectUrl || `${window.location.origin}/`,
        },
      },
      client,
      network,
    })

    return unregister
  }, [client, network])

  return null
}

function EnokiCallback() {
  return (
    <main style={{
      minHeight: '100vh',
      display: 'grid',
      placeItems: 'center',
      background: 'var(--bg-primary)',
      color: 'var(--text-primary)',
    }}>
      <p style={{ color: 'var(--text-secondary)' }}>Finishing sign in...</p>
    </main>
  )
}

function LocalAppAuthCallback() {
  const { search } = useLocation()
  const params = new URLSearchParams(search)
  const code = params.get('code')
  const state = params.get('state')
  const error = params.get('error')

  return (
    <main style={{
      minHeight: '100vh',
      display: 'grid',
      placeItems: 'center',
      padding: 24,
      background: 'var(--bg-primary)',
      color: 'var(--text-primary)',
    }}>
      <section style={{
        width: 'min(100%, 520px)',
        border: '1px solid var(--border)',
        borderRadius: 8,
        padding: 24,
        background: 'var(--bg-secondary)',
        boxShadow: '0 20px 60px rgba(15, 23, 42, 0.08)',
      }}>
        <h1 style={{ margin: '0 0 8px', fontSize: 24, letterSpacing: 0 }}>
          Local Walrus Memory callback
        </h1>
        <p style={{ color: 'var(--text-secondary)', lineHeight: 1.5, margin: '0 0 18px' }}>
          This local test page only shows the browser callback result. The app backend must exchange the code server-side.
        </p>
        <dl style={{ display: 'grid', gap: 12, margin: 0 }}>
          <div>
            <dt style={{ color: 'var(--text-muted)', fontSize: 12, fontWeight: 700, textTransform: 'uppercase' }}>
              code
            </dt>
            <dd style={{ margin: '4px 0 0', fontFamily: 'var(--font-mono)', overflowWrap: 'anywhere' }}>
              {code || '-'}
            </dd>
          </div>
          <div>
            <dt style={{ color: 'var(--text-muted)', fontSize: 12, fontWeight: 700, textTransform: 'uppercase' }}>
              state
            </dt>
            <dd style={{ margin: '4px 0 0', fontFamily: 'var(--font-mono)', overflowWrap: 'anywhere' }}>
              {state || '-'}
            </dd>
          </div>
          <div>
            <dt style={{ color: 'var(--text-muted)', fontSize: 12, fontWeight: 700, textTransform: 'uppercase' }}>
              error
            </dt>
            <dd style={{ margin: '4px 0 0', fontFamily: 'var(--font-mono)', overflowWrap: 'anywhere', color: error ? '#dc2626' : 'inherit' }}>
              {error || '-'}
            </dd>
          </div>
        </dl>
      </section>
    </main>
  )
}

// ============================================================
// App content — route based on auth + key state
// ============================================================

function RoutePending() {
  return (
    <div className="wm-route-pending" role="status" aria-label="Restoring wallet session">
      <img src="/walrus-memory-logo.svg" alt="Walrus Memory" />
    </div>
  )
}

/** sessionStorage key holding an in-flight /connect/mcp request, so the flow
 *  can resume after the Google OAuth redirect bounces through the app root.
 *  Shared with ConnectMcp.tsx (kept as a literal there to avoid a circular import). */
const MCP_CONNECT_STORAGE_KEY = 'memwal_mcp_connect'

/** Lands here after a successful sign-in (the OAuth redirect_uri is the app
 *  root). If a /connect/mcp flow was interrupted by that redirect, resume it
 *  by restoring the saved query string; otherwise go to the dashboard. */
function PostAuthRedirect() {
  const pending = sessionStorage.getItem(MCP_CONNECT_STORAGE_KEY)
  let connectQuery = ''
  if (pending) {
    // Consume once — prevents a redirect loop on later visits to `/`.
    sessionStorage.removeItem(MCP_CONNECT_STORAGE_KEY)
    try {
      const params = JSON.parse(pending) as Record<string, string>
      connectQuery = new URLSearchParams(params).toString()
    } catch { /* fall through to dashboard */ }
  }
  if (connectQuery) return <Navigate to={`/connect/mcp?${connectQuery}`} replace />
  return <Navigate to="/dashboard" replace />
}

function AppContent() {
  const currentAccount = useCurrentAccount()
  const autoConnectStatus = useAutoConnectWallet()
  const { delegateKey } = useDelegateKey()
  const authPending = autoConnectStatus === 'idle'

  const requireAccount = (element: React.ReactNode) => {
    if (authPending) return <RoutePending />
    return currentAccount ? element : <Navigate to="/" replace />
  }

  return (
    <Routes>
      <Route path="/" element={
        authPending ? <RoutePending /> :
        currentAccount ? <PostAuthRedirect /> : <LandingPage />
      } />
      <Route path="/dashboard" element={requireAccount(<Dashboard />)} />
      <Route path="/setup" element={requireAccount(
        delegateKey ? <Navigate to="/dashboard" replace /> : <SetupWizard />
      )} />
      <Route path="/playground" element={requireAccount(
        delegateKey ? <Playground /> : <Navigate to="/dashboard" replace />
      )} />
      <Route path="/connect/mcp" element={<ConnectMcp />} />
      <Route path="/connect/app" element={<ConnectApp />} />
      <Route path="/auth/enoki/callback" element={<EnokiCallback />} />
      {/* ENG-1783 review N1 (2026-05-26): LocalAppAuthCallback is for local
          third-party dev only (when the demo app shares an origin with this
          Vite dev server). Registering these routes in production builds
          would let a malicious app register `memwal.ai/api/memwal/callback`
          as an allowed redirect_uri — the consent screen would say "Return
          to memwal.ai" (which looks safe to users), the code would land
          here and silently render the query string, and the attacker would
          observe nothing in the address bar. Code exchange still requires
          client_secret so they can't escalate, but the UX confusion is the
          phishing primitive — gating to DEV removes it entirely. */}
      {import.meta.env.DEV && (
        <>
          <Route path="/api/memwal/callback" element={<LocalAppAuthCallback />} />
          <Route path="/memwal/error" element={<LocalAppAuthCallback />} />
        </>
      )}
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
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
        <SuiClientProvider
          networks={networkConfig}
          defaultNetwork={config.suiClientNetwork}
          createClient={createClientForNetwork}
        >
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
