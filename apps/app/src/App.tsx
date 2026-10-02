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
  useSuiClient,
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
import { BrowserRouter, Routes, Route, Navigate, useSearchParams } from 'react-router-dom'
import { config } from './config'

import LandingPage from './pages/LandingPage'
import Dashboard from './pages/Dashboard'
import AdminDashboard from './pages/AdminDashboard'
import SetupWizard from './pages/SetupWizard'
import Playground from './pages/Playground'
import ConnectMcp from './pages/ConnectMcp'
import ConnectClaude from './pages/ConnectClaude'
import KeysPage from './pages/KeysPage'
import { useRouteAnalytics } from './hooks/useRouteAnalytics'
import { fetchAccountIdForOwner } from './utils/suiClientCompat'


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
          // Pin the Google OAuth redirect_uri to the app origin root — a URL
          // already registered for this client (the dashboard sign-in uses it,
          // which is why dashboard Google login works). Enoki otherwise defaults
          // to window.location.href, so signing in from
          // /connect/mcp?...&connectState=... would send a redirect_uri with a
          // non-registered path + query → Google rejects it (redirect_uri_mismatch).
          // The /connect/mcp params survive the round-trip via sessionStorage
          // (ConnectMcp persists them; PostAuthRedirect restores them). WALM-86.
          redirectUrl: `${window.location.origin}/`,
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
const CLAUDE_CONNECT_STORAGE_KEY = 'memwal_claude_connect'
const KEYS_CONNECT_STORAGE_KEY = 'memwal_keys_connect'
/** Set by RequireAccountForSetup below when a signed-out visitor is bounced
 *  off /setup, so that intent survives the sign-in redirect instead of
 *  silently landing wherever PostAuthAccountCheck would otherwise send them
 *  (Thanos, 24 Sep — WALM-675 scope). Carries `from` when Console's "Set up"
 *  (COMG-1081) sent them — mirrors `from=wm` on the way back — so the
 *  account-ready dialog still knows its origin once /setup restores after
 *  sign-in (28 Sep update). Empty-but-present (`{}`) is the plain "resume
 *  /setup" case with no marker to carry. */
const SETUP_CONNECT_STORAGE_KEY = 'memwal_setup_connect'

const PENDING_CONNECTS = [
  [CLAUDE_CONNECT_STORAGE_KEY, '/connect/claude'],
  [MCP_CONNECT_STORAGE_KEY, '/connect/mcp'],
  [KEYS_CONNECT_STORAGE_KEY, '/keys'],
] as const

// Read-only: PostAuthRedirect removes the entries after commit, not during
// render. StrictMode renders twice in dev, and removing here left the second
// render with nothing, dropping the pending query (ducnmm review).
function readPendingConnectQuery(storageKey: string): string {
  const pending = sessionStorage.getItem(storageKey)
  if (!pending) return ''
  try {
    const params = JSON.parse(pending) as Record<string, string>
    return new URLSearchParams(params).toString()
  } catch {
    return ''
  }
}

/** Distinct from readPendingConnectQuery: an empty query here still means
 *  "yes, resume /setup" (null means nothing was pending at all). */
function readPendingSetupVisit(): { query: string } | null {
  const pending = sessionStorage.getItem(SETUP_CONNECT_STORAGE_KEY)
  if (pending === null) return null
  try {
    const params = JSON.parse(pending) as Record<string, string>
    return { query: new URLSearchParams(params).toString() }
  } catch {
    return { query: '' }
  }
}

/** Where a pending connect or /setup visit resumes, and how many
 *  PENDING_CONNECTS entries were checked to decide it (all of them when
 *  none won). */
function resolvePostAuthResume(): { to: string | null; connectsChecked: number } {
  for (const [index, [storageKey, path]] of PENDING_CONNECTS.entries()) {
    const query = readPendingConnectQuery(storageKey)
    if (query) return { to: `${path}?${query}`, connectsChecked: index + 1 }
  }
  // Respects an explicit /setup visit over PostAuthAccountCheck's own
  // account-existence guess — matters for an account that exists elsewhere
  // (another device/browser) but has no local session here, which would
  // otherwise get silently redirected to /dashboard against what they asked
  // for. A genuinely new account ends up at /setup either way.
  const pendingSetup = readPendingSetupVisit()
  if (pendingSetup) {
    return {
      to: pendingSetup.query ? `/setup?${pendingSetup.query}` : '/setup',
      connectsChecked: PENDING_CONNECTS.length,
    }
  }
  return { to: null, connectsChecked: PENDING_CONNECTS.length }
}

