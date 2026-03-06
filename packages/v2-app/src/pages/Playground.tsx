/**
 * Playground — Interactive Demo Showcase
 *
 * Shows code for each memwal SDK operation, with a "Run" button
 * that executes the call against a live server.
 */

import { useState, useCallback } from 'react'
import {
    useCurrentAccount,
    useDisconnectWallet,
} from '@mysten/dapp-kit'
import { useDelegateKey } from '../App'
import { config } from '../config'

// ============================================================
// Minimal inline memwal client for demo (no npm import needed)
// ============================================================

async function signRequest(
    privateKeyHex: string,
    method: string,
    path: string,
    body: string,
) {
    const ed = await import('@noble/ed25519')
    const timestamp = Math.floor(Date.now() / 1000).toString()

    // SHA-256 of body
    const bodyBytes = new TextEncoder().encode(body)
    const hashBuf = await crypto.subtle.digest('SHA-256', bodyBytes)
    const bodySha = Array.from(new Uint8Array(hashBuf))
        .map((b) => b.toString(16).padStart(2, '0'))
        .join('')

    const message = `${timestamp}.${method}.${path}.${bodySha}`
    const msgBytes = new TextEncoder().encode(message)

    const privKey = Uint8Array.from(
        { length: privateKeyHex.length / 2 },
        (_, i) => parseInt(privateKeyHex.slice(i * 2, i * 2 + 2), 16),
    )
    const pubKey = await ed.getPublicKeyAsync(privKey)
    const signature = await ed.signAsync(msgBytes, privKey)

    return {
        timestamp,
        publicKey: Array.from(pubKey)
            .map((b) => b.toString(16).padStart(2, '0'))
            .join(''),
        signature: Array.from(signature)
            .map((b) => b.toString(16).padStart(2, '0'))
            .join(''),
    }
}

async function apiCall(
    privateKeyHex: string,
    serverUrl: string,
    path: string,
    body: object,
    accountId?: string,
) {
    const bodyStr = JSON.stringify(body)
    const { timestamp, publicKey, signature } = await signRequest(
        privateKeyHex,
        'POST',
        path,
        bodyStr,
    )

    const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        'x-public-key': publicKey,
        'x-signature': signature,
        'x-timestamp': timestamp,
    }
    if (accountId) {
        headers['x-account-id'] = accountId
    }

    const resp = await fetch(`${serverUrl}${path}`, {
        method: 'POST',
        headers,
        body: bodyStr,
    })

    if (!resp.ok) {
        const err = await resp.text()
        throw new Error(`API error (${resp.status}): ${err}`)
    }

    return resp.json()
}

// ============================================================
// Demo Step Component
// ============================================================

interface DemoStepProps {
    number: number
    title: string
    description: string
    code: string
    onRun: () => Promise<void>
    result: string | null
    error: string | null
    loading: boolean
}

function DemoStep({
    number,
    title,
    description,
    code,
    onRun,
    result,
    error,
    loading,
}: DemoStepProps) {
    return (
        <div className="card" style={{ marginBottom: 24 }}>
            <div className="card-header">
                <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                    <div
                        style={{
                            width: 36,
                            height: 36,
                            borderRadius: '50%',
                            background: 'var(--accent-subtle)',
                            border: '1px solid var(--border-accent)',
                            display: 'flex',
                            alignItems: 'center',
                            justifyContent: 'center',
                            fontSize: '1rem',
                            fontWeight: 700,
                            color: 'var(--accent)',
                            flexShrink: 0,
                        }}
                    >
                        {number}
                    </div>
                    <div>
                        <div className="card-title">{title}</div>
                        <div className="card-subtitle">{description}</div>
                    </div>
                </div>
                <button
                    className="btn btn-primary btn-sm"
                    onClick={onRun}
                    disabled={loading}
                    style={{ minWidth: 80 }}
                >
                    {loading ? (
                        <span className="spinner" style={{ width: 14, height: 14 }} />
                    ) : (
                        '▶ run'
                    )}
                </button>
            </div>

            {/* Code */}
            <pre
                style={{
                    background: 'var(--bg-input)',
                    border: '1px solid var(--border)',
                    borderRadius: 'var(--radius-md)',
                    padding: 16,
                    overflow: 'auto',
                    fontSize: '0.78rem',
                    lineHeight: 1.7,
                    fontFamily: 'var(--font-mono)',
                    color: 'var(--text-secondary)',
                    marginBottom: result || error ? 12 : 0,
                }}
            >
                <code>{code}</code>
            </pre>

            {/* Result */}
            {
                result && (
                    <div
                        style={{
                            background: 'rgba(52, 211, 153, 0.06)',
                            border: '1px solid rgba(52, 211, 153, 0.2)',
                            borderRadius: 'var(--radius-md)',
                            padding: 16,
                        }}
                    >
                        <div
                            style={{
                                fontSize: '0.7rem',
                                color: 'var(--success)',
                                letterSpacing: '0.08em',
                                marginBottom: 8,
                                fontWeight: 600,
                            }}
                        >
                            response
                        </div>
                        <pre
                            style={{
                                fontSize: '0.78rem',
                                lineHeight: 1.6,
                                fontFamily: 'var(--font-mono)',
                                color: 'var(--text-primary)',
                                whiteSpace: 'pre-wrap',
                                wordBreak: 'break-all',
                                margin: 0,
                            }}
                        >
                            {result}
                        </pre>
                    </div>
                )
            }

            {/* Error */}
            {
                error && (
                    <div
                        style={{
                            background: 'rgba(248, 113, 113, 0.06)',
                            border: '1px solid rgba(248, 113, 113, 0.2)',
                            borderRadius: 'var(--radius-md)',
                            padding: 16,
                        }}
                    >
                        <div
                            style={{
                                fontSize: '0.7rem',
                                color: 'var(--danger)',
                                letterSpacing: '0.08em',
                                marginBottom: 8,
                                fontWeight: 600,
                            }}
                        >
                            error
                        </div>
                        <pre
                            style={{
                                fontSize: '0.78rem',
                                fontFamily: 'var(--font-mono)',
                                color: 'var(--danger)',
                                whiteSpace: 'pre-wrap',
                                margin: 0,
                            }}
                        >
                            {error}
                        </pre>
                    </div>
                )
            }
        </div >
    )
}

