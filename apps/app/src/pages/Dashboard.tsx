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
import { generateDelegateKey, addDelegateKey, removeDelegateKey } from '@mysten-incubation/memwal/account'
import type { WalletSigner } from '@mysten-incubation/memwal/manual'
import { Link } from 'react-router-dom'
import { Copy, Eye, EyeOff, Trash2, RefreshCw, Plus, LogOut } from 'lucide-react'
import { Light as SyntaxHighlighter } from 'react-syntax-highlighter'
import js from 'react-syntax-highlighter/dist/esm/languages/hljs/javascript'
import bash from 'react-syntax-highlighter/dist/esm/languages/hljs/bash'
import { githubGist } from 'react-syntax-highlighter/dist/esm/styles/hljs'

SyntaxHighlighter.registerLanguage('javascript', js)
SyntaxHighlighter.registerLanguage('bash', bash)
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

const MAX_DELEGATE_KEYS = 20
const MAX_DELEGATE_KEYS_MESSAGE = 'this wallet already has 20 delegate keys. remove an old key before creating a new delegate key.'

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
    const [resolvedAccountObjectId, setResolvedAccountObjectId] = useState<string | null>(accountObjectId)
    const [loadingAccount, setLoadingAccount] = useState(false)
    const effectiveAccountObjectId = accountObjectId ?? resolvedAccountObjectId
    const [showKey, setShowKey] = useState(false)
    const [copied, setCopied] = useState<string | null>(null)
    const [pkgManager, setPkgManager] = useState<'npm' | 'pnpm' | 'yarn' | 'bun'>('npm')

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

    const fetchAccountObjectId = useCallback(async () => {
        if (!address) {
            setResolvedAccountObjectId(null)
            return
        }
        if (accountObjectId) return
        setResolvedAccountObjectId(null)
        setLoadingAccount(true)
        try {
            const registryObj = await suiClient.getObject({
                id: config.memwalRegistryId,
                options: { showContent: true },
            })
            if (registryObj?.data?.content && 'fields' in registryObj.data.content) {
                const fields = registryObj.data.content.fields as any
                const tableId = fields?.accounts?.fields?.id?.id
                if (tableId) {
                    const dynField = await suiClient.getDynamicFieldObject({
                        parentId: tableId,
                        name: { type: 'address', value: address },
                    })
                    if (dynField?.data?.content && 'fields' in dynField.data.content) {
                        setResolvedAccountObjectId((dynField.data.content.fields as any).value as string)
                    }
                }
            }
        } catch (err) {
            console.error('Failed to fetch account object ID:', err)
            setResolvedAccountObjectId(null)
        } finally {
            setLoadingAccount(false)
        }
    }, [address, accountObjectId, suiClient])

    useEffect(() => {
        setResolvedAccountObjectId(accountObjectId)
    }, [accountObjectId])

    useEffect(() => {
        fetchAccountObjectId()
    }, [fetchAccountObjectId])

    const hasResolvedAccount = Boolean(effectiveAccountObjectId)
    const isRecoveringExistingAccount = !delegateKey && hasResolvedAccount
    const isNewAccount = !delegateKey && !loadingAccount && !hasResolvedAccount
    const dashboardSubtitle = delegateKey
        ? 'manage your memwal account and delegate keys'
        : loadingAccount
            ? 'checking your memwal account...'
            : hasResolvedAccount
                ? 'remove an old delegate key, then create a new one'
                : 'no memwal account found for this wallet'
    const hasMaxDelegateKeys = onChainKeys.length >= MAX_DELEGATE_KEYS

    // ============================================================
    // Fetch on-chain delegate keys
    // ============================================================

    const fetchOnChainKeys = useCallback(async () => {
        if (!effectiveAccountObjectId) return
        setLoadingKeys(true)
        try {
            const obj = await suiClient.getObject({
                id: effectiveAccountObjectId,
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
            } else {
                setOnChainKeys([])
            }
        } catch (err) {
            console.error('Failed to fetch on-chain keys:', err)
        } finally {
            setLoadingKeys(false)
        }
    }, [effectiveAccountObjectId, suiClient])

    useEffect(() => {
        setOnChainKeys([])
        fetchOnChainKeys()
    }, [fetchOnChainKeys])

    // ============================================================
    // Generate + add a new delegate key (via SDK)
    // ============================================================

    // LOW-31: sanitize a key label — strip HTML special chars and control characters
    const sanitizeLabel = (raw: string): string =>
        raw
            // Strip HTML special characters
            .replace(/[<>&"'/]/g, '')
            // Strip C0/C1 control characters (U+0000–U+001F, U+007F–U+009F)
            .replace(/[\x00-\x1F\x7F-\x9F]/g, '')
            .trim()

    const handleAddKey = useCallback(async () => {
        if (!walletSigner) return

        if (!effectiveAccountObjectId) {
            setKeyError('account is still loading. please try again in a moment.')
            return
        }

        if (hasMaxDelegateKeys) {
            setKeyError(MAX_DELEGATE_KEYS_MESSAGE)
            return
        }

        // LOW-31: validate label before submitting on-chain
        const trimmedLabel = sanitizeLabel(newKeyLabel)
        if (!trimmedLabel) {
            setKeyError('key label cannot be empty')
            return
        }
        if (trimmedLabel.length > 64) {
            setKeyError('key label must be 64 characters or fewer')
            return
        }

        setAddingKey(true)
        setKeyError('')
        setNewPrivateKey(null)
        try {
            // Generate keypair via SDK
            const delegate = await generateDelegateKey()

            // Register on-chain via SDK
            await addDelegateKey({
                packageId: config.memwalPackageId,
                accountId: effectiveAccountObjectId!,
                publicKey: delegate.publicKey,
                label: trimmedLabel,
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
    }, [walletSigner, hasMaxDelegateKeys, effectiveAccountObjectId, newKeyLabel, suiClient, fetchOnChainKeys])

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
                accountId: effectiveAccountObjectId!,
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
    }, [walletSigner, effectiveAccountObjectId, delegatePublicKey, suiClient, fetchOnChainKeys, clearDelegateKeys])

    // ============================================================
    // SDK code snippets
    // ============================================================

    // LOW-30: Never render any portion (prefix/suffix) of the real private key
    // in DOM / copyable snippets. Use a static placeholder instead.
    const PRIVATE_KEY_PLACEHOLDER = '<YOUR_PRIVATE_KEY>'
    const ACCOUNT_ID_PLACEHOLDER = '<YOUR_ACCOUNT_ID>'

    const sdkSnippet = `import { MemWal } from "@mysten-incubation/memwal"

const memwal = MemWal.create({
  key: "${PRIVATE_KEY_PLACEHOLDER}",
  accountId: "${effectiveAccountObjectId ?? ACCOUNT_ID_PLACEHOLDER}",
  serverUrl: "${config.memwalServerUrl}",
})

// Remember something
const job = await memwal.remember("I'm allergic to peanuts")
await memwal.waitForRememberJob(job.job_id)

// Recall memories
const result = await memwal.recall("food allergies")
console.log(result.results[0].text)`

    const aiSnippet = `import { generateText } from "ai"
import { withMemWal } from "@mysten-incubation/memwal/ai"
import { openai } from "@ai-sdk/openai"

const model = withMemWal(openai("gpt-4o"), {
  key: "${PRIVATE_KEY_PLACEHOLDER}",
  accountId: "${effectiveAccountObjectId ?? ACCOUNT_ID_PLACEHOLDER}",
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
                    <Link to="/" className="nav-brand">
                        <img src={memwalLogo} alt="MemWal" style={{ height: 22 }} />
                    </Link>
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
                    <p>{dashboardSubtitle}</p>
                </div>

                {isRecoveringExistingAccount && (
                    <div className="warning-box" style={{ marginBottom: 24 }}>
                        <p>
                            your wallet already has a MemWal account, but this browser does not have a saved delegate key.
                            remove an old on-chain key below or create a new delegate key.
                        </p>
                    </div>
                )}

                {isNewAccount && (
                    <div className="warning-box" style={{ marginBottom: 24 }}>
                        <p>
                            no MemWal account found for this wallet.
                            create a delegate key to get started.
                        </p>
                    </div>
                )}

                {hasMaxDelegateKeys && (
                    <div className="warning-box" style={{ marginBottom: 24 }}>
                        <p>{MAX_DELEGATE_KEYS_MESSAGE}</p>
                    </div>
                )}

                {/* Action CTAs */}
                <div style={{ display: 'flex', gap: 16, marginBottom: 24 }}>
                    {delegateKey ? (
                        <Link to="/playground" className="dashboard-cta" style={{ flex: 1, marginBottom: 0 }}>
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
                    ) : hasMaxDelegateKeys ? (
                        <div className="dashboard-cta" style={{ flex: 1, marginBottom: 0, cursor: 'default', opacity: 0.75 }}>
                            <div>
                                <div className="dashboard-cta-title">
                                    remove a key first
                                </div>
                                <div className="dashboard-cta-subtitle">
                                    this wallet already has {MAX_DELEGATE_KEYS} delegate keys
                                </div>
                            </div>
                            <div className="dashboard-cta-arrow">↓</div>
                        </div>
                    ) : (
                        <Link to="/setup" className="dashboard-cta" style={{ flex: 1, marginBottom: 0 }}>
                            <div>
                                <div className="dashboard-cta-title">
                                    create delegate key
                                </div>
                                <div className="dashboard-cta-subtitle">
                                    generate and register a new SDK key
                                </div>
                            </div>
                            <div className="dashboard-cta-arrow">→</div>
                        </Link>
                    )}
                    {config.docsUrl && (
                        <a href={config.docsUrl} target="_blank" rel="noopener noreferrer" className="dashboard-cta" style={{ flex: 1, marginBottom: 0 }}>
                            <div>
                                <div className="dashboard-cta-title">
                                    documentation
                                </div>
                                <div className="dashboard-cta-subtitle">
                                    guides, examples & API reference
                                </div>
                            </div>
                            <div className="dashboard-cta-arrow">→</div>
                        </a>
                    )}
                </div>


                {/* Current Delegate Key */}
                {delegateKey && (
                    <div className="card" style={{ marginBottom: 24 }}>
                    <div className="card-header">
                        <div>
                            <div className="card-title">your delegate key</div>
                            <div className="card-subtitle">your Ed25519 key for SDK authentication</div>
                        </div>
                    </div>

                    {/* Account ID */}
                    {effectiveAccountObjectId && (
                        <div className="key-display key-display--white" style={{ marginBottom: 12 }}>
                            <div className="key-label">account ID</div>
                            <div className="key-value" style={{ fontSize: '0.78rem' }}>
                                {effectiveAccountObjectId}
                            </div>
                            <div className="key-actions">
                                <button
                                    className="btn btn-secondary btn-sm"
                                    onClick={() => copyToClipboard(effectiveAccountObjectId, 'acct')}
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
                )}

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
                                disabled={loadingKeys || loadingAccount}
                            >
                                <RefreshCw size={12} /> {loadingKeys || loadingAccount ? '...' : 'refresh'}
                            </button>
                            <button
                                className="lp-nav-cta"
                                onClick={() => {
                                    if (hasMaxDelegateKeys) {
                                        setKeyError(MAX_DELEGATE_KEYS_MESSAGE)
                                        return
                                    }
                                    setShowAddForm(true)
                                }}
                                disabled={showAddForm || addingKey || !effectiveAccountObjectId || hasMaxDelegateKeys}
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
                                    maxLength={64}
                                    onChange={(e) =>
                                        // LOW-31: strip HTML special chars and control characters on every keystroke
                                        setNewKeyLabel(sanitizeLabel(e.target.value))
                                    }
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
                                    disabled={addingKey || hasMaxDelegateKeys || !effectiveAccountObjectId}
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
                    {loadingAccount ? (
                        <div style={{ textAlign: 'center', padding: '20px 0', color: 'var(--text-muted)', fontSize: '0.85rem' }}>
                            loading account...
                        </div>
                    ) : loadingKeys ? (
                        <div style={{ textAlign: 'center', padding: '20px 0', color: 'var(--text-muted)', fontSize: '0.85rem' }}>
                            loading keys...
                        </div>
                    ) : !effectiveAccountObjectId ? (
                        <div style={{ textAlign: 'center', padding: '20px 0', color: 'var(--text-muted)', fontSize: '0.85rem' }}>
                            no MemWal account found for this wallet. create a delegate key to get started.
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
                        <SyntaxHighlighter language="javascript" style={githubGist} className="demo-code-block" customStyle={{ margin: 0, padding: 20 }}>
                            {sdkSnippet}
                        </SyntaxHighlighter>
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
                        <SyntaxHighlighter language="javascript" style={githubGist} className="demo-code-block" customStyle={{ margin: 0, padding: 20 }}>
                            {aiSnippet}
                        </SyntaxHighlighter>
                    </div>
                </div>

                {/* Install */}
                <div className="card" style={{ marginBottom: 40 }}>
                    <div className="card-header">
                        <div><div className="card-title">install</div></div>
                    </div>
                    <div className="install-tabs">
                        {(['npm', 'pnpm', 'yarn', 'bun'] as const).map((pm) => (
                            <button
                                key={pm}
                                className={`install-tab${pkgManager === pm ? ' install-tab--active' : ''}`}
                                onClick={() => setPkgManager(pm)}
                            >
                                {pm}
                            </button>
                        ))}
                    </div>
                    <SyntaxHighlighter language="bash" style={githubGist} className="demo-code-block install-command" customStyle={{ margin: 0, borderTopLeftRadius: 0, borderTopRightRadius: 0 }}>
                        {pkgManager === 'npm' ? 'npm install @mysten-incubation/memwal' :
                         pkgManager === 'pnpm' ? 'pnpm add @mysten-incubation/memwal' :
                         pkgManager === 'yarn' ? 'yarn add @mysten-incubation/memwal' :
                         'bun add @mysten-incubation/memwal'}
                    </SyntaxHighlighter>
                </div>
            </div>
        </>
    )
}
