/**
 * Playground — Interactive Demo Showcase
 *
 * Shows code for each memwal SDK operation, with a "Run" button
 * that executes the call against a live server.
 */

import { useState, useCallback, type ReactNode } from 'react'
import {
    useCurrentAccount,
    useDisconnectWallet,
} from '@mysten/dapp-kit'
import { useDelegateKey } from '../App'
import { config } from '../config'
import { apiCall } from '../utils/api'

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
    highlight?: boolean
    children?: ReactNode
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
    highlight,
    children,
}: DemoStepProps) {
    const hasOutput = result || error
    return (
        <div className="card demo-step">
            <div className="card-header">
                <div className="demo-step-header-row">
                    <div className={`demo-step-badge${highlight ? ' demo-step-badge--highlight' : ''}`}>
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

            {/* Optional inputs (injected via children) */}
            {children}

            {/* Code block */}
            <pre className={`demo-code-block${hasOutput ? ' demo-code-block--spaced' : ''}`}>
                <code>{code}</code>
            </pre>

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
                    <div className="demo-error-label">error</div>
                    <pre className="demo-error-pre">{error}</pre>
                </div>
            )}
        </div>
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

    // ---- Handlers ----

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
            // Phase 1: Recall memories
            setAskPhase('step 1/3 — recalling memories from memwal...')
            const recallData = await apiCall(delegateKey, serverUrl, '/api/recall', {
                query: askQuestion,
                limit: 5,
            }, accountObjectId || undefined)

            const memories = recallData.results || []

            // Phase 2: Build prompt with memory context
            setAskPhase(`step 2/3 — injecting ${memories.length} memories into prompt...`)
            const memoryContext = memories.length > 0
                ? `The following are known facts about this user (from encrypted Walrus storage):\n${memories.map((m: any) => `- ${m.text} (relevance: ${(((1 - m.distance) * 100)).toFixed(0)}%)`).join('\n')}`
                : 'No memories found for this user yet.'

            const systemPrompt = `You are a helpful AI assistant. The user has a personal memory store powered by memwal (encrypted, stored on Walrus blockchain).\n\n${memoryContext}\n\nUse the above context to provide personalized answers. If the memories don't contain relevant information, say so honestly.`

            // Phase 3: Call user's own LLM
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

    // ---- Render ----

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
                            className="demo-nav-back"
                            onClick={(e) => {
                                e.preventDefault()
                                window.location.hash = ''
                                window.location.reload()
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
                <div className="demo-server-info">
                    <div className="demo-server-tag">
                        server: <span style={{ color: 'var(--accent)' }}>{serverUrl}</span>
                    </div>
                    <div className="demo-server-tag">
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
                <DemoStep
                    number={2}
                    title="remember"
                    description="store a memory → embed → encrypt → Walrus"
                    code={`const memwal = memwal.create({
  key: "${keyPreview}",
  serverUrl: "${serverUrl}",
})

const result = await memwal.remember(
  "${rememberText.slice(0, 60)}..."
)
// → { id, blob_id, owner }`}
                    onRun={runRemember}
                    result={rememberResult}
                    resultLabel="stored on Walrus (encrypted)"
                    error={rememberError}
                    loading={rememberLoading}
                >
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
                </DemoStep>

                {/* Step 3: Recall */}
                <DemoStep
                    number={3}
                    title="recall"
                    description="semantic search → download → decrypt"
                    code={`const result = await memwal.recall("${recallQuery}")
// Server: embed query → cosine search → download blob → decrypt
// → { results: [{ text, blob_id, distance }], total }`}
                    onRun={runRecall}
                    result={recallResult}
                    resultLabel="memories found (decrypted)"
                    error={recallError}
                    loading={recallLoading}
                >
                    <div className="input-group" style={{ marginBottom: 12 }}>
                        <label>search query:</label>
                        <input
                            className="input"
                            value={recallQuery}
                            onChange={(e) => setRecallQuery(e.target.value)}
                        />
                    </div>
                </DemoStep>

                {/* Step 4: Analyze */}
                <DemoStep
                    number={4}
                    title="analyze"
                    description="LLM extracts facts → stores each as memory"
                    code={`const result = await memwal.analyze(
  "${analyzeText.slice(0, 50)}..."
)
// Server: LLM extracts facts → embed → encrypt → Walrus → store
// → { facts: [{ text, id, blob_id }], total, owner }`}
                    onRun={runAnalyze}
                    result={analyzeResult}
                    resultLabel="facts extracted & stored"
                    error={analyzeError}
                    loading={analyzeLoading}
                >
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
                </DemoStep>

                {/* Step 5: Ask AI — true middleware pattern */}
                <div className="card demo-step">
                    <div className="card-header">
                        <div className="demo-step-header-row">
                            <div className="demo-step-badge demo-step-badge--highlight">5</div>
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
                    <div className="demo-info-panel">
                        <div className="demo-info-label">
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

                    <pre className={`demo-code-block${askResult || askError || askPhase ? ' demo-code-block--spaced' : ''}`}>
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
                        <div className="demo-phase-indicator">
                            <span className="spinner" style={{ width: 14, height: 14 }} />
                            {askPhase}
                        </div>
                    )}

                    {askResult && (
                        <>
                            {/* AI Answer */}
                            <div className="demo-ai-panel">
                                <div className="demo-info-label" style={{ marginBottom: 12 }}>
                                    AI response (your LLM + memwal memory)
                                </div>
                                <div className="demo-ai-answer">
                                    {askResult.answer}
                                </div>
                            </div>

                            {/* Memories Used */}
                            <div className="demo-result-panel" style={{ marginBottom: 12 }}>
                                <div className="demo-result-label" style={{ marginBottom: 10 }}>
                                    {askResult.memories.length} memories injected as context
                                </div>
                                {askResult.memories.map((m: any, i: number) => (
                                    <div key={i} className="demo-memory-item">
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
                            <details>
                                <summary style={{
                                    fontSize: '0.72rem',
                                    color: 'var(--text-muted)',
                                    cursor: 'pointer',
                                    marginBottom: 8,
                                }}>
                                    view system prompt sent to LLM
                                </summary>
                                <pre className="demo-code-block" style={{ fontSize: '0.72rem', lineHeight: 1.5, color: 'var(--text-muted)' }}>
                                    {askResult.systemPrompt}
                                </pre>
                            </details>
                        </>
                    )}
                    {askError && (
                        <div className="demo-error-panel">
                            <div className="demo-error-label">error</div>
                            <pre className="demo-error-pre">{askError}</pre>
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
                    <pre className="demo-code-block" style={{ padding: 20, fontSize: '0.75rem', lineHeight: 1.8 }}>
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