// ============================================================
// Playground Page
// ============================================================

export default function Playground() {
    const currentAccount = useCurrentAccount()
    const { mutateAsync: disconnect } = useDisconnectWallet()
    const { delegateKey, accountObjectId, clearDelegateKeys } = useDelegateKey()

    const address = currentAccount?.address || ''
    const serverUrl = config.memwalServerUrl
    const keyPreview = delegateKey
        ? `${delegateKey.slice(0, 8)}...${delegateKey.slice(-8)}`
        : '...'

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

    const [analyzeText, setAnalyzeText] = useState(
        "I prefer dark mode in all my apps. My favorite programming language is Rust. I'm allergic to shellfish.",
    )
    const [analyzeResult, setAnalyzeResult] = useState<string | null>(null)
    const [analyzeError, setAnalyzeError] = useState<string | null>(null)
    const [analyzeLoading, setAnalyzeLoading] = useState(false)

    const [askQuestion, setAskQuestion] = useState('What do you know about me?')
    const [askLlmKey, setAskLlmKey] = useState('')
    const [askLlmProvider, setAskLlmProvider] = useState<'openai' | 'openrouter'>('openai')
    const [askResult, setAskResult] = useState<{ answer: string; memories: any[]; systemPrompt: string } | null>(null)
    const [askError, setAskError] = useState<string | null>(null)
    const [askLoading, setAskLoading] = useState(false)
    const [askPhase, setAskPhase] = useState('')

    const handleLogout = useCallback(async () => {
        clearDelegateKeys()
        await disconnect()
    }, [clearDelegateKeys, disconnect])

    // Step 1: Health check
    const runHealth = useCallback(async () => {
        setHealthLoading(true)
        setHealthResult(null)
        setHealthError(null)
        try {
            const resp = await fetch(`${serverUrl}/health`)
            const data = await resp.json()
            setHealthResult(JSON.stringify(data, null, 2))
        } catch (err: any) {
            setHealthError(err.message)
        } finally {
            setHealthLoading(false)
        }
    }, [serverUrl])

    // Step 2: Remember
    const runRemember = useCallback(async () => {
        if (!delegateKey) return
        setRememberLoading(true)
        setRememberResult(null)
        setRememberError(null)
        try {
            const data = await apiCall(delegateKey, serverUrl, '/api/remember', {
                text: rememberText,
            }, accountObjectId || undefined)
            setRememberResult(JSON.stringify(data, null, 2))
        } catch (err: any) {
            setRememberError(err.message)
        } finally {
            setRememberLoading(false)
        }
    }, [delegateKey, serverUrl, rememberText, accountObjectId])

    // Step 3: Recall
    const runRecall = useCallback(async () => {
        if (!delegateKey) return
        setRecallLoading(true)
        setRecallResult(null)
        setRecallError(null)
        try {
            const data = await apiCall(delegateKey, serverUrl, '/api/recall', {
                query: recallQuery,
                limit: 5,
            }, accountObjectId || undefined)
            setRecallResult(JSON.stringify(data, null, 2))
        } catch (err: any) {
            setRecallError(err.message)
        } finally {
            setRecallLoading(false)
        }
    }, [delegateKey, serverUrl, recallQuery, accountObjectId])

    // Step 4: Analyze
    const runAnalyze = useCallback(async () => {
        if (!delegateKey) return
        setAnalyzeLoading(true)
        setAnalyzeResult(null)
        setAnalyzeError(null)
        try {
            const data = await apiCall(delegateKey, serverUrl, '/api/analyze', {
                text: analyzeText,
            }, accountObjectId || undefined)
            setAnalyzeResult(JSON.stringify(data, null, 2))
        } catch (err: any) {
            setAnalyzeError(err.message)
        } finally {
            setAnalyzeLoading(false)
        }
    }, [delegateKey, serverUrl, analyzeText, accountObjectId])

    // Step 5: Ask AI (true middleware pattern — user's own LLM key)
    const runAsk = useCallback(async () => {
        if (!delegateKey) return
        if (!askLlmKey.trim()) {
            setAskError('Please enter your LLM API key (OpenAI or OpenRouter)')
            return
        }
        setAskLoading(true)
        setAskResult(null)
        setAskError(null)

        try {
            // Phase 1: Call memwal recall (memory layer only)
            setAskPhase('step 1/3 — recalling memories from memwal...')
            const recallData = await apiCall(delegateKey, serverUrl, '/api/recall', {
                query: askQuestion,
                limit: 5,
            }, accountObjectId || undefined)

            const memories = recallData.results || []

            // Phase 2: Build prompt with memory context (this is what withmemwal does)
            setAskPhase(`step 2/3 — injecting ${memories.length} memories into prompt...`)
            const memoryContext = memories.length > 0
                ? `The following are known facts about this user (from encrypted Walrus storage):\n${memories.map((m: any) => `- ${m.text} (relevance: ${(((1 - m.distance) * 100)).toFixed(0)}%)`).join('\n')}`
                : 'No memories found for this user yet.'

            const systemPrompt = `You are a helpful AI assistant. The user has a personal memory store powered by memwal (encrypted, stored on Walrus blockchain).\n\n${memoryContext}\n\nUse the above context to provide personalized answers. If the memories don't contain relevant information, say so honestly.`

            // Phase 3: Call user's own LLM (NOT memwal — this is the user's API key)
            setAskPhase('step 3/3 — calling your LLM with enriched prompt...')
            const llmBase = askLlmProvider === 'openrouter'
                ? 'https://openrouter.ai/api/v1'
                : 'https://api.openai.com/v1'
            const model = askLlmProvider === 'openrouter'
                ? 'openai/gpt-4o-mini'
                : 'gpt-4o-mini'

            const llmResp = await fetch(`${llmBase}/chat/completions`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${askLlmKey.trim()}`,
                },
                body: JSON.stringify({
                    model,
                    messages: [
                        { role: 'system', content: systemPrompt },
                        { role: 'user', content: askQuestion },
                    ],
                    temperature: 0.7,
                }),
            })

            if (!llmResp.ok) {
                const errText = await llmResp.text()
                throw new Error(`LLM API error (${llmResp.status}): ${errText}`)
            }

            const llmData = await llmResp.json()
            const answer = llmData.choices?.[0]?.message?.content?.trim() || 'No response'

            setAskPhase('')
            setAskResult({ answer, memories, systemPrompt })
        } catch (err: any) {
            setAskPhase('')
            setAskError(err.message)
        } finally {
            setAskLoading(false)
        }
    }, [delegateKey, serverUrl, askQuestion, askLlmKey, askLlmProvider])

    return (
        <>
            <nav className="nav">
                <div className="nav-inner">
                    <div className="nav-brand">
                        <span>memwal</span>
                    </div>
                    <div className="nav-user">
                        <a
                            href="#"
                            onClick={(e) => {
                                e.preventDefault()
                                window.location.hash = ''
                                window.location.reload()
                            }}
                            style={{
                                color: 'var(--text-secondary)',
                                fontSize: '0.8rem',
                                textDecoration: 'none',
                            }}
                        >
                            ← dashboard
                        </a>
                        <span className="nav-address">
                            {address.slice(0, 6)}...{address.slice(-4)}
                        </span>
                        <button
                            className="btn btn-secondary btn-sm"
                            onClick={handleLogout}
                        >
                            sign out
                        </button>
                    </div>
                </div>
            </nav>

            <div className="container dashboard">
                {/* Header */}
                <div className="dashboard-header">
                    <h2>interactive demo</h2>
                    <p>
                        try each memwal SDK operation live. click{' '}
                        <strong>▶ run</strong> to execute against your server.
                    </p>
                </div>

                {/* Server info */}
                <div
                    style={{
                        display: 'flex',
                        gap: 16,
                        marginBottom: 32,
                        flexWrap: 'wrap',
                    }}
                >
                    <div
                        style={{
                            background: 'var(--bg-card)',
                            border: '1px solid var(--border)',
                            borderRadius: 'var(--radius-sm)',
                            padding: '8px 16px',
                            fontSize: '0.8rem',
                            fontFamily: 'var(--font-mono)',
                            color: 'var(--text-secondary)',
                        }}
                    >
                        server: <span style={{ color: 'var(--accent)' }}>{serverUrl}</span>
                    </div>
                    <div
                        style={{
                            background: 'var(--bg-card)',
                            border: '1px solid var(--border)',
                            borderRadius: 'var(--radius-sm)',
                            padding: '8px 16px',
                            fontSize: '0.8rem',
                            fontFamily: 'var(--font-mono)',
                            color: 'var(--text-secondary)',
                        }}
                    >
                        key: <span style={{ color: 'var(--text-muted)' }}>{keyPreview}</span>
                    </div>
                </div>

                {/* Step 1: Health */}
                <DemoStep
                    number={1}
                    title="health check"
                    description="verify the memwal server is running"
                    code={`// Check server health
const resp = await fetch("${serverUrl}/health")
const data = await resp.json()
console.log(data)
// → { status: "ok", version: "0.1.0" }`}
                    onRun={runHealth}
                    result={healthResult}
                    error={healthError}
                    loading={healthLoading}
                />

                {/* Step 2: Remember */}
                <div className="card" style={{ marginBottom: 24 }}>
                    <div className="card-header">
                        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                            <div
                                style={{
                                    width: 36,
                                    height: 36,
                                    borderRadius: '50%',
                                    background: 'var(--accent-subtle)',
                                    border: '1px solid var(--border-accent)',
                                    display: 'flex',
                                    alignItems: 'center',
                                    justifyContent: 'center',
                                    fontSize: '1rem',
                                    fontWeight: 700,
                                    color: 'var(--accent)',
                                    flexShrink: 0,
                                }}
                            >
                                2
                            </div>
                            <div>
                                <div className="card-title">remember</div>
                                <div className="card-subtitle">
                                    store a memory → embed → encrypt → Walrus
                                </div>
                            </div>
                        </div>
                        <button
                            className="btn btn-primary btn-sm"
                            onClick={runRemember}
                            disabled={rememberLoading}
                            style={{ minWidth: 80 }}
                        >
                            {rememberLoading ? (
                                <span
                                    className="spinner"
                                    style={{ width: 14, height: 14 }}
                                />
                            ) : (
                                '▶ run'
                            )}
                        </button>
                    </div>

                    {/* Input */}
                    <div className="input-group" style={{ marginBottom: 12 }}>
                        <label>memory text:</label>
                        <textarea
                            className="input"
                            rows={3}
                            value={rememberText}
                            onChange={(e) => setRememberText(e.target.value)}
                            style={{ resize: 'vertical' }}
                        />
                    </div>

                    <pre
                        style={{
                            background: 'var(--bg-input)',
                            border: '1px solid var(--border)',
                            borderRadius: 'var(--radius-md)',
                            padding: 16,
                            overflow: 'auto',
                            fontSize: '0.78rem',
                            lineHeight: 1.7,
                            fontFamily: 'var(--font-mono)',
                            color: 'var(--text-secondary)',
                            marginBottom: rememberResult || rememberError ? 12 : 0,
                        }}
                    >
                        <code>{`const memwal = memwal.create({
  key: "${keyPreview}",
  serverUrl: "${serverUrl}",
})

const result = await memwal.remember(
  "${rememberText.slice(0, 60)}..."
)
// → { id, blob_id, owner }`}</code>
                    </pre>

                    {rememberResult && (
                        <div
                            style={{
                                background: 'rgba(52, 211, 153, 0.06)',
                                border: '1px solid rgba(52, 211, 153, 0.2)',
                                borderRadius: 'var(--radius-md)',
                                padding: 16,
                            }}
                        >
                            <div
                                style={{
                                    fontSize: '0.7rem',
                                    color: 'var(--success)',
                                    letterSpacing: '0.08em',
                                    marginBottom: 8,
                                    fontWeight: 600,
                                }}
                            >
                                stored on Walrus (encrypted)
                            </div>
                            <pre
                                style={{
                                    fontSize: '0.78rem',
                                    lineHeight: 1.6,
                                    fontFamily: 'var(--font-mono)',
                                    color: 'var(--text-primary)',
                                    whiteSpace: 'pre-wrap',
                                    wordBreak: 'break-all',
                                    margin: 0,
                                }}
                            >
                                {rememberResult}
                            </pre>
                        </div>
                    )}
                    {rememberError && (
                        <div
                            style={{
                                background: 'rgba(248, 113, 113, 0.06)',
                                border: '1px solid rgba(248, 113, 113, 0.2)',
                                borderRadius: 'var(--radius-md)',
                                padding: 16,
                            }}
                        >
                            <div
                                style={{
                                    fontSize: '0.7rem',
                                    color: 'var(--danger)',
                                    letterSpacing: '0.08em',
                                    marginBottom: 8,
                                    fontWeight: 600,
                                }}
                            >
                                error
                            </div>
                            <pre
                                style={{
                                    fontSize: '0.78rem',
                                    fontFamily: 'var(--font-mono)',
                                    color: 'var(--danger)',
                                    whiteSpace: 'pre-wrap',
                                    margin: 0,
                                }}
                            >
                                {rememberError}
                            </pre>
                        </div>
                    )}
                </div>

                {/* Step 3: Recall */}
                <div className="card" style={{ marginBottom: 24 }}>
                    <div className="card-header">
                        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                            <div
                                style={{
                                    width: 36,
                                    height: 36,
                                    borderRadius: '50%',
                                    background: 'var(--accent-subtle)',
                                    border: '1px solid var(--border-accent)',
                                    display: 'flex',
                                    alignItems: 'center',
                                    justifyContent: 'center',
                                    fontSize: '1rem',
                                    fontWeight: 700,
                                    color: 'var(--accent)',
                                    flexShrink: 0,
                                }}
                            >
                                3
                            </div>
                            <div>
                                <div className="card-title">recall</div>
                                <div className="card-subtitle">
                                    semantic search → download → decrypt
                                </div>
                            </div>
                        </div>
                        <button
                            className="btn btn-primary btn-sm"
                            onClick={runRecall}
                            disabled={recallLoading}
                            style={{ minWidth: 80 }}
                        >
                            {recallLoading ? (
                                <span
                                    className="spinner"
                                    style={{ width: 14, height: 14 }}
                                />
                            ) : (
                                '▶ run'
                            )}
                        </button>
                    </div>

                    <div className="input-group" style={{ marginBottom: 12 }}>
                        <label>search query:</label>
                        <input
                            className="input"
                            value={recallQuery}
                            onChange={(e) => setRecallQuery(e.target.value)}
                        />
                    </div>

                    <pre
                        style={{
                            background: 'var(--bg-input)',
                            border: '1px solid var(--border)',
                            borderRadius: 'var(--radius-md)',
                            padding: 16,
                            overflow: 'auto',
                            fontSize: '0.78rem',
                            lineHeight: 1.7,
                            fontFamily: 'var(--font-mono)',
                            color: 'var(--text-secondary)',
                            marginBottom: recallResult || recallError ? 12 : 0,
                        }}
                    >
                        <code>{`const result = await memwal.recall("${recallQuery}")
// Server: embed query → cosine search → download blob → decrypt
// → { results: [{ text, blob_id, distance }], total }`}</code>
                    </pre>

                    {recallResult && (
                        <div
                            style={{
                                background: 'rgba(52, 211, 153, 0.06)',
                                border: '1px solid rgba(52, 211, 153, 0.2)',
                                borderRadius: 'var(--radius-md)',
                                padding: 16,
                            }}
                        >
                            <div
                                style={{
                                    fontSize: '0.7rem',
                                    color: 'var(--success)',
                                    letterSpacing: '0.08em',
                                    marginBottom: 8,
                                    fontWeight: 600,
                                }}
                            >
                                memories found (decrypted)
                            </div>
                            <pre
                                style={{
                                    fontSize: '0.78rem',
                                    lineHeight: 1.6,
                                    fontFamily: 'var(--font-mono)',
                                    color: 'var(--text-primary)',
                                    whiteSpace: 'pre-wrap',
                                    wordBreak: 'break-all',
                                    margin: 0,
                                }}
                            >
                                {recallResult}
                            </pre>
                        </div>
                    )}
                    {recallError && (
                        <div
                            style={{
                                background: 'rgba(248, 113, 113, 0.06)',
                                border: '1px solid rgba(248, 113, 113, 0.2)',
                                borderRadius: 'var(--radius-md)',
                                padding: 16,
                            }}
                        >
                            <div
                                style={{
                                    fontSize: '0.7rem',
                                    color: 'var(--danger)',
                                    letterSpacing: '0.08em',
                                    marginBottom: 8,
                                    fontWeight: 600,
                                }}
                            >
                                error
                            </div>
                            <pre
                                style={{
                                    fontSize: '0.78rem',
                                    fontFamily: 'var(--font-mono)',
                                    color: 'var(--danger)',
                                    whiteSpace: 'pre-wrap',
                                    margin: 0,
                                }}
                            >
                                {recallError}
                            </pre>
                        </div>
                    )}
                </div>

                {/* Step 4: Analyze */}
                <div className="card" style={{ marginBottom: 24 }}>
                    <div className="card-header">
                        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                            <div
                                style={{
                                    width: 36,
                                    height: 36,
                                    borderRadius: '50%',
                                    background: 'var(--accent-subtle)',
                                    border: '1px solid var(--border-accent)',
                                    display: 'flex',
                                    alignItems: 'center',
                                    justifyContent: 'center',
                                    fontSize: '1rem',
                                    fontWeight: 700,
                                    color: 'var(--accent)',
                                    flexShrink: 0,
                                }}
                            >
                                4
                            </div>
                            <div>
                                <div className="card-title">analyze</div>
                                <div className="card-subtitle">
                                    LLM extracts facts → stores each as memory
                                </div>
                            </div>
                        </div>
                        <button
                            className="btn btn-primary btn-sm"
                            onClick={runAnalyze}
                            disabled={analyzeLoading}
                            style={{ minWidth: 80 }}
                        >
                            {analyzeLoading ? (
                                <span
                                    className="spinner"
                                    style={{ width: 14, height: 14 }}
                                />
                            ) : (
                                '▶ run'
                            )}
                        </button>
                    </div>

                    <div className="input-group" style={{ marginBottom: 12 }}>
                        <label>conversation text to analyze:</label>
                        <textarea
                            className="input"
                            rows={3}
                            value={analyzeText}
                            onChange={(e) => setAnalyzeText(e.target.value)}
                            style={{ resize: 'vertical' }}
                        />
                    </div>

                    <pre
                        style={{
                            background: 'var(--bg-input)',
                            border: '1px solid var(--border)',
                            borderRadius: 'var(--radius-md)',
                            padding: 16,
                            overflow: 'auto',
                            fontSize: '0.78rem',
                            lineHeight: 1.7,
                            fontFamily: 'var(--font-mono)',
                            color: 'var(--text-secondary)',
                            marginBottom: analyzeResult || analyzeError ? 12 : 0,
                        }}
                    >
                        <code>{`const result = await memwal.analyze(
  "${analyzeText.slice(0, 50)}..."
)
// Server: LLM extracts facts → embed → encrypt → Walrus → store
// → { facts: [{ text, id, blob_id }], total, owner }`}</code>
                    </pre>

                    {analyzeResult && (
                        <div
                            style={{
                                background: 'rgba(52, 211, 153, 0.06)',
                                border: '1px solid rgba(52, 211, 153, 0.2)',
                                borderRadius: 'var(--radius-md)',
                                padding: 16,
                            }}
                        >
                            <div
                                style={{
                                    fontSize: '0.7rem',
                                    color: 'var(--success)',
                                    letterSpacing: '0.08em',
                                    marginBottom: 8,
                                    fontWeight: 600,
                                }}
                            >
                                facts extracted & stored
                            </div>
                            <pre
                                style={{
                                    fontSize: '0.78rem',
                                    lineHeight: 1.6,
                                    fontFamily: 'var(--font-mono)',
                                    color: 'var(--text-primary)',
                                    whiteSpace: 'pre-wrap',
                                    wordBreak: 'break-all',
                                    margin: 0,
                                }}
                            >
                                {analyzeResult}
                            </pre>
                        </div>
                    )}
                    {analyzeError && (
                        <div
                            style={{
                                background: 'rgba(248, 113, 113, 0.06)',
                                border: '1px solid rgba(248, 113, 113, 0.2)',
                                borderRadius: 'var(--radius-md)',
                                padding: 16,
                            }}
                        >
                            <div
                                style={{
                                    fontSize: '0.7rem',
                                    color: 'var(--danger)',
                                    letterSpacing: '0.08em',
                                    marginBottom: 8,
                                    fontWeight: 600,
                                }}
                            >
                                error
                            </div>
                            <pre
                                style={{
                                    fontSize: '0.78rem',
                                    fontFamily: 'var(--font-mono)',
                                    color: 'var(--danger)',
                                    whiteSpace: 'pre-wrap',
                                    margin: 0,
                                }}
                            >
                                {analyzeError}
                            </pre>
                        </div>
                    )}
                </div>

                {/* Step 5: Ask AI — true middleware pattern */}
                <div className="card" style={{ marginBottom: 24 }}>
                    <div className="card-header">
                        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                            <div
                                style={{
                                    width: 36,
                                    height: 36,
                                    borderRadius: '50%',
                                    background: 'linear-gradient(135deg, var(--accent-subtle), rgba(77, 162, 255, 0.15))',
                                    border: '1px solid var(--border-accent)',
                                    display: 'flex',
                                    alignItems: 'center',
                                    justifyContent: 'center',
                                    fontSize: '1rem',
                                    fontWeight: 700,
                                    color: 'var(--accent)',
                                    flexShrink: 0,
                                }}
                            >
                                5
                            </div>
                            <div>
                                <div className="card-title">ask AI (with memory)</div>
                                <div className="card-subtitle">
                                    your LLM key + memwal memory layer — like Supermemory
                                </div>
                            </div>
                        </div>
                        <button
                            className="btn btn-primary btn-sm"
                            onClick={runAsk}
                            disabled={askLoading || !askLlmKey.trim()}
                            style={{ minWidth: 80 }}
                        >
                            {askLoading ? (
                                <span className="spinner" style={{ width: 14, height: 14 }} />
                            ) : (
                                '▶ ask'
                            )}
                        </button>
                    </div>

                    {/* LLM API Key input */}
                    <div style={{
                        background: 'rgba(77, 162, 255, 0.04)',
                        border: '1px solid rgba(77, 162, 255, 0.15)',
                        borderRadius: 'var(--radius-md)',
                        padding: 16,
                        marginBottom: 12,
                    }}>
                        <div style={{
                            fontSize: '0.7rem',
                            color: 'var(--accent)',
                            letterSpacing: '0.08em',
                            marginBottom: 8,
                            fontWeight: 600,
                        }}>
                            your LLM API key (not stored, client-side only)
                        </div>
                        <div style={{ display: 'flex', gap: 8, marginBottom: 8 }}>
                            <select
                                className="input"
                                value={askLlmProvider}
                                onChange={(e) => setAskLlmProvider(e.target.value as any)}
                                style={{ width: 140, flexShrink: 0 }}
                            >
                                <option value="openai">OpenAI</option>
                                <option value="openrouter">OpenRouter</option>
                            </select>
                            <input
                                className="input"
                                type="password"
                                value={askLlmKey}
                                onChange={(e) => setAskLlmKey(e.target.value)}
                                placeholder={askLlmProvider === 'openai' ? 'sk-...' : 'sk-or-v1-...'}
                                style={{ flex: 1 }}
                            />
                        </div>
                        <div style={{ fontSize: '0.72rem', color: 'var(--text-muted)' }}>
                            memwal is just the memory layer. you bring your own LLM.
                        </div>
                    </div>

                    <div className="input-group" style={{ marginBottom: 12 }}>
                        <label>your question:</label>
                        <input
                            className="input"
                            value={askQuestion}
                            onChange={(e) => setAskQuestion(e.target.value)}
                            placeholder="ask anything about this user..."
                        />
                    </div>

                    <pre
                        style={{
                            background: 'var(--bg-input)',
                            border: '1px solid var(--border)',
                            borderRadius: 'var(--radius-md)',
                            padding: 16,
                            overflow: 'auto',
                            fontSize: '0.78rem',
                            lineHeight: 1.7,
                            fontFamily: 'var(--font-mono)',
                            color: 'var(--text-secondary)',
                            marginBottom: askResult || askError || askPhase ? 12 : 0,
                        }}
                    >
                        <code>{`import { withMemWal } from "@cmdoss/memwal-v2/ai"
import { openai } from "@ai-sdk/openai"
import { generateText } from "ai"

// wrap your model with memwal — that's it
const model = withMemWal(openai("gpt-4o-mini"), {
  key: delegateKeyHex,
  serverUrl: "https://your-memwal-server.com"
})

// use as normal — memwal handles memory automatically
const { text } = await generateText({
  model,
  prompt: "${askQuestion.slice(0, 50)}"
})
// → AI answers using your encrypted memories as context`}</code>
                    </pre>

                    {/* Loading phase */}
                    {askPhase && (
                        <div
                            style={{
                                display: 'flex',
                                alignItems: 'center',
                                gap: 10,
                                padding: '12px 16px',
                                background: 'rgba(77, 162, 255, 0.06)',
                                border: '1px solid rgba(77, 162, 255, 0.15)',
                                borderRadius: 'var(--radius-md)',
                                fontSize: '0.8rem',
                                color: 'var(--accent)',
                                marginBottom: 12,
                            }}
                        >
                            <span className="spinner" style={{ width: 14, height: 14 }} />
                            {askPhase}
                        </div>
                    )}

                    {askResult && (
                        <>
                            {/* AI Answer */}
                            <div
                                style={{
                                    background: 'linear-gradient(135deg, rgba(77, 162, 255, 0.08), rgba(52, 211, 153, 0.06))',
                                    border: '1px solid rgba(77, 162, 255, 0.2)',
                                    borderRadius: 'var(--radius-md)',
                                    padding: 20,
                                    marginBottom: 12,
                                }}
                            >
                                <div
                                    style={{
                                        fontSize: '0.7rem',
                                        color: 'var(--accent)',
                                        letterSpacing: '0.08em',
                                        marginBottom: 12,
                                        fontWeight: 600,
                                    }}
                                >
                                    AI response (your LLM + memwal memory)
                                </div>
                                <div
                                    style={{
                                        fontSize: '0.9rem',
                                        lineHeight: 1.7,
                                        color: 'var(--text-primary)',
                                        whiteSpace: 'pre-wrap',
                                    }}
                                >
                                    {askResult.answer}
                                </div>
                            </div>

                            {/* Memories Used */}
                            <div
                                style={{
                                    background: 'rgba(52, 211, 153, 0.06)',
                                    border: '1px solid rgba(52, 211, 153, 0.2)',
                                    borderRadius: 'var(--radius-md)',
                                    padding: 16,
                                    marginBottom: 12,
                                }}
                            >
                                <div
                                    style={{
                                        fontSize: '0.7rem',
                                        color: 'var(--success)',
                                        letterSpacing: '0.08em',
                                        marginBottom: 10,
                                        fontWeight: 600,
                                    }}
                                >
                                    {askResult.memories.length} memories injected as context
                                </div>
                                {askResult.memories.map((m: any, i: number) => (
                                    <div
                                        key={i}
                                        style={{
                                            display: 'flex',
                                            gap: 8,
                                            alignItems: 'baseline',
                                            marginBottom: 6,
                                            fontSize: '0.8rem',
                                            fontFamily: 'var(--font-mono)',
                                        }}
                                    >
                                        <span style={{ color: 'var(--success)', flexShrink: 0 }}>
                                            {((1 - m.distance) * 100).toFixed(0)}%
                                        </span>
                                        <span style={{ color: 'var(--text-secondary)' }}>
                                            {m.text}
                                        </span>
                                    </div>
                                ))}
                            </div>

                            {/* System Prompt Preview */}
                            <details style={{ marginBottom: 0 }}>
                                <summary style={{
                                    fontSize: '0.72rem',
                                    color: 'var(--text-muted)',
                                    cursor: 'pointer',
                                    marginBottom: 8,
                                }}>
                                    view system prompt sent to LLM
                                </summary>
                                <pre
                                    style={{
                                        fontSize: '0.72rem',
                                        lineHeight: 1.5,
                                        fontFamily: 'var(--font-mono)',
                                        color: 'var(--text-muted)',
                                        whiteSpace: 'pre-wrap',
                                        background: 'var(--bg-input)',
                                        border: '1px solid var(--border)',
                                        borderRadius: 'var(--radius-sm)',
                                        padding: 12,
                                        margin: 0,
                                    }}
                                >
                                    {askResult.systemPrompt}
                                </pre>
                            </details>
                        </>
                    )}
                    {askError && (
                        <div
                            style={{
                                background: 'rgba(248, 113, 113, 0.06)',
                                border: '1px solid rgba(248, 113, 113, 0.2)',
                                borderRadius: 'var(--radius-md)',
                                padding: 16,
                            }}
                        >
                            <div
                                style={{
                                    fontSize: '0.7rem',
                                    color: 'var(--danger)',
                                    letterSpacing: '0.08em',
                                    marginBottom: 8,
                                    fontWeight: 600,
                                }}
                            >
                                error
                            </div>
                            <pre
                                style={{
                                    fontSize: '0.78rem',
                                    fontFamily: 'var(--font-mono)',
                                    color: 'var(--danger)',
                                    whiteSpace: 'pre-wrap',
                                    margin: 0,
                                }}
                            >
                                {askError}
                            </pre>
                        </div>
                    )}
                </div>

                {/* Architecture overview */}
                <div className="card" style={{ marginBottom: 40 }}>
                    <div className="card-header">
                        <div>
                            <div className="card-title">architecture flow</div>
                        </div>
                    </div>
                    <pre
                        style={{
                            background: 'var(--bg-input)',
                            border: '1px solid var(--border)',
                            borderRadius: 'var(--radius-md)',
                            padding: 20,
                            overflow: 'auto',
                            fontSize: '0.75rem',
                            lineHeight: 1.8,
                            fontFamily: 'var(--font-mono)',
                            color: 'var(--text-secondary)',
                        }}
                    >
                        <code>{`┌──────────┐     Ed25519 signed request     ┌──────────────┐
│  Client  │ ──────────────────────────────▶ │  Rust Server │
│  (SDK)   │                                 │  (Axum)      │
└──────────┘                                 └──────┬───────┘
                                                    │
                                    ┌───────────────┼───────────────┐
                                    ▼               ▼               ▼
                              ┌──────────┐   ┌──────────┐   ┌──────────┐
                              │ Embed    │   │ Encrypt  │   │ Walrus   │
                              │(OpenAI)  │   │(AES-256) │   │ (Store)  │
                              └────┬─────┘   └────┬─────┘   └────┬─────┘
                                   │              │              │
                                   ▼              │              │
                              ┌──────────┐        │              │
                              │ Vector   │◀───────┘              │
                              │ DB       │◀──────────────────────┘
                              │ (SQLite) │   blob_id + enc_key
                              └──────────┘

  remember: text → embed → encrypt → Walrus upload → store vector
  recall:   query → embed → cosine search → download → decrypt
  analyze:  text → LLM extract facts → remember each fact
  ask:      question → recall memories → inject context → LLM answer`}</code>
                    </pre>
                </div>
            </div>
        </>
    )
}
