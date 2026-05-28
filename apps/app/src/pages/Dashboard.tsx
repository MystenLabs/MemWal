/**
 * Dashboard — Account info, delegate keys management, SDK integration guide
 */

import { useState, useCallback, useEffect, useMemo, type SVGProps } from 'react'
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
import python from 'react-syntax-highlighter/dist/esm/languages/hljs/python'
import { githubGist } from 'react-syntax-highlighter/dist/esm/styles/hljs'

SyntaxHighlighter.registerLanguage('javascript', js)
SyntaxHighlighter.registerLanguage('bash', bash)
SyntaxHighlighter.registerLanguage('python', python)
import { useDelegateKey } from '../App'
import { config } from '../config'
import { getAnalyticsErrorType, trackEvent } from '../utils/analytics'
import {
    getDelegateKeyFields,
    getMoveFields,
    type AccountObjectFields,
    type DynamicFieldObjectFields,
    type RegistryObjectFields,
} from '../utils/suiFields'

function DelegateKeyCtaIcon(props: SVGProps<SVGSVGElement>) {
    return (
        <svg viewBox="0 0 34.9865 40.1201" fill="none" aria-hidden="true" {...props}>
            <path
                d="M34.9835 6.48047V21.043C34.9837 21.0489 34.9843 21.0554 34.9845 21.0625C34.9854 21.0937 34.9861 21.1366 34.9864 21.1904C34.987 21.2981 34.9855 21.4501 34.9767 21.6416C34.9591 22.0249 34.9129 22.568 34.8019 23.2324C34.5798 24.5608 34.0953 26.3809 33.048 28.3838C30.9395 32.4156 26.6048 37.0829 17.8097 40.0146L17.4933 40.1201L17.1769 40.0146C8.38176 37.0829 4.04706 32.4157 1.93859 28.3838C0.891206 26.3809 0.406732 24.5608 0.184682 23.2324C0.0736325 22.568 0.0274786 22.0249 0.00987737 21.6416C0.00108818 21.4501 -0.000482765 21.2981 0.000111746 21.1904C0.000409352 21.1366 0.00114976 21.0937 0.00206487 21.0625C0.002274 21.0554 0.002837 21.0489 0.00304143 21.043V6.48047L17.4933 0L34.9835 6.48047ZM2.00304 7.87207V21.082L2.00206 21.1084C2.00196 21.1111 2.00126 21.1153 2.00109 21.1211C2.00063 21.1368 2.00032 21.1637 2.00011 21.2012C1.9997 21.2763 2.00079 21.3942 2.00792 21.5498C2.02224 21.8614 2.06076 22.3245 2.15734 22.9023C2.35061 24.0586 2.7772 25.6712 3.71105 27.457C5.54154 30.9573 9.37644 35.2273 17.4933 38.0088C25.6101 35.2273 29.445 30.9573 31.2755 27.457C32.2093 25.6712 32.6359 24.0586 32.8292 22.9023C32.9258 22.3245 32.9643 21.8614 32.9786 21.5498C32.9858 21.3942 32.9869 21.2763 32.9864 21.2012C32.9862 21.1637 32.9849 21.1368 32.9845 21.1211C32.9843 21.1153 32.9846 21.1111 32.9845 21.1084L32.9835 21.082V7.87207L17.4933 2.13184L2.00304 7.87207ZM20.1232 13.6367C20.1232 12.2009 18.9593 11.0363 17.5236 11.0361C16.0876 11.0361 14.923 12.2008 14.923 13.6367C14.9231 15.0725 16.0877 16.2363 17.5236 16.2363C18.9592 16.2361 20.123 15.0724 20.1232 13.6367ZM22.1232 13.6367C22.123 15.8334 20.5827 17.6681 18.5236 18.125V31.1162H16.5236V28.7061H13.5831V26.7061H16.5236V24.5566H13.5831V22.5566H16.5236V18.126C14.464 17.6694 12.9231 15.8337 12.923 13.6367C12.923 11.0962 14.983 9.03613 17.5236 9.03613C20.0639 9.03632 22.1232 11.0963 22.1232 13.6367Z"
                fill="currentColor"
            />
        </svg>
    )
}

