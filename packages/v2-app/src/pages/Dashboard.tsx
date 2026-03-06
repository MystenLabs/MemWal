/**
 * Dashboard — Account info, delegate keys, SDK integration guide
 */

import { useState, useCallback } from 'react'
import {
    useCurrentAccount,
    useDisconnectWallet,
} from '@mysten/dapp-kit'
import { useDelegateKey } from '../App'
import { config } from '../config'

export default function Dashboard() {
    const currentAccount = useCurrentAccount()
    const { mutateAsync: disconnect } = useDisconnectWallet()
    const { delegateKey, delegatePublicKey, clearDelegateKeys } = useDelegateKey()

    const address = currentAccount?.address || ''
    const [showKey, setShowKey] = useState(false)
    const [copied, setCopied] = useState<string | null>(null)

    const copyToClipboard = useCallback(async (text: string, label: string) => {
        await navigator.clipboard.writeText(text)
        setCopied(label)
        setTimeout(() => setCopied(null), 2000)
    }, [])

    const handleLogout = useCallback(async () => {
        clearDelegateKeys()
        await disconnect()
    }, [clearDelegateKeys, disconnect])

    const sdkSnippet = `import { MemWal } from "@cmdoss/memwal-v2"

const memwal = MemWal.create({
  key: "${delegateKey?.slice(0, 8)}...${delegateKey?.slice(-8)}",
  serverUrl: "${config.memwalServerUrl}",
})

// Remember something
await memwal.remember("I'm allergic to peanuts")

// Recall memories
const result = await memwal.recall("food allergies")
console.log(result.results[0].text)`

    const aiSnippet = `import { generateText } from "ai"
import { withMemWal } from "@cmdoss/memwal-v2/ai"
import { openai } from "@ai-sdk/openai"

const model = withMemWal(openai("gpt-4o"), {
  key: "${delegateKey?.slice(0, 8)}...${delegateKey?.slice(-8)}",
  serverUrl: "${config.memwalServerUrl}",
})

const result = await generateText({
  model,
  messages: [
    { role: "user", content: "What foods should I avoid?" }
  ]
})
// → LLM knows: "User is allergic to peanuts"`

    return (
        <>
            <nav className="nav">
                <div className="nav-inner">
                    <div className="nav-brand">
                        <span>memwal</span>
                    </div>
                    <div className="nav-user">
                        <span className="nav-address">
                            {address.slice(0, 6)}...{address.slice(-4)}
                        </span>
                        <button className="btn btn-secondary btn-sm" onClick={handleLogout}>
                            sign out
                        </button>
                    </div>
                </div>
            </nav>

            <div className="container dashboard">
                {/* Header */}
                <div className="dashboard-header">
                    <h2>dashboard</h2>
                    <p>manage your memwal account and delegate keys</p>
                </div>

                {/* Try Demo CTA */}
                <a href="#playground" style={{
                    display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                    background: 'linear-gradient(135deg, rgba(124,58,237,0.15), rgba(139,92,246,0.08))',
                    border: '1px solid var(--border-accent)',
                    borderRadius: 'var(--radius-lg)', padding: '16px 24px',
                    marginBottom: 24, textDecoration: 'none', cursor: 'pointer',
                    transition: 'all 0.2s ease',
                }}>
                    <div>
                        <div style={{ fontSize: '1rem', fontWeight: 600, color: 'var(--text-primary)', marginBottom: 4 }}>
                            try interactive demo
                        </div>
                        <div style={{ fontSize: '0.8rem', color: 'var(--text-secondary)' }}>
                            test remember, recall & analyze with your live server
                        </div>
                    </div>
                    <div style={{ color: 'var(--accent)', fontSize: '1.2rem' }}>→</div>
                </a>

                {/* Stats */}
                <div className="dashboard-grid">
                    <div className="stat-card">
                        <div className="stat-label">account address</div>
                        <div className="stat-value mono">{address}</div>
                    </div>
                    <div className="stat-card">
                        <div className="stat-label">network</div>
                        <div className="stat-value" style={{ textTransform: 'capitalize' }}>
                            Sui {config.suiNetwork}
                        </div>
                    </div>
                </div>

                {/* Delegate Key */}
                <div className="card" style={{ marginBottom: 24 }}>
                    <div className="card-header">
                        <div>
                            <div className="card-title">delegate key</div>
                            <div className="card-subtitle">your Ed25519 key for SDK authentication</div>
                        </div>
                    </div>

                    {/* Public Key */}
                    <div className="key-display" style={{ marginBottom: 12 }}>
                        <div className="key-label" style={{ color: 'var(--text-muted)' }}>public key</div>
                        <div className="key-value" style={{ color: 'var(--text-secondary)' }}>
                            {delegatePublicKey}
                        </div>
                        <div className="key-actions">
                            <button
                                className="btn btn-secondary btn-sm"
                                onClick={() => copyToClipboard(delegatePublicKey!, 'pub')}
                            >
                                {copied === 'pub' ? 'copied!' : 'copy'}
                            </button>
                        </div>
                    </div>

                    {/* Private Key */}
                    <div className="key-display">
                        <div className="key-label">private key</div>
                        {showKey ? (
                            <>
                                <div className="key-value">{delegateKey}</div>
                                <div className="key-actions">
                                    <button
                                        className="btn btn-secondary btn-sm"
                                        onClick={() => copyToClipboard(delegateKey!, 'priv')}
                                    >
                                        {copied === 'priv' ? 'copied!' : 'copy'}
                                    </button>
                                    <button className="btn btn-secondary btn-sm" onClick={() => setShowKey(false)}>
                                        hide
                                    </button>
                                </div>
                            </>
                        ) : (
                            <>
                                <div className="key-value" style={{ color: 'var(--text-muted)' }}>
                                    {'•'.repeat(64)}
                                </div>
                                <div className="key-actions">
                                    <button className="btn btn-secondary btn-sm" onClick={() => setShowKey(true)}>
                                        reveal
                                    </button>
                                </div>
                            </>
                        )}
                    </div>
                </div>

                {/* Quick Start: SDK */}
                <div className="card" style={{ marginBottom: 24 }}>
                    <div className="card-header">
                        <div>
                            <div className="card-title">quick start — SDK</div>
                            <div className="card-subtitle">use the memwal SDK to remember and recall</div>
                        </div>
                    </div>
                    <div style={{ position: 'relative' }}>
                        <button
                            className="btn btn-secondary btn-sm"
                            style={{ position: 'absolute', top: 8, right: 8, zIndex: 1 }}
                            onClick={() => copyToClipboard(sdkSnippet, 'sdk')}
                        >
                            {copied === 'sdk' ? 'done' : 'copy'}
                        </button>
                        <pre style={{
                            background: 'var(--bg-input)', border: '1px solid var(--border)',
                            borderRadius: 'var(--radius-md)', padding: 20, overflow: 'auto',
                            fontSize: '0.8rem', lineHeight: 1.7,
                            fontFamily: 'var(--font-mono)', color: 'var(--text-secondary)',
                        }}>
                            <code>{sdkSnippet}</code>
                        </pre>
                    </div>
                </div>

                {/* Quick Start: AI SDK */}
                <div className="card" style={{ marginBottom: 24 }}>
                    <div className="card-header">
                        <div>
                            <div className="card-title">AI SDK integration</div>
                            <div className="card-subtitle">wrap any AI model with automatic memory</div>
                        </div>
                    </div>
                    <div style={{ position: 'relative' }}>
                        <button
                            className="btn btn-secondary btn-sm"
                            style={{ position: 'absolute', top: 8, right: 8, zIndex: 1 }}
                            onClick={() => copyToClipboard(aiSnippet, 'ai')}
                        >
                            {copied === 'ai' ? 'done' : 'copy'}
                        </button>
                        <pre style={{
                            background: 'var(--bg-input)', border: '1px solid var(--border)',
                            borderRadius: 'var(--radius-md)', padding: 20, overflow: 'auto',
                            fontSize: '0.8rem', lineHeight: 1.7,
                            fontFamily: 'var(--font-mono)', color: 'var(--text-secondary)',
                        }}>
                            <code>{aiSnippet}</code>
                        </pre>
                    </div>
                </div>

                {/* Install */}
                <div className="card" style={{ marginBottom: 40 }}>
                    <div className="card-header">
                        <div><div className="card-title">install</div></div>
                    </div>
                    <pre style={{
                        background: 'var(--bg-input)', border: '1px solid var(--border)',
                        borderRadius: 'var(--radius-md)', padding: 16,
                        fontSize: '0.85rem', fontFamily: 'var(--font-mono)', color: 'var(--accent)',
                    }}>
                        <code>npm install @cmdoss/memwal-v2</code>
                    </pre>
                </div>
            </div>
        </>
    )
}
