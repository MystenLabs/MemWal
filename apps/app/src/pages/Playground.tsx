/**
 * Playground — Interactive Demo Showcase
 *
 * Shows code for each memwal SDK operation, with a "Run" button
 * that executes the call against a live server using the real SDK.
 */

import { useState, useCallback, useMemo, type ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { LogOut } from 'lucide-react'
import {
    useCurrentAccount,
    useDisconnectWallet,
    useSignPersonalMessage,
    useSuiClient,
} from '@mysten/dapp-kit'
import { useSponsoredTransaction } from '../hooks/useSponsoredTransaction'
import { MemWal } from '@mysten/memwal'
import { MemWalManual } from '@mysten/memwal/manual'
import { useDelegateKey } from '../App'
import { config } from '../config'
import memwalLogo from '../assets/memwal-logo.svg'

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
    const { delegateKey, clearDelegateKeys, accountObjectId } = useDelegateKey()

    const address = currentAccount?.address || ''
    const serverUrl = config.memwalServerUrl
    const keyPreview = delegateKey
        ? `${delegateKey.slice(0, 8)}...${delegateKey.slice(-8)}`
        : '...'

    // Wallet signing hooks (for full client-side mode)
    const { mutateAsync: signAndExecuteTransaction } = useSponsoredTransaction()
    const { mutateAsync: signPersonalMessage } = useSignPersonalMessage()
    const suiClient = useSuiClient()

    // ============================================================
    // SDK Instance — created from delegate key
    // ============================================================

    const [namespace, setNamespace] = useState('default')

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

    const [analyzeText, setAnalyzeText] = useState(
        "I prefer dark mode in all my apps. My favorite programming language is Rust. I'm allergic to shellfish.",
    )
    const [analyzeResult, setAnalyzeResult] = useState<string | null>(null)
    const [analyzeError, setAnalyzeError] = useState<string | null>(null)
    const [analyzeLoading, setAnalyzeLoading] = useState(false)

    const [askQuestion, setAskQuestion] = useState('What do you know about me?')
    const [askLlmKey, setAskLlmKey] = useState('')
    const [askLlmProvider, setAskLlmProvider] = useState<'openai' | 'openrouter'>('openai')
    const [askResult, setAskResult] = useState<{ answer: string; memories: { text: string; distance: number; blob_id?: string }[]; systemPrompt: string } | null>(null)
    const [askError, setAskError] = useState<string | null>(null)
    const [askLoading, setAskLoading] = useState(false)
    const [askPhase, setAskPhase] = useState('')

    // Full client-side mode states
    const [fullRememberText, setFullRememberText] = useState(
        "I enjoy hiking in the mountains on weekends and my favorite trail is in Dalat."
    )
    const [fullRememberResult, setFullRememberResult] = useState<string | null>(null)
    const [fullRememberError, setFullRememberError] = useState<string | null>(null)
    const [fullRememberLoading, setFullRememberLoading] = useState(false)
    const [fullRememberPhase, setFullRememberPhase] = useState('')

    const [fullRecallQuery, setFullRecallQuery] = useState('outdoor activities')
    const [fullRecallResult, setFullRecallResult] = useState<string | null>(null)
    const [fullRecallError, setFullRecallError] = useState<string | null>(null)
    const [fullRecallLoading, setFullRecallLoading] = useState(false)
    const [fullRecallPhase, setFullRecallPhase] = useState('')

    const [restoreResult, setRestoreResult] = useState<string | null>(null)
    const [restoreError, setRestoreError] = useState<string | null>(null)
    const [restoreLoading, setRestoreLoading] = useState(false)


    const handleLogout = useCallback(async () => {
        clearDelegateKeys()
        await disconnect()
    }, [clearDelegateKeys, disconnect])

    // ---- Handlers (using SDK) ----

    const runHealth = useCallback(async () => {
        if (!memwal) return
        setHealthLoading(true)
        setHealthResult(null)
        setHealthError(null)
        try {
            const data = await memwal.health()
            setHealthResult(JSON.stringify(data, null, 2))
        } catch (err: unknown) {
            setHealthError(err instanceof Error ? err.message : String(err))
        } finally {
            setHealthLoading(false)
        }
    }, [memwal])

    const runRemember = useCallback(async () => {
        if (!memwal) return
        setRememberLoading(true)
        setRememberResult(null)
        setRememberError(null)
        try {
            const data = await memwal.remember(rememberText)
            setRememberResult(JSON.stringify(data, null, 2))
        } catch (err: unknown) {
            setRememberError(err instanceof Error ? err.message : String(err))
        } finally {
            setRememberLoading(false)
        }
    }, [memwal, rememberText])

    const runRecall = useCallback(async () => {
        if (!memwal) return
        setRecallLoading(true)
        setRecallResult(null)
        setRecallError(null)
        try {
            const data = await memwal.recall(recallQuery, 5)
            setRecallResult(JSON.stringify(data, null, 2))
        } catch (err: unknown) {
            setRecallError(err instanceof Error ? err.message : String(err))
        } finally {
            setRecallLoading(false)
        }
    }, [memwal, recallQuery])

    const runAnalyze = useCallback(async () => {
        if (!memwal) return
        setAnalyzeLoading(true)
        setAnalyzeResult(null)
        setAnalyzeError(null)
        try {
            const data = await memwal.analyze(analyzeText)
            setAnalyzeResult(JSON.stringify(data, null, 2))
        } catch (err: unknown) {
            setAnalyzeError(err instanceof Error ? err.message : String(err))
        } finally {
            setAnalyzeLoading(false)
        }
    }, [memwal, analyzeText])

    const runRestore = useCallback(async () => {
        if (!memwal) return
        setRestoreLoading(true)
        setRestoreResult(null)
        setRestoreError(null)
        try {
            const data = await memwal.restore(namespace || 'default')
            setRestoreResult(JSON.stringify(data, null, 2))
        } catch (err: unknown) {
            setRestoreError(err instanceof Error ? err.message : String(err))
        } finally {
            setRestoreLoading(false)
        }
    }, [memwal, namespace])

    const runAsk = useCallback(async () => {
        if (!memwal) return
        if (!askLlmKey.trim()) {
            setAskError('Please enter your LLM API key (OpenAI or OpenRouter)')
            return
        }
        setAskLoading(true)
        setAskResult(null)
        setAskError(null)

        try {
            // Phase 1: Recall memories using SDK
            setAskPhase('step 1/3 — recalling memories from memwal...')
            const recallData = await memwal.recall(askQuestion, 5)
            const memories = recallData.results || []

            // Phase 2: Build prompt with memory context
            setAskPhase(`step 2/3 — injecting ${memories.length} memories into prompt...`)
            const memoryContext = memories.length > 0
                ? `The following are known facts about this user (from encrypted Walrus storage):\n${memories.map((m) => `- ${m.text} (relevance: ${(((1 - m.distance) * 100)).toFixed(0)}%)`).join('\n')}`
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
        } catch (err: unknown) {
            setAskPhase('')
            setAskError(err instanceof Error ? err.message : String(err))
        } finally {
            setAskLoading(false)
        }
    }, [memwal, askQuestion, askLlmKey, askLlmProvider])

    // ---- Full Client-Side Mode (MemWalManual) ----

    const memwalManual = useMemo(() => {
        if (!delegateKey || !address || !askLlmKey.trim()) return null
        try {
            const embeddingApiBase = askLlmProvider === 'openrouter'
                ? 'https://openrouter.ai/api/v1'
                : 'https://api.openai.com/v1'
            return MemWalManual.create({
                key: delegateKey,
                serverUrl,
                walletSigner: {
                    address,
                    signAndExecuteTransaction: (input) => signAndExecuteTransaction({ transaction: input.transaction }),
                    signPersonalMessage: (input) => signPersonalMessage({ message: input.message }),
                },
                suiClient,
                embeddingApiKey: askLlmKey.trim(),
                embeddingApiBase,
                packageId: config.memwalPackageId,
                accountId: accountObjectId || '',
                suiNetwork: config.suiNetwork,
                ...(config.sealKeyServers.length > 0 ? { sealKeyServers: [...config.sealKeyServers] } : {}),
            })
        } catch {
            return null
        }
    }, [delegateKey, serverUrl, address, signAndExecuteTransaction, signPersonalMessage, suiClient, askLlmKey, askLlmProvider])

    const runFullRemember = useCallback(async () => {
        if (!memwalManual) return
        setFullRememberLoading(true)
        setFullRememberResult(null)
        setFullRememberError(null)
        try {
            setFullRememberPhase('step 1/3 — embedding text...')
            // SDK handles: embed → SEAL encrypt → Walrus upload → register
            const data = await memwalManual.rememberManual(fullRememberText)
            setFullRememberPhase('')
            setFullRememberResult(JSON.stringify(data, null, 2))
        } catch (err: unknown) {
            setFullRememberPhase('')
            setFullRememberError(err instanceof Error ? err.message : String(err))
        } finally {
            setFullRememberLoading(false)
        }
    }, [memwalManual, fullRememberText])

    const runFullRecall = useCallback(async () => {
        if (!memwalManual) return
        setFullRecallLoading(true)
        setFullRecallResult(null)
        setFullRecallError(null)
        try {
            setFullRecallPhase('embed → search → Walrus download → SEAL decrypt (wallet popup)...')
            const data = await memwalManual.recallManual(fullRecallQuery, 5)

            setFullRecallPhase('')
            setFullRecallResult(JSON.stringify(data, null, 2))
        } catch (err: unknown) {
            setFullRecallPhase('')
            setFullRecallError(err instanceof Error ? err.message : String(err))
        } finally {
            setFullRecallLoading(false)
        }
    }, [memwalManual, fullRecallQuery])



    // ---- Render ----

    return (
        <>
            <nav className="nav">
                <div className="nav-inner">
                    <div className="nav-brand">
                        <img src={memwalLogo} alt="MemWal" style={{ height: 22 }} />
                    </div>
                    <div className="nav-user">
                        <Link to="/" className="demo-nav-back">
                            ← Dashboard
                        </Link>
                        <span className="nav-address">
                            {address.slice(0, 6)}...{address.slice(-4)}
                        </span>
                        <button
                            className="lp-nav-cta"
                            onClick={handleLogout}
                        >
                            <LogOut size={14} /> sign out
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
                        <strong>▶ run</strong> to execute against your server
                        using <code>@mysten/memwal</code>.
                    </p>
                </div>

                {/* Server info */}
                <div className="demo-server-info">
                    <div className="demo-server-tag">
                        server: <span className="demo-tag-value demo-tag-value--server">{serverUrl}</span>
                    </div>
                    <div className="demo-server-tag">
                        key: <span className="demo-tag-value demo-tag-value--key">{keyPreview}</span>
                    </div>
                    <div className="demo-server-tag">
                        SDK: <span className="demo-tag-value demo-tag-value--sdk">@mysten/memwal</span>
                    </div>
                    <div className="demo-server-tag" style={{ padding: 0, display: 'flex', alignItems: 'center' }}>
                        <span style={{ padding: '8px 0 8px 16px', whiteSpace: 'nowrap' }}>namespace:</span>
                        <input
                            value={namespace}
                            onChange={(e) => setNamespace(e.target.value)}
                            placeholder="default"
                            size={Math.max(namespace.length, 7)}
                            style={{ padding: '8px 12px 8px 6px', fontSize: '0.8rem', fontFamily: 'var(--font-mono)', background: 'transparent', border: 'none', outline: 'none', color: 'var(--text-primary)', fontWeight: 600, width: 'auto', minWidth: 0 }}
                        />
                    </div>
                </div>

                {/* Step 1: Health */}
                <DemoStep
                    number={1}
                    title="health check"
                    description="verify the memwal server is running"
                    code={`import { MemWal } from "@mysten/memwal"

const memwal = MemWal.create({
  key: "${keyPreview}",
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
                />

                {/* Step 2: Remember */}
                <DemoStep
                    number={2}
                    title="remember"
                    description="store a memory → embed → encrypt → Walrus"
                    code={`const result = await memwal.remember(
  "${rememberText.slice(0, 60)}..."
)
// namespace: "${namespace || 'default'}"
// → { id, blob_id, owner, namespace }`}
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
                    code={`const result = await memwal.recall("${recallQuery}", 5)
// Server: embed query → cosine search → download → decrypt
// namespace: "${namespace || 'default'}" — only searches within this namespace
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

                {/* Step 5: Restore */}
                <DemoStep
                    number={5}
                    title="restore"
                    description="re-index all memories from Walrus → rebuild local DB (supports zero-state restore from chain)"
                    code={`// Restore from Walrus: download → decrypt → re-embed → re-index
// If DB is empty, queries Sui chain for user's Walrus Blob objects
// with memwal_namespace metadata → zero-state restore!
const result = await memwal.restore("${namespace || 'default'}")
// → { restored: N, namespace, owner }`}
                    onRun={runRestore}
                    result={restoreResult}
                    resultLabel="restore result"
                    error={restoreError}
                    loading={restoreLoading}
                    highlight
                />

                {/* Step 5: Configure LLM API Key */}
                <div className="card demo-step">
                    <div className="card-header">
                        <div className="demo-step-header-row">
                            <div className={`demo-step-badge${askLlmKey.trim() ? ' demo-step-badge--highlight' : ''}`}>6</div>
                            <div>
                                <div className="card-title">configure your LLM</div>
                                <div className="card-subtitle">
                                    memwal is just the memory layer — you bring your own LLM
                                </div>
                            </div>
                        </div>
                        {askLlmKey.trim() && (
                            <span style={{ fontSize: '0.78rem', color: 'var(--success)', fontWeight: 500 }}>
                                ✓ ready
                            </span>
                        )}
                    </div>

                    <div className="demo-info-panel">
                        <div className="demo-info-label">
                            your LLM API key (not stored, client-side only)
                        </div>
                        <div style={{ display: 'flex', gap: 8, marginBottom: 8 }}>
                            <select
                                className="input"
                                value={askLlmProvider}
                                onChange={(e) => setAskLlmProvider(e.target.value as 'openai' | 'openrouter')}
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
                            required for steps 7–9. your key stays in this browser tab — never sent to memwal.
                        </div>
                    </div>

                    <pre className="demo-code-block">
                        <code>{`// memwal doesn't include an LLM — you choose your own.
// steps 7–9 use this key for:
//   • ask AI: recalls memories → injects into your LLM prompt
//   • full client-side: embeds text via your OpenAI / OpenRouter key
//
// your key is never sent to memwal servers.`}</code>
                    </pre>
                </div>

                {/* Step 6: Ask AI — true middleware pattern */}
                <div className="card demo-step" style={{ opacity: askLlmKey.trim() ? 1 : 0.72, pointerEvents: askLlmKey.trim() ? 'auto' : 'none' }}>
                    <div className="card-header">
                        <div className="demo-step-header-row">
                            <div className="demo-step-badge demo-step-badge--highlight">7</div>
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
                        <code>{`import { withMemWal } from "@mysten/memwal/ai"
import { openai } from "@ai-sdk/openai"
import { generateText } from "ai"

// wrap your model with memwal — that's it
const model = withMemWal(openai("gpt-4o-mini"), {
  key: delegateKeyHex,
  accountId: "0x...",
  serverUrl: "${serverUrl}"
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
                                {askResult.memories.map((m, i) => (
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



                {/* Divider — Manual / Hybrid mode */}
                <div style={{ margin: '40px 0 32px', textAlign: 'center' }}>
                    <hr style={{ border: 'none', borderTop: '2px dashed var(--border-light)', margin: '0 0 16px' }} />
                    <div style={{ fontSize: '0.82rem', color: 'var(--text-muted)', lineHeight: 1.6 }}>
                        <strong style={{ color: 'var(--text-primary)' }}>manual mode</strong> — client handles embedding & encryption, server handles storage.
                        <br />
                        your data never leaves your browser unencrypted. requires an LLM API key (step 6).
                    </div>
                </div>

                {/* Step 7: Remember (full client-side) */}
                <div className="card demo-step" style={{ opacity: askLlmKey.trim() ? 1 : 0.72, pointerEvents: askLlmKey.trim() ? 'auto' : 'none' }}>
                    <div className="card-header">
                        <div className="demo-step-header-row">
                            <div className="demo-step-badge demo-step-badge--highlight">8</div>
                            <div>
                                <div className="card-title">remember (hybrid)</div>
                                <div className="card-subtitle">
                                    client: embed → SEAL encrypt → send to server → server uploads Walrus
                                </div>
                            </div>
                        </div>
                        <button
                            className="btn btn-primary btn-sm"
                            onClick={runFullRemember}
                            disabled={fullRememberLoading || !memwalManual}
                            style={{ minWidth: 80 }}
                        >
                            {fullRememberLoading ? (
                                <span className="spinner" style={{ width: 14, height: 14 }} />
                            ) : (
                                '▶ run'
                            )}
                        </button>
                    </div>

                    <div className="input-group" style={{ marginBottom: 12 }}>
                        <label>memory text:</label>
                        <textarea
                            className="input"
                            rows={2}
                            value={fullRememberText}
                            onChange={(e) => setFullRememberText(e.target.value)}
                            style={{ resize: 'vertical' }}
                        />
                    </div>

                    <pre className={`demo-code-block${fullRememberResult || fullRememberError || fullRememberPhase ? ' demo-code-block--spaced' : ''}`}>
                        <code>{`import { MemWalManual } from "@mysten/memwal/manual"

const memwal = MemWalManual.create({
  key: delegateKeyHex,
  walletSigner: {           // uses connected wallet!
    address,                // from useCurrentAccount()
    signAndExecuteTransaction,
    signPersonalMessage,
  },
  embeddingApiKey: "sk-or-v1-...",
  embeddingApiBase: "https://openrouter.ai/api/v1",
  packageId: "${config.memwalPackageId.slice(0, 10)}...",
  accountId: "${(accountObjectId || '').slice(0, 10)}...",
})

// client does:
// 1. embed text (via your OpenAI / OpenRouter key)
// 2. SEAL encrypt (wallet signs)
// server then:
// 3. upload encrypted bytes to Walrus (server pays gas)
// 4. store vector + blob_id in DB
await memwal.rememberManual("${fullRememberText.slice(0, 40)}...")`}</code>
                    </pre>

                    {fullRememberPhase && (
                        <div className="demo-phase-indicator">
                            <span className="spinner" style={{ width: 14, height: 14 }} />
                            {fullRememberPhase}
                        </div>
                    )}

                    {fullRememberResult && (
                        <div className="demo-result-panel">
                            <div className="demo-result-label">stored — encrypted by client, uploaded to Walrus by server</div>
                            <pre className="demo-result-pre">{fullRememberResult}</pre>
                        </div>
                    )}
                    {fullRememberError && (
                        <div className="demo-error-panel">
                            <div className="demo-error-label">error</div>
                            <pre className="demo-error-pre">{fullRememberError}</pre>
                        </div>
                    )}
                </div>

                {/* Step 8: Recall (full client-side) */}
                <div className="card demo-step" style={{ opacity: askLlmKey.trim() ? 1 : 0.72, pointerEvents: askLlmKey.trim() ? 'auto' : 'none' }}>
                    <div className="card-header">
                        <div className="demo-step-header-row">
                            <div className="demo-step-badge demo-step-badge--highlight">9</div>
                            <div>
                                <div className="card-title">recall (full client-side)</div>
                                <div className="card-subtitle">
                                    SDK: embed query → search → Walrus download → SEAL decrypt
                                </div>
                            </div>
                        </div>
                        <button
                            className="btn btn-primary btn-sm"
                            onClick={runFullRecall}
                            disabled={fullRecallLoading || !memwalManual}
                            style={{ minWidth: 80 }}
                        >
                            {fullRecallLoading ? (
                                <span className="spinner" style={{ width: 14, height: 14 }} />
                            ) : (
                                '▶ run'
                            )}
                        </button>
                    </div>

                    <div className="input-group" style={{ marginBottom: 12 }}>
                        <label>search query:</label>
                        <input
                            className="input"
                            value={fullRecallQuery}
                            onChange={(e) => setFullRecallQuery(e.target.value)}
                        />
                    </div>

                    <pre className={`demo-code-block${fullRecallResult || fullRecallError || fullRecallPhase ? ' demo-code-block--spaced' : ''}`}>
                        <code>{`// client does:
//   1. embed query via OpenAI
//   2. SEAL decrypt each result (wallet popup)
// server then:
//   3. cosine search for matching vectors
//   4. download encrypted blobs from Walrus
//   5. return encrypted results to client
const result = await memwal.recallManual("${fullRecallQuery}", 5)
// → { results: [{ blob_id, text, distance }], total }`}</code>
                    </pre>

                    {fullRecallPhase && (
                        <div className="demo-phase-indicator">
                            <span className="spinner" style={{ width: 14, height: 14 }} />
                            {fullRecallPhase}
                        </div>
                    )}

                    {fullRecallResult && (
                        <div className="demo-result-panel">
                            <div className="demo-result-label">memories found (downloaded + decrypted client-side)</div>
                            <pre className="demo-result-pre">{fullRecallResult}</pre>
                        </div>
                    )}
                    {fullRecallError && (
                        <div className="demo-error-panel">
                            <div className="demo-error-label">error</div>
                            <pre className="demo-error-pre">{fullRecallError}</pre>
                        </div>
                    )}
                </div>


            </div>
        </>
    )
}