function DocumentationCtaIcon(props: SVGProps<SVGSVGElement>) {
    return (
        <svg viewBox="0 0 34.81 40" fill="none" aria-hidden="true" {...props}>
            <path
                d="M31.12 6.81H26.59V3.69C26.59 1.65 24.94 0 22.9 0H3.69C1.65 0 0 1.65 0 3.69V29.51C0 31.55 1.65 33.2 3.69 33.2H8.22V36.32C8.22 38.36 9.87 40.01 11.91 40.01H31.13C33.17 40.01 34.82 38.36 34.82 36.32V10.5C34.82 8.46 33.17 6.81 31.13 6.81H31.12ZM8.22 10.5V31.19H3.69C2.76 31.19 2 30.43 2 29.5V3.69C2 2.76 2.76 2 3.69 2H22.91C23.84 2 24.6 2.76 24.6 3.69V6.81H11.91C9.87 6.81 8.22 8.46 8.22 10.5ZM32.81 36.31C32.81 37.24 32.05 38 31.12 38H11.9C10.97 38 10.21 37.24 10.21 36.31V10.5C10.21 9.57 10.97 8.81 11.9 8.81H31.12C32.05 8.81 32.81 9.57 32.81 10.5V36.32V36.31Z"
                fill="currentColor"
            />
            <path d="M28.48 22.5H14.55V24.5H28.48V22.5Z" fill="currentColor" />
            <path d="M28.48 16.5H14.55V18.5H28.48V16.5Z" fill="currentColor" />
            <path d="M28.48 28.5H14.55V30.5H28.48V28.5Z" fill="currentColor" />
        </svg>
    )
}

function CtaArrowIcon(props: SVGProps<SVGSVGElement>) {
    return (
        <svg viewBox="0 0 20.36 20.36" fill="none" aria-hidden="true" {...props}>
            <path
                d="M10.18 0L9.47 0.71L18.45 9.68H0V10.68H18.45L9.47 19.66L10.18 20.36L20.36 10.18L10.18 0Z"
                fill="currentColor"
            />
        </svg>
    )
}

const walrusCodeTheme = {
    hljs: {
        color: '#faf8f5',
        background: '#050505',
    },
    'hljs-keyword': {
        color: '#cab1ff',
    },
    'hljs-built_in': {
        color: '#faf8f5',
    },
    'hljs-title': {
        color: '#faf8f5',
    },
    'hljs-attr': {
        color: '#e8ff75',
    },
    'hljs-property': {
        color: '#e8ff75',
    },
    'hljs-variable': {
        color: '#faf8f5',
    },
    'hljs-string': {
        color: '#faf8f5',
    },
    'hljs-comment': {
        color: '#8f9294',
    },
    'hljs-number': {
        color: '#e8ff75',
    },
    'hljs-literal': {
        color: '#e8ff75',
    },
    'hljs-params': {
        color: '#faf8f5',
    },
}

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
type QuickstartLanguage = 'ts' | 'py'

function bytesToHex(bytes: Uint8Array | number[]): string {
    return Array.from(bytes).map((b) => b.toString(16).padStart(2, '0')).join('')
}

// ============================================================
// Dashboard Component
// ============================================================