/** Lands here after a successful sign-in (the OAuth redirect_uri is the app
 *  root). Resume an interrupted hosted Claude or local MCP connection by
 *  restoring its saved query string; otherwise resolve whether this is a
 *  brand-new account. */
export function PostAuthRedirect() {
  const { to, connectsChecked } = resolvePostAuthResume()

  // Consume once, after commit — prevents a redirect loop on later visits to
  // `/`. Removes every entry checked (a present-but-unparsable one included)
  // and the /setup breadcrumb, which is either the one resuming now or a
  // stray from an unrelated earlier render that must not hijack a later
  // sign-in once a real pending connect wins (ducnmm review).
  useEffect(() => {
    for (const [storageKey] of PENDING_CONNECTS.slice(0, connectsChecked)) {
      sessionStorage.removeItem(storageKey)
    }
    sessionStorage.removeItem(SETUP_CONNECT_STORAGE_KEY)
  }, [connectsChecked])

  if (to) return <Navigate to={to} replace />
  return <PostAuthAccountCheck />
}

/** COMG-1092's new-user route sends a signed-out visitor straight into
 *  Enoki sign-in with no page of its own — so this is the first chance to
 *  route a brand-new account (no on-chain Account object yet) to /setup
 *  instead of /dashboard's "no keys yet, create one" prompt. An existing
 *  account always lands on /dashboard, same as before this existed. */
export function PostAuthAccountCheck() {
  const currentAccount = useCurrentAccount()
  const suiClient = useSuiClient()
  const [target, setTarget] = useState<'/dashboard' | '/setup' | null>(null)

  useEffect(() => {
    // AppContent only reaches this component when currentAccount is already
    // set (see the "/" route below) — this guard is defensive, not expected.
    if (!currentAccount) return
    let cancelled = false
    fetchAccountIdForOwner(suiClient, config.memwalRegistryId, currentAccount.address)
      .then((accountId) => {
        if (!cancelled) setTarget(accountId ? '/dashboard' : '/setup')
      })
      .catch((err) => {
        console.error('Failed to resolve account after sign-in:', err)
        if (!cancelled) setTarget('/dashboard')
      })
    return () => {
      cancelled = true
    }
  }, [currentAccount, suiClient])

  if (!currentAccount) return <Navigate to="/dashboard" replace />

  if (!target) return <RoutePending />
  return <Navigate to={target} replace />
}

/** The /setup route's element. A component, not a function invoked while
 *  AppContent builds its route table — <Routes> evaluates every element
 *  prop on every render regardless of the active path, so the old
 *  requireAccountForSetup(...) helper wrote the breadcrumb on every
 *  signed-out render of the whole app, not only on an actual /setup visit
 *  (ducnmm review, WALM-675). Scoping the write to this component's effect
 *  means it only runs once React Router actually mounts it. */
function RequireAccountForSetup() {
  const currentAccount = useCurrentAccount()
  const autoConnectStatus = useAutoConnectWallet()
  const authPending = autoConnectStatus === 'idle'
  const { delegateKey } = useDelegateKey()
  const [searchParams] = useSearchParams()
  const from = searchParams.get('from')

  useEffect(() => {
    if (!authPending && !currentAccount) {
      sessionStorage.setItem(SETUP_CONNECT_STORAGE_KEY, JSON.stringify(from ? { from } : {}))
    }
  }, [authPending, currentAccount, from])

  if (authPending) return <RoutePending />
  if (!currentAccount) return <Navigate to="/" replace />
  // SetupWizard calls setDelegateKeys() (updating this same context) before
  // setStep('done'), so this branch flips true and unmounts SetupWizard on
  // the very next render — before its own done-step effect's timer fires.
  // The `fromConsoleSetup` signal has to live on THIS navigate, the one that
  // actually wins the race, not on SetupWizard's (ducnmm review, WALM-675).
  if (delegateKey) {
    return <Navigate to="/dashboard" replace state={from === 'console' ? { fromConsoleSetup: true } : undefined} />
  }
  return <SetupWizard />
}

function AppContent() {
  const currentAccount = useCurrentAccount()
  const autoConnectStatus = useAutoConnectWallet()
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
      {/* dev (#1003): owns the has-key redirect and the fromConsoleSetup signal. */}
      <Route path="/setup" element={<RequireAccountForSetup />} />
      {/* #1006: the playground only needs a signed-in account. */}
      <Route path="/playground" element={requireAccount(<Playground />)} />
      <Route path="/connect/mcp" element={<ConnectMcp />} />
      <Route path="/connect/claude" element={<ConnectClaude />} />
      <Route path="/keys" element={<KeysPage />} />
      <Route path="/admin" element={<AdminDashboard />} />
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
