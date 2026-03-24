/**
 * Dashboard — Account info, delegate keys management, SDK integration guide
 */

import { useState, useCallback, useEffect, useMemo } from 'react'
import {
    useCurrentAccount,
    useDisconnectWallet,
    useSignPersonalMessage,
    useSuiClient,
} from '@mysten/dapp-kit'
import { useSponsoredTransaction } from '../hooks/useSponsoredTransaction'
import { generateDelegateKey, addDelegateKey, removeDelegateKey } from '@mysten/memwal/account'
import type { WalletSigner } from '@mysten/memwal/manual'
import { Link } from 'react-router-dom'
import { Copy, Eye, EyeOff, Trash2, RefreshCw, Plus, LogOut } from 'lucide-react'
import { useDelegateKey } from '../App'
import { config } from '../config'
import memwalLogo from '../assets/memwal-logo.svg'

// ============================================================
// Types
// ============================================================

interface OnChainDelegateKey {
    publicKey: string
    suiAddress: string
    label: string
    createdAt: number
}

// ============================================================
// Dashboard Component
// ============================================================

export default function Dashboard() {
    const currentAccount = useCurrentAccount()
    const { mutateAsync: disconnect } = useDisconnectWallet()
    const { mutateAsync: signAndExecuteTx } = useSponsoredTransaction()
    const { mutateAsync: signPersonalMsg } = useSignPersonalMessage()
    const suiClient = useSuiClient()
    const { delegateKey, delegatePublicKey, accountObjectId, clearDelegateKeys } = useDelegateKey()

    const address = currentAccount?.address || ''
    const [showKey, setShowKey] = useState(false)
    const [copied, setCopied] = useState<string | null>(null)

    // Delegate key management state
    const [onChainKeys, setOnChainKeys] = useState<OnChainDelegateKey[]>([])
    const [loadingKeys, setLoadingKeys] = useState(false)
    const [addingKey, setAddingKey] = useState(false)
    const [removingKey, setRemovingKey] = useState<string | null>(null)
    const [showAddForm, setShowAddForm] = useState(false)
    const [newKeyLabel, setNewKeyLabel] = useState('New Key')
    const [keyError, setKeyError] = useState('')
    const [newPrivateKey, setNewPrivateKey] = useState<string | null>(null)

    // WalletSigner adapter — wraps dapp-kit hooks into SDK's WalletSigner interface
    const walletSigner = useMemo<WalletSigner | null>(() => {
        if (!currentAccount) return null
        return {
            address: currentAccount.address,
            signAndExecuteTransaction: ({ transaction }) =>
                signAndExecuteTx({ transaction }),
            signPersonalMessage: ({ message }) =>
                signPersonalMsg({ message }),
        }
    }, [currentAccount, signAndExecuteTx, signPersonalMsg])

    const copyToClipboard = useCallback(async (text: string, label: string) => {
        await navigator.clipboard.writeText(text)
        setCopied(label)
        setTimeout(() => setCopied(null), 2000)
    }, [])

    const handleLogout = useCallback(async () => {
        clearDelegateKeys()
        await disconnect()
    }, [clearDelegateKeys, disconnect])

    // ============================================================
    // Fetch on-chain delegate keys
    // ============================================================

    const fetchOnChainKeys = useCallback(async () => {
        if (!accountObjectId) return
        setLoadingKeys(true)
        try {
            const obj = await suiClient.getObject({
                id: accountObjectId,
                options: { showContent: true },
            })
            if (obj?.data?.content && 'fields' in obj.data.content) {
                const fields = obj.data.content.fields as any
                const keys = fields?.delegate_keys ?? []
                const parsed: OnChainDelegateKey[] = keys.map((k: any) => {
                    const f = k.fields ?? k
                    const pkBytes: number[] = f.public_key ?? []
                    const pkHex = pkBytes.map((b: number) => b.toString(16).padStart(2, '0')).join('')
                    return {
                        publicKey: pkHex,
                        suiAddress: f.sui_address ?? '',
                        label: f.label ?? '',
                        createdAt: Number(f.created_at ?? 0),
                    }
                })
                setOnChainKeys(parsed)
            }
        } catch (err) {
            console.error('Failed to fetch on-chain keys:', err)
        } finally {
            setLoadingKeys(false)
        }
    }, [accountObjectId, suiClient])

    useEffect(() => {
        fetchOnChainKeys()
    }, [fetchOnChainKeys])

    // ============================================================
    // Generate + add a new delegate key (via SDK)
    // ============================================================

    const handleAddKey = useCallback(async () => {
        if (!walletSigner) return
        setAddingKey(true)
        setKeyError('')
        setNewPrivateKey(null)
        try {
            // Generate keypair via SDK
            const delegate = await generateDelegateKey()

            // Register on-chain via SDK
            await addDelegateKey({
                packageId: config.memwalPackageId,
                accountId: accountObjectId!,
                publicKey: delegate.publicKey,
                label: newKeyLabel || 'New Key',
                walletSigner,
                suiClient,
                suiNetwork: config.suiNetwork,
            })

            setNewPrivateKey(delegate.privateKey)
            setShowAddForm(false)
            setNewKeyLabel('New Key')

            // Copy private key to clipboard automatically
            await navigator.clipboard.writeText(delegate.privateKey)

            // Refresh key list
            await fetchOnChainKeys()
        } catch (err: unknown) {
            const msg = err instanceof Error ? err.message : 'failed to add key'
            setKeyError(msg)
        } finally {
            setAddingKey(false)
        }
    }, [walletSigner, accountObjectId, newKeyLabel, suiClient, fetchOnChainKeys])

    // ============================================================
    // Remove a delegate key (via SDK)
    // ============================================================

    const handleRemoveKey = useCallback(async (publicKeyHex: string) => {
        if (!walletSigner) return
        if (!confirm('remove this delegate key? this cannot be undone.')) return
        setRemovingKey(publicKeyHex)
        setKeyError('')
        setNewPrivateKey(null)
        try {
            await removeDelegateKey({
                packageId: config.memwalPackageId,
                accountId: accountObjectId!,
                publicKey: publicKeyHex,
                walletSigner,
                suiClient,
                suiNetwork: config.suiNetwork,
            })

            // key removed successfully

            // If we removed our own key, clear local state
            if (publicKeyHex === delegatePublicKey) {
                clearDelegateKeys()
            }

            // Refresh key list
            await fetchOnChainKeys()
        } catch (err: unknown) {
            const msg = err instanceof Error ? err.message : 'failed to remove key'
            setKeyError(msg)
        } finally {

            setRemovingKey(null)
        }
    }, [walletSigner, accountObjectId, delegatePublicKey, suiClient, fetchOnChainKeys, clearDelegateKeys])

    // ============================================================
    // SDK code snippets
    // ============================================================

    const sdkSnippet = `import { MemWal } from "@mysten/memwal"

const memwal = MemWal.create({
  key: "${delegateKey?.slice(0, 8)}...${delegateKey?.slice(-8)}",
  accountId: "${accountObjectId?.slice(0, 10)}...",
  serverUrl: "${config.memwalServerUrl}",
})

// Remember something
await memwal.remember("I'm allergic to peanuts")

// Recall memories
const result = await memwal.recall("food allergies")
console.log(result.results[0].text)`

    const aiSnippet = `import { generateText } from "ai"
import { withMemWal } from "@mysten/memwal/ai"
import { openai } from "@ai-sdk/openai"

const model = withMemWal(openai("gpt-4o"), {
  key: "${delegateKey?.slice(0, 8)}...${delegateKey?.slice(-8)}",
  accountId: "${accountObjectId?.slice(0, 10)}...",
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
                        <img src={memwalLogo} alt="MemWal" style={{ height: 22 }} />
                    </div>
                    <div className="nav-user">
                        <span className="nav-address">
                            {address.slice(0, 6)}...{address.slice(-4)}
                        </span>
                        <button className="lp-nav-cta" onClick={handleLogout}>
                            <LogOut size={14} /> sign out
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
                <Link to="/playground" className="dashboard-cta">
                    <div>
                        <div className="dashboard-cta-title">
                            try interactive demo
                        </div>
                        <div className="dashboard-cta-subtitle">
                            test remember, recall & analyze with your live server
                        </div>
                    </div>
                    <div className="dashboard-cta-arrow">→</div>
                </Link>


                {/* Current Delegate Key */}
                <div className="card" style={{ marginBottom: 24 }}>
                    <div className="card-header">
                        <div>
                            <div className="card-title">your delegate key</div>
                            <div className="card-subtitle">your Ed25519 key for SDK authentication</div>
                        </div>
                    </div>

                    {/* Account ID */}
                    {accountObjectId && (
                        <div className="key-display key-display--white" style={{ marginBottom: 12 }}>
                            <div className="key-label">account ID</div>
                            <div className="key-value" style={{ fontSize: '0.78rem' }}>
                                {accountObjectId}
                            </div>
                            <div className="key-actions">
                                <button
                                    className="btn btn-secondary btn-sm"
                                    onClick={() => copyToClipboard(accountObjectId, 'acct')}
                                >
                                    <Copy size={12} /> {copied === 'acct' ? 'copied!' : 'copy'}
                                </button>
                            </div>
                        </div>
                    )}

                    {/* Public Key */}
                    <div className="key-display key-display--white" style={{ marginBottom: 12 }}>
                        <div className="key-label">public key</div>
                        <div className="key-value">
                            {delegatePublicKey}
                        </div>
                        <div className="key-actions">
                            <button
                                className="btn btn-secondary btn-sm"
                                onClick={() => copyToClipboard(delegatePublicKey!, 'pub')}
                            >
                                <Copy size={12} /> {copied === 'pub' ? 'copied!' : 'copy'}
                            </button>
                        </div>
                    </div>

                    {/* Private Key */}
                    <div className="key-display key-display--white">
                        <div className="key-label">private key</div>
                        {showKey ? (
                            <>
                                <div className="key-value">{delegateKey}</div>
                                <div className="key-actions">
                                    <button
                                        className="btn btn-secondary btn-sm"
                                        onClick={() => copyToClipboard(delegateKey!, 'priv')}
                                    >
                                        <Copy size={12} /> {copied === 'priv' ? 'copied!' : 'copy'}
                                    </button>
                                    <button className="btn btn-secondary btn-sm" onClick={() => setShowKey(false)}>
                                        <EyeOff size={12} /> hide
                                    </button>
                                </div>
                            </>
                        ) : (
                            <>
                                <div className="key-value">
                                    {'•'.repeat(64)}
                                </div>
                                <div className="key-actions">
                                    <button className="btn btn-secondary btn-sm" onClick={() => setShowKey(true)}>
                                        <Eye size={12} /> reveal
                                    </button>
                                </div>
                            </>
                        )}
                    </div>
                </div>

                {/* On-Chain Delegate Keys Management */}
                <div className="card" style={{ marginBottom: 24 }}>
                    <div className="card-header">
                        <div>
                            <div className="card-title">delegate keys (on-chain)</div>
                            <div className="card-subtitle">
                                all Ed25519 keys registered on your MemWalAccount
                            </div>
                        </div>
                        <div style={{ display: 'flex', gap: 8 }}>
                            <button
                                className="btn btn-secondary btn-sm"
                                onClick={fetchOnChainKeys}
                                disabled={loadingKeys}
                            >
                                <RefreshCw size={12} /> {loadingKeys ? '...' : 'refresh'}
                            </button>
                            <button
                                className="lp-nav-cta"
                                onClick={() => setShowAddForm(true)}
                                disabled={showAddForm || addingKey}
                            >
                                <Plus size={14} /> add key
                            </button>
                        </div>
                    </div>

                    {/* Status messages */}
                    {keyError && (
                        <div style={{
                            background: 'rgba(248,113,113,0.08)',
                            border: '1px solid rgba(248,113,113,0.2)',
                            borderRadius: 'var(--radius-md)',
                            padding: '10px 14px',
                            marginBottom: 12,
                            color: 'var(--danger)',
                            fontSize: '0.82rem',
                        }}>
                            {keyError}
                        </div>
                    )}
                    {newPrivateKey && (
                        <div style={{ marginBottom: 12 }}>
                            <div className="warning-box" style={{ marginBottom: 12 }}>
                                <p>
                                    <strong>save this private key now!</strong> it has been copied to your clipboard.
                                    store it securely — it cannot be recovered.
                                </p>
                            </div>
                            <div className="key-display key-display--white">
                                <div className="key-label">new private key (keep secret)</div>
                                <div className="key-value">{newPrivateKey}</div>
                                <div className="key-actions">
                                    <button
                                        className="btn btn-secondary btn-sm"
                                        onClick={() => copyToClipboard(newPrivateKey, 'new-priv')}
                                    >
                                        <Copy size={12} /> {copied === 'new-priv' ? 'copied!' : 'copy'}
                                    </button>
                                    <button
                                        className="btn btn-secondary btn-sm"
                                        onClick={() => setNewPrivateKey(null)}
                                    >
                                        done
                                    </button>
                                </div>
                            </div>
                        </div>
                    )}

                    {/* Add Key Form */}
                    {showAddForm && (
                        <div style={{
                            background: 'rgba(255,255,255,0.03)',
                            border: '1px solid var(--border)',
                            borderRadius: 'var(--radius-md)',
                            padding: 16,
                            marginBottom: 12,
                        }}>
                            <div style={{ marginBottom: 12 }}>
                                <label style={{ fontSize: '0.82rem', color: 'var(--text-secondary)', display: 'block', marginBottom: 6 }}>
                                    key label
                                </label>
                                <input
                                    type="text"
                                    value={newKeyLabel}
                                    onChange={(e) => setNewKeyLabel(e.target.value)}
                                    placeholder="e.g. MacBook Pro, Production Server"
                                    style={{
                                        width: '100%',
                                        padding: '8px 12px',
                                        background: 'var(--bg-secondary)',
                                        border: '1px solid var(--border)',
                                        borderRadius: 'var(--radius-sm)',
                                        color: 'var(--text-primary)',
                                        fontSize: '0.85rem',
                                        outline: 'none',
                                    }}
                                />
                            </div>
                            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
                                <button
                                    className="btn btn-secondary btn-sm"
                                    onClick={() => { setShowAddForm(false); setKeyError('') }}
                                    disabled={addingKey}
                                >
                                    cancel
                                </button>
                                <button
                                    className="btn btn-primary btn-sm"
                                    onClick={handleAddKey}
                                    disabled={addingKey}
                                >
                                    {addingKey ? 'generating & registering...' : 'generate & register on-chain'}
                                </button>
                            </div>
                            <p style={{ fontSize: '0.75rem', color: 'var(--text-muted)', marginTop: 10, lineHeight: 1.5 }}>
                                a new Ed25519 keypair will be generated. the private key will be copied to your clipboard.
                                save it securely — it cannot be recovered.
                            </p>
                        </div>
                    )}

                    {/* Key List */}
                    {loadingKeys ? (
                        <div style={{ textAlign: 'center', padding: '20px 0', color: 'var(--text-muted)', fontSize: '0.85rem' }}>
                            loading keys...
                        </div>
                    ) : onChainKeys.length === 0 ? (
                        <div style={{ textAlign: 'center', padding: '20px 0', color: 'var(--text-muted)', fontSize: '0.85rem' }}>
                            no delegate keys found on-chain
                        </div>
                    ) : (
                        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                            {onChainKeys.map((k) => {
                                const isCurrentKey = k.publicKey === delegatePublicKey
                                const isRemoving = removingKey === k.publicKey
                                return (
                                    <div
                                        key={k.publicKey}
                                        className="key-display key-display--white"
                                    >
                                        <div className="key-label">
                                            {k.label || 'Untitled'}
                                            {isCurrentKey && ' · current'}
                                            <span style={{ fontWeight: 400, marginLeft: 8 }}>
                                                {new Date(k.createdAt).toLocaleDateString()}
                                            </span>
                                        </div>
                                        <div className="key-value">
                                            {k.publicKey}
                                        </div>
                                        <div className="key-actions">
                                            <button
                                                className="btn btn-secondary btn-sm"
                                                onClick={() => copyToClipboard(k.publicKey, `pk-${k.publicKey.slice(0,8)}`)}
                                            >
                                                <Copy size={12} /> {copied === `pk-${k.publicKey.slice(0,8)}` ? 'copied!' : 'copy public key'}
                                            </button>
                                            <button
                                                className="btn btn-danger btn-sm"
                                                onClick={() => handleRemoveKey(k.publicKey)}
                                                disabled={isRemoving}
                                            >
                                                <Trash2 size={12} /> {isRemoving ? '...' : 'remove'}
                                            </button>
                                        </div>
                                    </div>
                                )
                            })}
                        </div>
                    )}
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
                            style={{ position: 'absolute', top: 8, right: 8, zIndex: 1, background: '#ffffff' }}
                            onClick={() => copyToClipboard(sdkSnippet, 'sdk')}
                        >
                            <Copy size={12} /> {copied === 'sdk' ? 'done' : 'copy'}
                        </button>
                        <pre className="demo-code-block" style={{ padding: 20 }}>
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
                            style={{ position: 'absolute', top: 8, right: 8, zIndex: 1, background: '#ffffff' }}
                            onClick={() => copyToClipboard(aiSnippet, 'ai')}
                        >
                            <Copy size={12} /> {copied === 'ai' ? 'done' : 'copy'}
                        </button>
                        <pre className="demo-code-block" style={{ padding: 20 }}>
                            <code>{aiSnippet}</code>
                        </pre>
                    </div>
                </div>

                {/* Install */}
                <div className="card" style={{ marginBottom: 40 }}>
                    <div className="card-header">
                        <div><div className="card-title">install</div></div>
                    </div>
                    <pre className="demo-code-block install-command">
                        <code>npm install @mysten/memwal</code>
                    </pre>
                </div>
            </div>
        </>
    )
}