export default function Dashboard({
    previewMode = false,
    previewState = 'empty',
}: {
    previewMode?: boolean
    previewState?: 'empty' | 'ready'
}) {
    const currentAccount = useCurrentAccount()
    const { mutateAsync: disconnect } = useDisconnectWallet()
    const { mutateAsync: signAndExecuteTx } = useSponsoredTransaction()
    const { mutateAsync: signPersonalMsg } = useSignPersonalMessage()
    const suiClient = useSuiClient()
    const { delegateKey, delegatePublicKey, accountObjectId, setDelegateKeys, clearDelegateKeys } = useDelegateKey()

    const address = currentAccount?.address || (
        previewMode
            ? '0x7f33c06e6d144bc3c24aaef7c8f7421c1287df6ce9c5ab74ac729b13f4194'
            : ''
    )
    const previewReady = previewMode && previewState === 'ready'
    const previewAccountObjectId = previewReady
        ? '0x7bc62cf958c4b27b16ad2f1a3f33d1f0e811e08d4fc079edc3525a7d2e2dc551'
        : null
    const [resolvedAccountObjectId, setResolvedAccountObjectId] = useState<string | null>(accountObjectId)
    const [loadingAccount, setLoadingAccount] = useState(false)
    const effectiveAccountObjectId = accountObjectId ?? previewAccountObjectId ?? resolvedAccountObjectId
    const [showKey, setShowKey] = useState(false)
    const [copied, setCopied] = useState<string | null>(null)
    const [pkgManager, setPkgManager] = useState<'npm' | 'pnpm' | 'yarn' | 'bun'>('npm')
    const [quickstartLanguage, setQuickstartLanguage] = useState<QuickstartLanguage>('ts')

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
        trackEvent('copy_action', {
            item: label.startsWith('pk-') ? 'public_key' : label,
            location: 'dashboard',
        })
        setTimeout(() => setCopied(null), 2000)
    }, [])

    const handleLogout = useCallback(async () => {
        trackEvent('sign_out', { location: 'dashboard' })
        clearDelegateKeys()
        await disconnect()
    }, [clearDelegateKeys, disconnect])

    const fetchAccountObjectId = useCallback(async () => {
        if (!address || previewMode) {
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
            const fields = getMoveFields<RegistryObjectFields>(registryObj?.data?.content)
            if (fields) {
                const tableId = fields?.accounts?.fields?.id?.id
                if (tableId) {
                    const dynField = await suiClient.getDynamicFieldObject({
                        parentId: tableId,
                        name: { type: 'address', value: address },
                    })
                    const dynFields = getMoveFields<DynamicFieldObjectFields>(dynField?.data?.content)
                    if (dynFields?.value) setResolvedAccountObjectId(dynFields.value)
                }
            }
        } catch (err) {
            console.error('Failed to fetch account object ID:', err)
            setResolvedAccountObjectId(null)
        } finally {
            setLoadingAccount(false)
        }
    }, [address, accountObjectId, previewMode, suiClient])

    useEffect(() => {
        setResolvedAccountObjectId(accountObjectId)
    }, [accountObjectId])

    useEffect(() => {
        fetchAccountObjectId()
    }, [fetchAccountObjectId])

    const hasResolvedAccount = Boolean(effectiveAccountObjectId)
    const isRecoveringExistingAccount = !delegateKey && hasResolvedAccount && !previewReady
    const isNewAccount = !delegateKey && !loadingAccount && !hasResolvedAccount
    const activeEnvironmentLabel = config.suiNetwork === 'mainnet'
        ? 'production / mainnet'
        : 'staging / testnet'
    const expectedRelayerUrl = config.suiNetwork === 'mainnet'
        ? 'https://relayer.memwal.ai'
        : 'https://relayer.dev.memwal.ai'
    const normalizedRelayerUrl = config.memwalServerUrl.toLowerCase()
    const relayerEnvironmentLabel = normalizedRelayerUrl.startsWith('/')
        ? 'local dev proxy / testnet'
        : normalizedRelayerUrl.includes('localhost') || normalizedRelayerUrl.includes('127.0.0.1')
        ? 'local development'
        : normalizedRelayerUrl.includes('staging')
            ? 'staging / testnet'
            : normalizedRelayerUrl.includes('dev')
                ? 'dev / testnet'
                : 'production / mainnet'
    const relayerLooksMismatched =
        (config.suiNetwork === 'mainnet' && normalizedRelayerUrl.includes('staging')) ||
        (config.suiNetwork !== 'mainnet' &&
            normalizedRelayerUrl.includes('relayer.memwal.ai') &&
            !normalizedRelayerUrl.includes('staging') &&
            !normalizedRelayerUrl.includes('dev'))
    const dashboardSubtitle = delegateKey || previewReady
        ? ''
        : loadingAccount
            ? 'checking your Walrus Memory account...'
            : hasResolvedAccount
                ? 'remove an old delegate key, then create a new one'
                : 'no Walrus Memory account found for this wallet'
    const showDashboardSubtitle = Boolean(dashboardSubtitle)
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
            const fields = getMoveFields<AccountObjectFields>(obj?.data?.content)
            if (fields) {
                const keys = fields.delegate_keys ?? []
                const parsed: OnChainDelegateKey[] = keys.map((k) => {
                    const f = getDelegateKeyFields(k)
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

    // sanitize a key label — strip HTML special chars and control characters
    const sanitizeLabel = (raw: string): string =>
        raw
            // Strip HTML special characters
            .replace(/[<>&"'/]/g, '')
            // Strip Unicode control characters.
            .replace(/\p{Cc}/gu, '')
            .trim()

    const handleAddKey = useCallback(async () => {
        if (!walletSigner) return

        if (!effectiveAccountObjectId) {
            setKeyError('account is still loading. please try again in a moment.')
            trackEvent('delegate_key_add_failed', { error_type: 'account_loading' })
            return
        }

        if (hasMaxDelegateKeys) {
            setKeyError(MAX_DELEGATE_KEYS_MESSAGE)
            trackEvent('delegate_key_add_failed', { error_type: 'max_delegate_keys' })
            return
        }

        // validate label before submitting on-chain
        const trimmedLabel = sanitizeLabel(newKeyLabel)
        if (!trimmedLabel) {
            setKeyError('key label cannot be empty')
            trackEvent('delegate_key_add_failed', { error_type: 'invalid_input' })
            return
        }
        if (trimmedLabel.length > 64) {
            setKeyError('key label must be 64 characters or fewer')
            trackEvent('delegate_key_add_failed', { error_type: 'invalid_input' })
            return
        }

        setAddingKey(true)
        setKeyError('')
        setNewPrivateKey(null)
        trackEvent('delegate_key_add_start', { location: 'dashboard' })
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

            const delegatePublicKeyHex = bytesToHex(delegate.publicKey)
            setNewPrivateKey(delegate.privateKey)
            setDelegateKeys(delegate.privateKey, delegatePublicKeyHex, effectiveAccountObjectId!)
            setShowAddForm(false)
            setNewKeyLabel('New Key')

            trackEvent('delegate_key_add_complete', { location: 'dashboard' })
            void navigator.clipboard.writeText(delegate.privateKey).catch(() => undefined)
            void fetchOnChainKeys()
        } catch (err: unknown) {
            const msg = err instanceof Error ? err.message : 'failed to add key'
            setKeyError(msg)
            trackEvent('delegate_key_add_failed', { error_type: getAnalyticsErrorType(err) })
        } finally {
            setAddingKey(false)
        }
    }, [walletSigner, hasMaxDelegateKeys, effectiveAccountObjectId, newKeyLabel, suiClient, fetchOnChainKeys, setDelegateKeys])

    // ============================================================
    // Remove a delegate key (via SDK)
    // ============================================================

    const handleRemoveKey = useCallback(async (publicKeyHex: string) => {
        if (!walletSigner) return
        if (!confirm('remove this delegate key? this cannot be undone.')) return
        setRemovingKey(publicKeyHex)
        setKeyError('')
        setNewPrivateKey(null)
        trackEvent('delegate_key_remove_start', { location: 'dashboard' })
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
            trackEvent('delegate_key_remove_complete', { location: 'dashboard' })
        } catch (err: unknown) {
            const msg = err instanceof Error ? err.message : 'failed to remove key'
            setKeyError(msg)
            trackEvent('delegate_key_remove_failed', { error_type: getAnalyticsErrorType(err) })
        } finally {

            setRemovingKey(null)
        }
    }, [walletSigner, effectiveAccountObjectId, delegatePublicKey, suiClient, fetchOnChainKeys, clearDelegateKeys])

    // ============================================================
    // SDK code snippets
    // ============================================================

    // Never render any portion (prefix/suffix) of the real private key
    // in DOM / copyable snippets. Use a static placeholder instead.
    const PRIVATE_KEY_PLACEHOLDER = '<YOUR_PRIVATE_KEY>'
    const ACCOUNT_ID_PLACEHOLDER = '<YOUR_ACCOUNT_ID>'

    const sdkTypeScriptSnippet = `import { MemWal } from "@mysten-incubation/memwal"

const memwal = MemWal.create({
  key: process.env.MEMWAL_PRIVATE_KEY ?? "${PRIVATE_KEY_PLACEHOLDER}",
  accountId: process.env.MEMWAL_ACCOUNT_ID ?? "${effectiveAccountObjectId ?? ACCOUNT_ID_PLACEHOLDER}",
  serverUrl: process.env.MEMWAL_SERVER_URL ?? "${config.memwalServerUrl}",
})

// Remember something
const job = await memwal.remember("I'm allergic to peanuts")
await memwal.waitForRememberJob(job.job_id)

// Recall memories
const result = await memwal.recall("food allergies")
console.log(result.results[0].text)`

    const sdkPythonSnippet = `import asyncio
import os
from memwal import MemWal

async def main():
    memwal = MemWal.create(
        key=os.environ["MEMWAL_PRIVATE_KEY"],
        account_id=os.environ["MEMWAL_ACCOUNT_ID"],
        server_url=os.environ.get("MEMWAL_SERVER_URL", "${config.memwalServerUrl}"),
    )

    await memwal.remember_and_wait("I'm allergic to peanuts")

    result = await memwal.recall("food allergies")
    print(result.results[0].text)

    await memwal.close()

asyncio.run(main())`

    const sdkSnippet = quickstartLanguage === 'py' ? sdkPythonSnippet : sdkTypeScriptSnippet
    const sdkSnippetLanguage = quickstartLanguage === 'py' ? 'python' : 'javascript'
    const sdkCopyLabel = `sdk-${quickstartLanguage}`

    return (
        <div className="dash-page">
            <nav className="dash-nav">
                <div className="dash-nav-inner">
                    <Link to="/" className="dash-logo" aria-label="Walrus Memory home">
                        <span>walrus</span>
                        <span>memory</span>
                    </Link>
                    <div className="dash-nav-actions">
                        <span className="dash-address">
                            {address.slice(0, 6)}...{address.slice(-4)}
                        </span>
                        <button className="dash-outline-button" onClick={handleLogout}>
                            Sign out <LogOut size={13} />
                        </button>
                    </div>
                </div>
            </nav>

            <main className="dash-shell">
                {/* Header */}
                <div className={`dashboard-header${showDashboardSubtitle ? '' : ' dashboard-header--compact'}`}>
                    <h2>Dashboard</h2>
                    {showDashboardSubtitle && <p>{dashboardSubtitle}</p>}
                </div>

                {isRecoveringExistingAccount && (
                    <div className="dash-alert" style={{ marginBottom: 24 }}>
                        <span className="dash-alert-icon" aria-hidden="true" />
                        <p>
                            your wallet already has a Walrus Memory account, but this browser does not have a saved delegate key.
                            remove an old on-chain key below or create a new delegate key.
                        </p>
                    </div>
                )}

                {isNewAccount && (
                    <div className="dash-alert" style={{ marginBottom: 24 }}>
                        <span className="dash-alert-icon" aria-hidden="true" />
                        <p>
                            No Walrus Memory account found for this wallet,
                            create a delegate key to get started.
                        </p>
                    </div>
                )}

                {hasMaxDelegateKeys && (
                    <div className="dash-alert" style={{ marginBottom: 24 }}>
                        <span className="dash-alert-icon" aria-hidden="true" />
                        <p>{MAX_DELEGATE_KEYS_MESSAGE}</p>
                    </div>
                )}

                {/* Action CTAs */}
                <div className="dashboard-cta-row">
                    {delegateKey ? (
                        <Link
                            to="/playground"
                            className="dashboard-cta"
                            onClick={() => trackEvent('cta_click', { cta: 'interactive_demo', location: 'dashboard' })}
                        >
                            <span className="dashboard-cta-icon-wrap" aria-hidden="true">
                                <DelegateKeyCtaIcon className="dashboard-cta-icon" />
                            </span>
                            <div className="dashboard-cta-text">
                                <div className="dashboard-cta-title">Try the interactive demo</div>
                                <div className="dashboard-cta-subtitle">Test remember, recall &amp; analyze with your live server</div>
                            </div>
                            <CtaArrowIcon className="dashboard-cta-arrow" />
                        </Link>
                    ) : hasMaxDelegateKeys ? (
                        <div className="dashboard-cta dashboard-cta--disabled">
                            <span className="dashboard-cta-icon-wrap" aria-hidden="true">
                                <DelegateKeyCtaIcon className="dashboard-cta-icon" />
                            </span>
                            <div className="dashboard-cta-text">
                                <div className="dashboard-cta-title">Remove a key first</div>
                                <div className="dashboard-cta-subtitle">This wallet already has {MAX_DELEGATE_KEYS} delegate keys</div>
                            </div>
                            <span className="dashboard-cta-arrow" aria-hidden="true">↓</span>
                        </div>
                    ) : (
                        <Link
                            to="/setup"
                            className="dashboard-cta"
                            onClick={() => trackEvent('cta_click', { cta: 'create_delegate_key', location: 'dashboard' })}
                        >
                            <span className="dashboard-cta-icon-wrap" aria-hidden="true">
                                <DelegateKeyCtaIcon className="dashboard-cta-icon" />
                            </span>
                            <div className="dashboard-cta-text">
                                <div className="dashboard-cta-title">Create a delegate key</div>
                                <div className="dashboard-cta-subtitle">Generate and register a new SDK key</div>
                            </div>
                            <CtaArrowIcon className="dashboard-cta-arrow" />
                        </Link>
                    )}
                    {config.docsUrl && (
                        <a
                            href={config.docsUrl}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="dashboard-cta"
                            onClick={() => trackEvent('outbound_link_click', { link: 'docs', location: 'dashboard' })}
                        >
                            <span className="dashboard-cta-icon-wrap" aria-hidden="true">
                                <DocumentationCtaIcon className="dashboard-cta-icon" />
                            </span>
                            <div className="dashboard-cta-text">
                                <div className="dashboard-cta-title">Documentation</div>
                                <div className="dashboard-cta-subtitle">Guides, examples &amp; API references</div>
                            </div>
                            <CtaArrowIcon className="dashboard-cta-arrow" />
                        </a>
                    )}
                </div>


                {/* Current Delegate Key */}
                {delegateKey && (
                    <div className="card dashboard-credentials-card" style={{ marginBottom: 24 }}>
                    <div className="card-header">
                        <div>
                            <div className="card-title">SDK credentials</div>
                            <div className="card-subtitle">copy the delegate private key into server env as MEMWAL_PRIVATE_KEY</div>
                        </div>
                    </div>

                    {/* Private Key */}
                    <div className="key-display key-display--white" style={{ marginBottom: 12 }}>
                        <div className="key-label">delegate private key — server-side MEMWAL_PRIVATE_KEY</div>
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
                                    <button
                                        className="btn btn-secondary btn-sm"
                                        onClick={() => copyToClipboard(`MEMWAL_PRIVATE_KEY=${delegateKey}`, 'priv-env')}
                                    >
                                        <Copy size={12} /> {copied === 'priv-env' ? 'copied!' : 'copy env line'}
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

                    <div className="warning-box" style={{ marginBottom: 12 }}>
                        <p>
                            active environment: <strong>{activeEnvironmentLabel}</strong>. configured relayer:
                            {' '}<code>{config.memwalServerUrl}</code> ({relayerEnvironmentLabel}).
                            {' '}matching relayer: <code>{expectedRelayerUrl}</code>.
                            {' '}do not mix staging/testnet credentials with production/mainnet relayer configs.
                        </p>
                        {relayerLooksMismatched && (
                            <p style={{ marginTop: 8 }}>
                                this dashboard network and relayer URL look mismatched; API calls may fail with 401.
                            </p>
                        )}
                    </div>

                    {/* Account ID */}
                    {effectiveAccountObjectId && (
                        <div className="key-display key-display--white" style={{ marginBottom: 12 }}>
                            <div className="key-label">account ID — MEMWAL_ACCOUNT_ID</div>
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
                                <button
                                    className="btn btn-secondary btn-sm"
                                    onClick={() => copyToClipboard(`MEMWAL_ACCOUNT_ID=${effectiveAccountObjectId}`, 'acct-env')}
                                >
                                    <Copy size={12} /> {copied === 'acct-env' ? 'copied!' : 'copy env line'}
                                </button>
                            </div>
                        </div>
                    )}

                    <div className="key-display key-display--white" style={{ marginBottom: 12 }}>
                        <div className="key-label">relayer URL — MEMWAL_SERVER_URL</div>
                        <div className="key-value" style={{ fontSize: '0.78rem' }}>
                            {config.memwalServerUrl}
                        </div>
                        <div className="key-actions">
                            <button
                                className="btn btn-secondary btn-sm"
                                onClick={() => copyToClipboard(`MEMWAL_SERVER_URL=${config.memwalServerUrl}`, 'server-env')}
                            >
                                <Copy size={12} /> {copied === 'server-env' ? 'copied!' : 'copy env line'}
                            </button>
                        </div>
                    </div>

                    {/* Public Key */}
                    <div className="key-display key-display--white" style={{ marginBottom: 12 }}>
                        <div className="key-label">delegate public key — shareable, not the .env private key</div>
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
                    </div>
                )}

                {/* On-Chain Delegate Keys Management */}
                <div className="card dashboard-keys-card" style={{ marginBottom: 24 }}>
                    <div className="card-header">
                        <div>
                            <div className="card-title">Delegate keys (on-chain)</div>
                            <div className="card-subtitle">
                                All Ed25519 keys registered on your Walrus Memory account
                            </div>
                        </div>
                        <div className="card-header-actions">
                            <button
                                className="btn btn-secondary btn-sm dashboard-keys-refresh"
                                onClick={fetchOnChainKeys}
                                disabled={loadingKeys || loadingAccount}
                            >
                                <RefreshCw size={12} /> {loadingKeys || loadingAccount ? '...' : 'Refresh'}
                            </button>
                            <button
                                className="lp-nav-cta dashboard-keys-add"
                                onClick={() => {
                                    if (hasMaxDelegateKeys) {
                                        setKeyError(MAX_DELEGATE_KEYS_MESSAGE)
                                        trackEvent('delegate_key_add_failed', { error_type: 'max_delegate_keys' })
                                        return
                                    }
                                    trackEvent('cta_click', { cta: 'show_add_delegate_key_form', location: 'dashboard' })
                                    setShowAddForm(true)
                                }}
                                disabled={showAddForm || addingKey || !effectiveAccountObjectId || hasMaxDelegateKeys}
                            >
                                Add key <Plus size={12} aria-hidden="true" />
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
                                        // strip HTML special chars and control characters on every keystroke
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
                        <div className="dashboard-empty-message" style={{ textAlign: 'center', padding: '20px 0', color: 'var(--text-muted)', fontSize: '0.85rem' }}>
                            loading account...
                        </div>
                    ) : loadingKeys ? (
                        <div className="dashboard-empty-message" style={{ textAlign: 'center', padding: '20px 0', color: 'var(--text-muted)', fontSize: '0.85rem' }}>
                            loading keys...
                        </div>
                    ) : !effectiveAccountObjectId ? (
                        <div className="dashboard-empty-message" style={{ textAlign: 'center', padding: '20px 0', color: 'var(--text-muted)', fontSize: '0.85rem' }}>
                            no Walrus Memory account found for this wallet. create a delegate key to get started.
                        </div>
                    ) : onChainKeys.length === 0 ? (
                        <div className="dashboard-empty-message" style={{ textAlign: 'center', padding: '20px 0', color: 'var(--text-muted)', fontSize: '0.85rem' }}>
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
                <div className="card dashboard-quickstart-card" style={{ marginBottom: 24 }}>
                    <div className="card-header">
                        <div>
                            <div className="card-title">Quickstart — SDK</div>
                            <div className="card-subtitle">Use the Walrus Memory SDK to remember and recall</div>
                        </div>
                        <div className="dashboard-quickstart-toggle" role="tablist" aria-label="SDK language">
                            {(['ts', 'py'] as const).map((language) => (
                                <button
                                    key={language}
                                    type="button"
                                    role="tab"
                                    aria-selected={quickstartLanguage === language}
                                    className={quickstartLanguage === language ? 'dashboard-quickstart-toggle-active' : ''}
                                    onClick={() => setQuickstartLanguage(language)}
                                >
                                    {language}
                                </button>
                            ))}
                        </div>
                    </div>
                    <div className="dashboard-quickstart-codewrap">
                        <button
                            className="btn btn-secondary btn-sm dashboard-quickstart-copy"
                            onClick={() => copyToClipboard(sdkSnippet, sdkCopyLabel)}
                            aria-label="Copy SDK snippet"
                        >
                            <Copy size={14} />
                            <span className="dashboard-quickstart-copy-label">{copied === sdkCopyLabel ? 'done' : 'copy'}</span>
                        </button>
                        <SyntaxHighlighter language={sdkSnippetLanguage} style={walrusCodeTheme} className="demo-code-block" customStyle={{ margin: 0, padding: 28, background: '#050505', color: '#faf8f5' }}>
                            {sdkSnippet}
                        </SyntaxHighlighter>
                    </div>
                </div>

                {/* Install */}
                <div className="card dashboard-install-card" style={{ marginBottom: 40 }}>
                    <div className="card-header">
                        <div><div className="card-title">Install</div></div>
                    </div>
                    <div className="install-tabs">
                        {(['npm', 'pnpm', 'yarn', 'bun'] as const).map((pm) => (
                            <button
                                key={pm}
                                className={`install-tab${pkgManager === pm ? ' install-tab--active' : ''}`}
                                onClick={() => {
                                    trackEvent('sdk_install_tab_selected', { package_manager: pm, location: 'dashboard' })
                                    setPkgManager(pm)
                                }}
                            >
                                {pm}
                            </button>
                        ))}
                    </div>
                    <SyntaxHighlighter language="bash" style={githubGist} className="demo-code-block install-command" customStyle={{ margin: 0, padding: 0, background: '#000000', color: '#faf8f5' }}>
                        {pkgManager === 'npm' ? 'npm install @mysten-incubation/memwal' :
                         pkgManager === 'pnpm' ? 'pnpm add @mysten-incubation/memwal' :
                         pkgManager === 'yarn' ? 'yarn add @mysten-incubation/memwal' :
                         'bun add @mysten-incubation/memwal'}
                    </SyntaxHighlighter>
                </div>
            </main>
        </div>
    )
}
