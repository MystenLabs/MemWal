/**
 * Playground — Interactive Demo Showcase
 *
 * Shows code for each Walrus Memory SDK operation, with a "Run" button
 * that executes the call against a live server using the real SDK.
 */

import { useState, useCallback, useMemo, useEffect, useLayoutEffect, useRef, type ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { LayoutDashboard, LogOut, TriangleAlert } from 'lucide-react'
import { Light as SyntaxHighlighter } from 'react-syntax-highlighter'
import js from 'react-syntax-highlighter/dist/esm/languages/hljs/javascript'

SyntaxHighlighter.registerLanguage('javascript', js)
import {
    useCurrentAccount,
    useDisconnectWallet,
    useSuiClient,
} from '@mysten/dapp-kit'
import { MemWal } from '@mysten-incubation/memwal'
import type { RememberJobStatus } from '@mysten-incubation/memwal'
import { useDelegateKey } from '../App'
import { Card } from '../components/Card'
import { config } from '../config'
import { getAnalyticsErrorType, trackEvent } from '../utils/analytics'
import { assertDelegateKeyRegistered, deriveDelegatePublicKeyHex, normalizeDelegatePrivateKey } from '../utils/delegateKeyImport'
import { fetchAccountIdForOwner } from '../utils/suiClientCompat'

const walrusCodeTheme = {
    hljs: {
        color: '#ffffff',
        background: '#1c1f26',
    },
    'hljs-keyword': {
        color: '#d9cbff',
    },
    'hljs-built_in': {
        color: '#ffffff',
    },
    'hljs-title': {
        color: '#ffffff',
    },
    'hljs-attr': {
        color: '#f4ff8a',
    },
    'hljs-property': {
        color: '#f4ff8a',
    },
    'hljs-variable': {
        color: '#ffffff',
    },
    'hljs-string': {
        color: '#f4ff8a',
    },
    'hljs-comment': {
        color: '#b4b7bb',
    },
    'hljs-number': {
        color: '#f4ff8a',
    },
    'hljs-literal': {
        color: '#f4ff8a',
    },
    'hljs-params': {
        color: '#ffffff',
    },
}

// ============================================================
// Demo Step — reusable step card
// ============================================================

interface DemoStepProps {
    number: number
    title: string
    description: string
    code: string
    onRun: () => Promise<void>
    result: string | null
    resultLabel?: string
    error: string | null
    loading: boolean
    runDisabled?: boolean
    highlight?: boolean
    children?: ReactNode
}

function trackPlaygroundOperation(
    operation: string,
    status: 'start' | 'complete' | 'failed',
    params: Record<string, string | number | boolean> = {},
) {
    trackEvent(`playground_operation_${status}`, {
        operation,
        ...params,
    })
}

function DemoStep({
    number,
    title,
    description,
    code,
    onRun,
    result,
    resultLabel = 'response',
    error,
    loading,
    runDisabled = false,
    highlight,
    children,
}: DemoStepProps) {
    const hasOutput = result || error
    return (
        <Card
            className="demo-step"
            leading={<div className={`demo-step-badge${highlight ? ' demo-step-badge--highlight' : ''}`}>{number}</div>}
            leadingRowClassName="demo-step-header-row"
            title={title}
            subtitle={description}
            action={
                <button
                    className={`btn btn-primary btn-sm${loading ? ' demo-run-button--loading' : ''}`}
                    onClick={onRun}
                    disabled={loading || runDisabled}
                >
                    {loading ? (
                        <span className="spinner demo-button-spinner" />
                    ) : (
                        'Run'
                    )}
                </button>
            }
        >

            {/* Optional inputs (injected via children) */}
            {children}

            {/* Code block */}
            <div className={hasOutput ? 'demo-code-slot demo-code-block--spaced' : 'demo-code-slot'}>
                <SyntaxHighlighter
                    language="javascript"
                    style={walrusCodeTheme}
                    className="demo-code-block"
                    customStyle={{ margin: 0 }}
                >
                    {code}
                </SyntaxHighlighter>
            </div>

            {/* Success result */}
            {result && (
                <div className="demo-result-panel">
                    <div className="demo-result-label">{resultLabel}</div>
                    <pre className="demo-result-pre">{result}</pre>
                </div>
            )}

            {/* Error */}
            {error && (
                <div className="demo-error-panel">
                    <div className="demo-error-label">Error</div>
                    <pre className="demo-error-pre">{error}</pre>
                </div>
            )}
        </Card>
    )
}

// ============================================================
// Playground Page
// ============================================================

export default function Playground() {
    const currentAccount = useCurrentAccount()
    const { mutateAsync: disconnect } = useDisconnectWallet()
    const { delegateKey, clearDelegateKeys, accountObjectId, setDelegateKeys } = useDelegateKey()
    const suiClient = useSuiClient()

    const address = currentAccount?.address || ''
    const [navSolid, setNavSolid] = useState(false)

    useLayoutEffect(() => {
        window.scrollTo(0, 0)
    }, [])

    useEffect(() => {
        const onScroll = () => setNavSolid(window.scrollY > 220)
        onScroll()
        window.addEventListener('scroll', onScroll, { passive: true })
        return () => window.removeEventListener('scroll', onScroll)
    }, [])
    const serverUrl = config.memwalServerUrl
    const keyStatus = delegateKey ? 'configured' : 'missing'
    const [resolvedAccountId, setResolvedAccountId] = useState<string | null>(accountObjectId)
    const [accountLookupPending, setAccountLookupPending] = useState(false)
    const [existingKey, setExistingKey] = useState('')
    const [existingKeyError, setExistingKeyError] = useState('')
    const [importingExistingKey, setImportingExistingKey] = useState(false)
    const accountIdRef = useRef(accountObjectId ?? resolvedAccountId)
    accountIdRef.current = accountObjectId ?? resolvedAccountId

    useEffect(() => {
        if (!address) {
            setResolvedAccountId(null)
            setAccountLookupPending(false)
            return
        }
        if (accountObjectId) {
            setResolvedAccountId(accountObjectId)
            setAccountLookupPending(false)
            return
        }
        let cancelled = false
        setResolvedAccountId(null)
        setAccountLookupPending(true)
        fetchAccountIdForOwner(suiClient, config.memwalRegistryId, address)
            .then((accountId) => {
                if (!cancelled) setResolvedAccountId(accountId)
            })
            .catch(() => {
                if (!cancelled) setResolvedAccountId(null)
            })
            .finally(() => {
                if (!cancelled) setAccountLookupPending(false)
            })
        return () => { cancelled = true }
    }, [address, accountObjectId, suiClient])

    const importExistingKey = useCallback(async (rawKey: string) => {
        const normalized = normalizeDelegatePrivateKey(rawKey)
        if (!normalized) {
            setExistingKeyError('Delegate key must be a 64-character hex private key.')
            trackEvent('delegate_key_import_failed', { error_type: 'invalid_input', location: 'playground' })
            return
        }
        const accountId = accountObjectId ?? resolvedAccountId
        if (!accountId) {
            setExistingKeyError('No Walrus Memory account found for this wallet. Create a delegate key first.')
            trackEvent('delegate_key_import_failed', { error_type: 'no_account', location: 'playground' })
            return
        }
        setImportingExistingKey(true)
        setExistingKeyError('')
        trackEvent('delegate_key_import_start', { location: 'playground' })
        try {
            const publicKeyHex = await deriveDelegatePublicKeyHex(normalized)
            await assertDelegateKeyRegistered(suiClient, accountId, publicKeyHex)
            if (accountIdRef.current !== accountId) return
            setDelegateKeys(normalized, publicKeyHex, accountId)
            setExistingKey('')
            trackEvent('delegate_key_import_complete', { location: 'playground' })
        } catch (err) {
            const message = err instanceof Error ? err.message : 'Failed to import delegate key. Please try again.'
            setExistingKeyError(message)
            trackEvent('delegate_key_import_failed', {
                error_type: getAnalyticsErrorType(err),
                location: 'playground',
            })
        } finally {
            setImportingExistingKey(false)
        }
    }, [accountObjectId, resolvedAccountId, setDelegateKeys, suiClient])

    // ============================================================
    // SDK Instance — created from delegate key
    // ============================================================

    const initialQueryNamespace = useMemo(() => {
        if (typeof window === 'undefined') return null
        const value = new URLSearchParams(window.location.search).get('namespace')?.trim()
        return value || null
    }, [])
    const consumedQueryNamespace = useRef(false)
    const [hydratedAccountId, setHydratedAccountId] = useState<string | null>(null)
    const [namespace, setNamespace] = useState(() => {
        if (initialQueryNamespace) return initialQueryNamespace
        if (typeof window === 'undefined' || !accountObjectId) return 'default'
        return window.localStorage.getItem(`memwal.playground.namespace.${accountObjectId}`) || 'default'
    })

    const persistNamespace = useCallback((accountId: string, value: string) => {
        window.localStorage.setItem(`memwal.playground.namespace.${accountId}`, value)
    }, [])

    useEffect(() => {
        if (!accountObjectId) {
            setHydratedAccountId(null)
            return
        }
        if (initialQueryNamespace && !consumedQueryNamespace.current) {
            consumedQueryNamespace.current = true
            setNamespace(initialQueryNamespace)
            persistNamespace(accountObjectId, initialQueryNamespace)
            const url = new URL(window.location.href)
            url.searchParams.delete('namespace')
            window.history.replaceState({}, '', `${url.pathname}${url.search}${url.hash}`)
        } else {
            const saved = window.localStorage.getItem(`memwal.playground.namespace.${accountObjectId}`)
            setNamespace(saved || 'default')
        }
        setHydratedAccountId(accountObjectId)
    }, [accountObjectId, initialQueryNamespace, persistNamespace])

    useEffect(() => {
        if (!accountObjectId || hydratedAccountId !== accountObjectId) return
        persistNamespace(accountObjectId, namespace)
    }, [accountObjectId, hydratedAccountId, namespace, persistNamespace])

    const memwal = useMemo(() => {
        if (!delegateKey || !accountObjectId) return null
        return MemWal.create({
            key: delegateKey,
            accountId: accountObjectId,
            serverUrl,
            namespace: namespace || undefined,
        })
    }, [delegateKey, accountObjectId, serverUrl, namespace])

    // Step states

    const [healthResult, setHealthResult] = useState<string | null>(null)
    const [healthError, setHealthError] = useState<string | null>(null)
    const [healthLoading, setHealthLoading] = useState(false)

    const [rememberText, setRememberText] = useState(
        "I'm a software engineer living in Ho Chi Minh City. I love Vietnamese coffee and coding in Rust.",
    )
    const [rememberResult, setRememberResult] = useState<string | null>(null)
    const [rememberError, setRememberError] = useState<string | null>(null)
    const [rememberLoading, setRememberLoading] = useState(false)

    const [recallQuery, setRecallQuery] = useState('Where does the user live?')
    const [recallResult, setRecallResult] = useState<string | null>(null)
    const [recallError, setRecallError] = useState<string | null>(null)
    const [recallLoading, setRecallLoading] = useState(false)



    const handleLogout = useCallback(async () => {
        trackEvent('sign_out', { location: 'playground' })
        clearDelegateKeys()
        await disconnect()
    }, [clearDelegateKeys, disconnect])

    // ---- Handlers (using SDK) ----

    const runHealth = useCallback(async () => {
        if (!memwal) return
        trackPlaygroundOperation('health', 'start')
        setHealthLoading(true)
        setHealthResult(null)
        setHealthError(null)
        try {
            const data = await memwal.health()
            setHealthResult(JSON.stringify(data, null, 2))
            trackPlaygroundOperation('health', 'complete')
        } catch (err: unknown) {
            setHealthError(err instanceof Error ? err.message : String(err))
            trackPlaygroundOperation('health', 'failed', { error_type: getAnalyticsErrorType(err) })
        } finally {
            setHealthLoading(false)
        }
    }, [memwal])

    const runRemember = useCallback(async () => {
        if (!memwal) return
        trackPlaygroundOperation('remember', 'start')
        setRememberLoading(true)
        setRememberResult(null)
        setRememberError(null)
        const t0 = Date.now()
        const elapsed = () => ((Date.now() - t0) / 1000).toFixed(1)

        try {
            // Stage 1 — fire-and-accept. The relayer returns 202 with
            // {job_id, status: "running"} as soon as the work is enqueued.
            // Show this immediately so the user can see the async-job
            // pattern (the playground's whole value prop).
            const accepted = await memwal.rememberAsync(rememberText)
            const acceptedBlock =
                `// 1. accepted (HTTP 202) at T+${elapsed()}s\n` +
                JSON.stringify(accepted, null, 2)

            // Stage 2 — drive our own polling loop instead of letting
            // waitForRememberJob block to terminal. That way each
            // intermediate state (pending → running → uploaded → done)
            // surfaces to the UI as it happens, not just the final
            // value. Server-side state machine: routes.rs writes
            // status='running' on accept, jobs.rs flips to 'uploaded'
            // after the walrus write certifies, then 'done' once the
            // meta-transfer + blob_id is committed.
            const TIMEOUT_MS = 90_000
            const POLL_MS = 1500
            const deadline = Date.now() + TIMEOUT_MS

            let lastStatus = accepted.status
            const transitions: Array<{ status: string; tSec: string }> = [
                { status: accepted.status, tSec: '0.0' },
            ]

            const renderProgress = (current: RememberJobStatus | null) => {
                const ladder = transitions
                    .map((t) => `//   [${t.tSec}s] ${t.status}`)
                    .join('\n')
                const tail = current
                    ? JSON.stringify(current, null, 2)
                    : '// (polling...)'
                setRememberResult(
                    `${acceptedBlock}\n\n` +
                        `// 2. polling /api/remember/${accepted.job_id} ` +
                        `every ${POLL_MS}ms (max ${TIMEOUT_MS / 1000}s)\n` +
                        `${ladder}\n\n` +
                        `// current (T+${elapsed()}s)\n${tail}`
                )
            }
            renderProgress(null)

            // Polling loop. await-in-loop is intentional — we want strict
            // serial requests so we don't pile up retries when the server
            // is briefly slow.
            let terminal: RememberJobStatus | null = null
            while (Date.now() < deadline && !terminal) {
                await new Promise((r) => setTimeout(r, POLL_MS))
                const current = await memwal.getRememberStatus(
                    accepted.job_id
                )
                if (current.status !== lastStatus) {
                    transitions.push({
                        status: current.status,
                        tSec: elapsed(),
                    })
                    lastStatus = current.status
                }
                renderProgress(current)

                if (
                    current.status === 'done' ||
                    current.status === 'failed' ||
                    current.status === 'not_found'
                ) {
                    terminal = current
                }
            }

            if (!terminal) {
                throw Object.assign(
                    new Error(
                        `remember job timed out after ${TIMEOUT_MS / 1000}s ` +
                            `(job_id=${accepted.job_id})`
                    ),
                    { jobId: accepted.job_id }
                )
            }

            if (terminal.status === 'failed') {
                throw Object.assign(
                    new Error(
                        `remember job failed: ${terminal.error ?? 'unknown error'}`
                    ),
                    { jobId: accepted.job_id }
                )
            }
            if (terminal.status === 'not_found') {
                throw Object.assign(
                    new Error(
                        `remember job not_found (job_id=${accepted.job_id})`
                    ),
                    { jobId: accepted.job_id }
                )
            }

            // terminal.status === 'done'
            const ladder = transitions
                .map((t) => `//   [${t.tSec}s] ${t.status}`)
                .join('\n')
            setRememberResult(
                `${acceptedBlock}\n\n` +
                    `// 2. state machine traversal\n${ladder}\n\n` +
                    `// 3. terminal at T+${elapsed()}s\n` +
                    JSON.stringify(terminal, null, 2)
            )
            trackPlaygroundOperation('remember', 'complete')
        } catch (err: unknown) {
            const msg = err instanceof Error ? err.message : String(err)
            const jobId = (err as { jobId?: string } | null)?.jobId
            if (jobId && /timed out/i.test(msg)) {
                setRememberError(
                    `${msg}\n\n` +
                        `The job is still running on the server — re-run this ` +
                        `step or query \`GET /api/remember/${jobId}\` ` +
                        `directly to check its state.`
                )
            } else {
                setRememberError(msg)
            }
            trackPlaygroundOperation('remember', 'failed', { error_type: getAnalyticsErrorType(err) })
        } finally {
            setRememberLoading(false)
        }
    }, [memwal, rememberText])

    const runRecall = useCallback(async () => {
        if (!memwal) return
        trackPlaygroundOperation('recall', 'start')
        setRecallLoading(true)
        setRecallResult(null)
        setRecallError(null)
        try {
            const data = await memwal.recall({ query: recallQuery, limit: 5 })
            setRecallResult(JSON.stringify(data, null, 2))
            trackPlaygroundOperation('recall', 'complete')
        } catch (err: unknown) {
            setRecallError(err instanceof Error ? err.message : String(err))
            trackPlaygroundOperation('recall', 'failed', { error_type: getAnalyticsErrorType(err) })
        } finally {
            setRecallLoading(false)
        }
    }, [memwal, recallQuery])



    // ---- Render ----

    return (
        <div className="dash-page">
            <nav className={`nav playground-nav dashboard-nav${navSolid ? ' dashboard-nav--solid' : ''}`}>
                <div className="nav-inner">
                    <Link to="/" className="nav-brand">
                        <img className="nav-brand-logo" src="/walrus-memory-logo.svg?v=3" alt="Walrus Memory" />
                    </Link>
                    <div className="nav-user">
                        <Link to="/dashboard" className="demo-nav-back" aria-label="Dashboard">
                            <LayoutDashboard className="demo-nav-icon" size={18} aria-hidden="true" />
                            <span className="demo-nav-label">Dashboard</span>
                        </Link>
                        <span className="nav-address">
                            {address.slice(0, 6)}...{address.slice(-4)}
                        </span>
                        <button
                            className="lp-nav-cta"
                            onClick={handleLogout}
                        >
                            Sign out <LogOut size={14} />
                        </button>
                    </div>
                </div>
            </nav>

            <main className="dash-shell playground-dashboard">
                {/* Header */}
                <div className="dashboard-header">
                    <h2>Developer Playground</h2>
                    <p>
                        Test Walrus Memory SDK operations with your current server and credentials.
                        Run steps against your server using <code>@mysten-incubation/memwal</code>.
                        {config.docsUrl && (
                            <> See the <a className="demo-doc-link" href={config.docsUrl} target="_blank" rel="noopener noreferrer" onClick={() => trackEvent('outbound_link_click', { link: 'docs', location: 'playground' })}>documentation</a> for full API reference.</>
                        )}
                    </p>
                </div>

                {delegateKey ? (
                <div className="demo-server-info">
                    <div className="demo-server-tag">
                        server: <span className="demo-tag-value demo-tag-value--server">{serverUrl}</span>
                    </div>
                    <div className="demo-server-tag">
                        key: <span className="demo-tag-value demo-tag-value--key">{keyStatus}</span>
                    </div>
                    <div className="demo-server-tag">
                        SDK: <span className="demo-tag-value demo-tag-value--sdk">@mysten-incubation/memwal</span>
                    </div>
                    <div className="demo-server-tag demo-server-tag--namespace">
                        <span>namespace:</span>
                        <input
                            className="demo-namespace-input"
                            value={namespace}
                            onChange={(e) => setNamespace(e.target.value)}
                            placeholder="default"
                            size={Math.max(namespace.length, 7)}
                        />
                    </div>
                </div>
                ) : (
                    <div className="playground-key-gate">
                        <div className="playground-key-note" role="status">
                            <div className="playground-key-note-line">
                                <TriangleAlert size={16} strokeWidth={2.2} aria-hidden="true" />
                                <p>This browser tab doesn't have a delegate key, so the steps below can't run yet.</p>
                            </div>
                            <form
                                className="playground-key-form"
                                onSubmit={(event) => {
                                    event.preventDefault()
                                    void importExistingKey(existingKey)
                                }}
                            >
                                <label htmlFor="playground-existing-key">Already have a delegate key?</label>
                                <div className="playground-key-row">
                                    <input
                                        id="playground-existing-key"
                                        value={existingKey}
                                        onChange={(event) => setExistingKey(event.target.value)}
                                        placeholder="Paste an existing delegate key"
                                        aria-label="existing delegate key"
                                        spellCheck={false}
                                        autoComplete="off"
                                    />
                                    <button
                                        type="submit"
                                        disabled={importingExistingKey || accountLookupPending || !existingKey.trim()}
                                    >
                                        {importingExistingKey ? 'Checking key...' : accountLookupPending ? 'Checking account...' : 'Use this key'}
                                    </button>
                                </div>
                                {existingKeyError && (
                                    <p className="playground-key-error" role="alert">{existingKeyError}</p>
                                )}
                                <Link to="/dashboard#delegate-keys">Create a delegate key</Link>
                            </form>
                        </div>
                    </div>
                )}

                {/* Step 1: Health */}
                <DemoStep
                    number={1}
                    title="Run a health check"
                    description="Verify the Walrus Memory server is running:"
                    code={`import { MemWal } from "@mysten-incubation/memwal"

const memwal = MemWal.create({
  key: delegateKeyHex,
  accountId: "${accountObjectId?.slice(0, 10)}...",
  serverUrl: "${serverUrl}",
  namespace: "${namespace || 'default'}",
})

const data = await memwal.health()
// → { status: "ok", version: "0.1.0" }`}
                    onRun={runHealth}
                    result={healthResult}
                    error={healthError}
                    loading={healthLoading}
                    runDisabled={!delegateKey}
                />

                {/* Step 2: Remember */}
                <DemoStep
                    number={2}
                    title="Remember"
                    description="Store a memory and save it to Walrus, encrypted."
                    code={`// 1. enqueue — returns 202 with { job_id, status: "running" }
const accepted = await memwal.rememberAsync(
  "${rememberText.slice(0, 60)}..."
)
// namespace: "${namespace || 'default'}"

// 2. poll signed GET /api/remember/{job_id} every 1.5s.
// Each call surfaces the current state (pending →
// running → uploaded → done). Use waitForRememberJob
// instead if you only need the terminal result.
while (true) {
  const s = await memwal.getRememberStatus(accepted.job_id)
  if (s.status === "done")   { return s }
  if (s.status === "failed") { throw new Error(s.error) }
  await sleep(1500)
}`}
                    onRun={runRemember}
                    result={rememberResult}
                    resultLabel="memory saved (accepted → terminal)"
                    error={rememberError}
                    loading={rememberLoading}
                    runDisabled={!delegateKey}
                >
                    <div className="input-group">
                        <label>Type a fact for Walrus Memory to remember:</label>
                        <textarea
                            className="input"
                            rows={3}
                            value={rememberText}
                            onChange={(e) => setRememberText(e.target.value)}
                        />
                    </div>
                </DemoStep>

                {/* Step 3: Recall */}
                <DemoStep
                    number={3}
                    title="Recall"
                    description="Search and retrieve memories, decrypted."
                    code={`const result = await memwal.recall({ query: "${recallQuery}", limit: 5 })
// Server: embed query → cosine search → download → decrypt
// namespace: "${namespace || 'default'}" — only searches within this namespace
// → { results: [{ text, blob_id, distance }], total }`}
                    onRun={runRecall}
                    result={recallResult}
                    resultLabel="memories found (decrypted)"
                    error={recallError}
                    loading={recallLoading}
                    runDisabled={!delegateKey}
                >
                    <div className="input-group">
                        <label>Query to recall the memory you saved:</label>
                        <input
                            className="input"
                            value={recallQuery}
                            onChange={(e) => setRecallQuery(e.target.value)}
                        />
                    </div>
                </DemoStep>

                <section className="playground-done">
                    <h2>You're up and running.</h2>
                    <p>
                        If Walrus Memory is useful to you, a star on the{' '}
                        <a href="https://github.com/MystenLabs/memwal" target="_blank" rel="noopener noreferrer">GitHub repo</a>{' '}
                        helps others find it.
                    </p>
                </section>



            </main>
        </div>
    )
}
