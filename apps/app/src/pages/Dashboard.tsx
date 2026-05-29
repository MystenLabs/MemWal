/**
 * Dashboard — Account info, delegate keys management, SDK integration guide
 */

import { useState, useCallback, useEffect, useMemo, useRef, type SVGProps } from 'react'
import {
    useCurrentAccount,
    useDisconnectWallet,
    useSignPersonalMessage,
    useSuiClient,
} from '@mysten/dapp-kit'
import { Transaction } from '@mysten/sui/transactions'
import { useSponsoredTransaction } from '../hooks/useSponsoredTransaction'
import { generateDelegateKey, addDelegateKey } from '@mysten-incubation/memwal/account'
import type { WalletSigner } from '@mysten-incubation/memwal/manual'
import { Link, useNavigate } from 'react-router-dom'
import { TriangleAlert, Copy, Eye, EyeOff, Trash2, RefreshCw, Plus, LogOut, Github, MessageCircle } from 'lucide-react'
import { Light as SyntaxHighlighter } from 'react-syntax-highlighter'
import js from 'react-syntax-highlighter/dist/esm/languages/hljs/javascript'
import python from 'react-syntax-highlighter/dist/esm/languages/hljs/python'

SyntaxHighlighter.registerLanguage('javascript', js)
SyntaxHighlighter.registerLanguage('python', python)
import { useDelegateKey } from '../App'
import { Card } from '../components/Card'
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
        color: '#e8ff75',
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
const MAX_DELEGATE_KEYS_MESSAGE = 'This wallet already has 20 delegate keys. Remove an old key before creating a new delegate key.'
const SDK_DEFAULT_SERVER_URL = 'https://relayer.memwal.ai'
const PRIVATE_KEY_ENV = 'MEMWAL_PRIVATE_KEY'
const ACCOUNT_ID_ENV = 'MEMWAL_ACCOUNT_ID'
const SERVER_URL_ENV = 'MEMWAL_SERVER_URL'
type QuickstartLanguage = 'ts' | 'py'
type RemoveKeysConfirmState = {
    publicKeys: string[]
    source: 'single' | 'selection'
}

function bytesToHex(bytes: Uint8Array | number[]): string {
    return Array.from(bytes).map((b) => b.toString(16).padStart(2, '0')).join('')
}

function hexToByteArray(hex: string): number[] {
    const normalized = hex.startsWith('0x') ? hex.slice(2) : hex
    if (!/^[0-9a-fA-F]{64}$/.test(normalized)) {
        throw new Error('invalid delegate public key')
    }

    return Array.from({ length: normalized.length / 2 }, (_, i) =>
        parseInt(normalized.slice(i * 2, i * 2 + 2), 16)
    )
}

function compactPublicKey(publicKey: string): string {
    const normalized = publicKey.startsWith('0x') ? publicKey.slice(2) : publicKey
    if (normalized.length <= 24) return publicKey
    return `${normalized.slice(0, 12)}...${normalized.slice(-8)}`
}

function DelegateKeySkeletonList() {
    return (
        <div className="dashboard-key-table-wrap dashboard-key-list--skeleton" aria-hidden="true">
            <table className="dashboard-key-table">
                <thead>
                    <tr>
                        <th scope="col" className="dashboard-key-table-select">Select</th>
                        <th scope="col">Key name</th>
                        <th scope="col">Public key</th>
                        <th scope="col">Created</th>
                        <th scope="col" className="dashboard-key-table-actions">Actions</th>
                    </tr>
                </thead>
                <tbody>
                    {[0, 1].map((index) => (
                        <tr key={index}>
                            <td><span className="dashboard-key-skeleton-line dashboard-key-skeleton-line--check" /></td>
                            <td><span className="dashboard-key-skeleton-line dashboard-key-skeleton-line--label" /></td>
                            <td><span className="dashboard-key-skeleton-line dashboard-key-skeleton-line--value" /></td>
                            <td><span className="dashboard-key-skeleton-line dashboard-key-skeleton-line--date" /></td>
                            <td><span className="dashboard-key-skeleton-line dashboard-key-skeleton-line--actions" /></td>
                        </tr>
                    ))}
                </tbody>
            </table>
        </div>
    )
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
    const navigate = useNavigate()
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
    const shouldResolveAccount = Boolean(address && !previewMode && !accountObjectId)
    const [accountLookupAddress, setAccountLookupAddress] = useState(address)
    const [accountLookupComplete, setAccountLookupComplete] = useState(!shouldResolveAccount)
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
    const [removingSelectedKeys, setRemovingSelectedKeys] = useState(false)
    const [removeKeysConfirm, setRemoveKeysConfirm] = useState<RemoveKeysConfirmState | null>(null)
    const [selectedKeyPublicKeys, setSelectedKeyPublicKeys] = useState<string[]>([])
    const [showAddForm, setShowAddForm] = useState(false)
    const [addKeyFormClosing, setAddKeyFormClosing] = useState(false)
    const [newKeyLabel, setNewKeyLabel] = useState('New key')
    const [keyError, setKeyError] = useState('')
    const [newPrivateKey, setNewPrivateKey] = useState<string | null>(null)
    const addKeyFormCloseTimerRef = useRef<number | null>(null)

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
        navigate('/')
    }, [clearDelegateKeys, disconnect, navigate])

    const openAddKeyForm = useCallback(() => {
        if (addKeyFormCloseTimerRef.current !== null) {
            window.clearTimeout(addKeyFormCloseTimerRef.current)
            addKeyFormCloseTimerRef.current = null
        }
        setAddKeyFormClosing(false)
        setShowAddForm(true)
    }, [])

    const closeAddKeyForm = useCallback(() => {
        setKeyError('')
        setAddKeyFormClosing(true)
        if (addKeyFormCloseTimerRef.current !== null) {
            window.clearTimeout(addKeyFormCloseTimerRef.current)
        }
        addKeyFormCloseTimerRef.current = window.setTimeout(() => {
            setShowAddForm(false)
            setAddKeyFormClosing(false)
            addKeyFormCloseTimerRef.current = null
        }, 260)
    }, [])

    useEffect(() => {
        return () => {
            if (addKeyFormCloseTimerRef.current !== null) {
                window.clearTimeout(addKeyFormCloseTimerRef.current)
            }
        }
    }, [])

    const fetchAccountObjectId = useCallback(async () => {
        if (!address || previewMode) {
            setResolvedAccountObjectId(null)
            setAccountLookupAddress(address)
            setAccountLookupComplete(true)
            setLoadingAccount(false)
            return
        }
        if (accountObjectId) {
            setResolvedAccountObjectId(accountObjectId)
            setAccountLookupAddress(address)
            setAccountLookupComplete(true)
            setLoadingAccount(false)
            return
        }
        setResolvedAccountObjectId(null)
        setAccountLookupComplete(false)
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
            setAccountLookupAddress(address)
            setAccountLookupComplete(true)
            setLoadingAccount(false)
        }
    }, [address, accountObjectId, previewMode, suiClient])

    useEffect(() => {
        setResolvedAccountObjectId(accountObjectId)
        if (accountObjectId) {
            setAccountLookupAddress(address)
            setAccountLookupComplete(true)
        }
    }, [accountObjectId, address])

    useEffect(() => {
        fetchAccountObjectId()
    }, [fetchAccountObjectId])

    const hasResolvedAccount = Boolean(effectiveAccountObjectId)
    const accountLookupPending = loadingAccount || (shouldResolveAccount && (!accountLookupComplete || accountLookupAddress !== address))
    const isRecoveringExistingAccount = !delegateKey && hasResolvedAccount && !previewReady
    const isNewAccount = !delegateKey && accountLookupComplete && !hasResolvedAccount
    const activeEnvironmentLabel = config.suiNetwork === 'mainnet'
        ? 'production / mainnet'
        : 'staging / testnet'
    const expectedRelayerUrl = config.suiNetwork === 'mainnet'
        ? 'https://relayer.memwal.ai'
        : 'https://relayer.memwal.ai'
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
        ? 'Manage your Walrus Memory account and delegate keys'
        : accountLookupPending
            ? 'Checking your Walrus Memory account...'
            : hasResolvedAccount
                ? 'Manage your Walrus Memory account and delegate keys in one place'
                : 'Manage your Walrus Memory account and delegate keys'
    const showDashboardSubtitle = Boolean(dashboardSubtitle)
    const hasMaxDelegateKeys = onChainKeys.length >= MAX_DELEGATE_KEYS
    const isKeyListLoading = accountLookupPending || (loadingKeys && onChainKeys.length === 0)
    const isKeyListRefreshing = loadingKeys && onChainKeys.length > 0
    const selectableKeyPublicKeys = useMemo(() => onChainKeys.map((key) => key.publicKey), [onChainKeys])
    const selectedKeySet = useMemo(() => new Set(selectedKeyPublicKeys), [selectedKeyPublicKeys])
    const selectedKeyCount = selectedKeyPublicKeys.length
    const keyRemovalBusy = removingSelectedKeys || Boolean(removingKey)
    const showKeySelectionControls = Boolean(effectiveAccountObjectId) && selectedKeyCount > 0 && !accountLookupPending

    useEffect(() => {
        setSelectedKeyPublicKeys((prev) => {
            const next = prev.filter((publicKey) => selectableKeyPublicKeys.includes(publicKey))
            return next.length === prev.length ? prev : next
        })
    }, [selectableKeyPublicKeys])

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
            closeAddKeyForm()
            setNewKeyLabel('New key')

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
    }, [
        walletSigner,
        hasMaxDelegateKeys,
        effectiveAccountObjectId,
        newKeyLabel,
        suiClient,
        fetchOnChainKeys,
        setDelegateKeys,
        closeAddKeyForm,
    ])

    // ============================================================
    // Remove delegate keys
    // ============================================================

    const removeDelegateKeysInTransaction = useCallback(async (publicKeyHexes: string[]) => {
        if (!walletSigner || !effectiveAccountObjectId) return

        const tx = new Transaction()
        for (const publicKeyHex of publicKeyHexes) {
            tx.moveCall({
                target: `${config.memwalPackageId}::account::remove_delegate_key`,
                arguments: [
                    tx.object(effectiveAccountObjectId),
                    tx.pure('vector<u8>', hexToByteArray(publicKeyHex)),
                ],
            })
        }

        const result = await signAndExecuteTx({ transaction: tx })
        await suiClient.waitForTransaction({
            digest: result.digest,
            options: { showEffects: true, showObjectChanges: true },
        })
    }, [walletSigner, effectiveAccountObjectId, signAndExecuteTx, suiClient])

    const executeRemoveKeys = useCallback(async (publicKeyHexes: string[], source: RemoveKeysConfirmState['source']) => {
        if (!walletSigner || !effectiveAccountObjectId || publicKeyHexes.length === 0) return

        const isSelectionRemoval = source === 'selection'
        if (isSelectionRemoval) {
            setRemovingSelectedKeys(true)
        } else {
            setRemovingKey(publicKeyHexes[0])
        }
        setKeyError('')
        setNewPrivateKey(null)

        const removeEventPayload = isSelectionRemoval
            ? { location: 'dashboard', selected_count: publicKeyHexes.length }
            : { location: 'dashboard' }

        trackEvent('delegate_key_remove_start', removeEventPayload)
        try {
            await removeDelegateKeysInTransaction(publicKeyHexes)

            if (delegatePublicKey && publicKeyHexes.includes(delegatePublicKey)) {
                clearDelegateKeys()
            }

            setSelectedKeyPublicKeys((prev) =>
                isSelectionRemoval
                    ? []
                    : prev.filter((key) => key !== publicKeyHexes[0])
            )
            await fetchOnChainKeys()
            trackEvent('delegate_key_remove_complete', removeEventPayload)
        } catch (err: unknown) {
            const msg = err instanceof Error
                ? err.message
                : isSelectionRemoval
                    ? 'failed to remove selected keys'
                    : 'failed to remove key'
            setKeyError(msg)
            trackEvent('delegate_key_remove_failed', { error_type: getAnalyticsErrorType(err) })
        } finally {
            if (isSelectionRemoval) {
                setRemovingSelectedKeys(false)
            } else {
                setRemovingKey(null)
            }
        }
    }, [
        walletSigner,
        effectiveAccountObjectId,
        removeDelegateKeysInTransaction,
        delegatePublicKey,
        clearDelegateKeys,
        fetchOnChainKeys,
    ])

    const handleRemoveKey = useCallback((publicKeyHex: string) => {
        if (!walletSigner || !effectiveAccountObjectId) return
        setRemoveKeysConfirm({ publicKeys: [publicKeyHex], source: 'single' })
    }, [walletSigner, effectiveAccountObjectId])

    const toggleKeySelection = useCallback((publicKeyHex: string) => {
        setSelectedKeyPublicKeys((prev) =>
            prev.includes(publicKeyHex)
                ? prev.filter((key) => key !== publicKeyHex)
                : [...prev, publicKeyHex]
        )
    }, [])

    const clearSelectedKeys = useCallback(() => {
        setSelectedKeyPublicKeys([])
    }, [])

    const handleRemoveSelectedKeys = useCallback(() => {
        if (!walletSigner || !effectiveAccountObjectId || selectedKeyPublicKeys.length === 0) return

        const keysToRemove = selectedKeyPublicKeys.filter((publicKey) => selectableKeyPublicKeys.includes(publicKey))
        if (keysToRemove.length === 0) {
            setSelectedKeyPublicKeys([])
            return
        }

        setRemoveKeysConfirm({ publicKeys: keysToRemove, source: 'selection' })
    }, [
        walletSigner,
        effectiveAccountObjectId,
        selectedKeyPublicKeys,
        selectableKeyPublicKeys,
    ])

    const confirmRemoveKeys = useCallback(async () => {
        if (!removeKeysConfirm) return

        await executeRemoveKeys(removeKeysConfirm.publicKeys, removeKeysConfirm.source)
        setRemoveKeysConfirm(null)
    }, [executeRemoveKeys, removeKeysConfirm])

    useEffect(() => {
        if (!removeKeysConfirm || keyRemovalBusy) return undefined

        const closeOnEscape = (event: KeyboardEvent) => {
            if (event.key === 'Escape') {
                setRemoveKeysConfirm(null)
            }
        }

        window.addEventListener('keydown', closeOnEscape)
        return () => window.removeEventListener('keydown', closeOnEscape)
    }, [keyRemovalBusy, removeKeysConfirm])

    const removeConfirmCount = removeKeysConfirm?.publicKeys.length ?? 0
    const removeConfirmBusy = removeKeysConfirm
        ? removeKeysConfirm.source === 'selection'
            ? removingSelectedKeys
            : removingKey === removeKeysConfirm.publicKeys[0]
        : false
    const removeConfirmTitle = removeConfirmCount === 1
        ? 'Remove delegate key?'
        : `Remove ${removeConfirmCount} delegate keys?`
    const removeConfirmDescription = removeConfirmCount === 1
        ? 'This key will be removed from your Walrus Memory account. This cannot be undone.'
        : `${removeConfirmCount} selected keys will be removed from your Walrus Memory account. This cannot be undone.`

    // ============================================================
    // SDK code snippets
    // ============================================================

    // Never render any portion (prefix/suffix) of the real private key
    // in DOM / copyable snippets. Use a static placeholder instead.
    const PRIVATE_KEY_PLACEHOLDER = '<YOUR_PRIVATE_KEY>'
    const ACCOUNT_ID_PLACEHOLDER = '<YOUR_ACCOUNT_ID>'

    const sdkTypeScriptSnippet = `import { MemWal } from "@mysten-incubation/memwal"

const memwal = MemWal.create({
  key: process.env.${PRIVATE_KEY_ENV} ?? "${PRIVATE_KEY_PLACEHOLDER}",
  accountId: process.env.${ACCOUNT_ID_ENV} ?? "${effectiveAccountObjectId ?? ACCOUNT_ID_PLACEHOLDER}",
  serverUrl: process.env.${SERVER_URL_ENV} ?? "${SDK_DEFAULT_SERVER_URL}",
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
        key=os.environ["${PRIVATE_KEY_ENV}"],
        account_id=os.environ["${ACCOUNT_ID_ENV}"],
        server_url=os.environ.get("${SERVER_URL_ENV}", "${SDK_DEFAULT_SERVER_URL}"),
    )

    await memwal.remember_and_wait("I'm allergic to peanuts")

    result = await memwal.recall("food allergies")
    print(result.results[0].text)

    await memwal.close()

asyncio.run(main())`

    const sdkSnippet = quickstartLanguage === 'py' ? sdkPythonSnippet : sdkTypeScriptSnippet
    const sdkSnippetLanguage = quickstartLanguage === 'py' ? 'python' : 'javascript'
    const sdkCopyLabel = `sdk-${quickstartLanguage}`

    const aiSnippet = `import { generateText } from "ai"
import { withMemWal } from "@mysten-incubation/memwal/ai"
import { openai } from "@ai-sdk/openai"

const model = withMemWal(openai("gpt-4o"), {
  key: process.env.${PRIVATE_KEY_ENV} ?? "${PRIVATE_KEY_PLACEHOLDER}",
  accountId: process.env.${ACCOUNT_ID_ENV} ?? "${effectiveAccountObjectId ?? ACCOUNT_ID_PLACEHOLDER}",
  serverUrl: process.env.${SERVER_URL_ENV} ?? "${SDK_DEFAULT_SERVER_URL}",
})

const result = await generateText({
  model,
  messages: [
    { role: "user", content: "What foods should I avoid?" }
  ]
})
// → LLM knows: "User is allergic to peanuts"`
    const docsHref = config.docsUrl || 'https://docs.memwal.ai'
    const githubHref = 'https://github.com/MystenLabs/memwal'
    const discordHref = 'https://discord.gg/walrusprotocol'
    const installCommand = pkgManager === 'npm' ? 'npm install @mysten-incubation/memwal' :
        pkgManager === 'pnpm' ? 'pnpm add @mysten-incubation/memwal' :
        pkgManager === 'yarn' ? 'yarn add @mysten-incubation/memwal' :
        'bun add @mysten-incubation/memwal'
    const installCopyLabel = `install-${pkgManager}`

    return (
        <div className="dash-page">
            <nav className="nav playground-nav dashboard-nav">
                <div className="nav-inner">
                    <Link to="/" className="nav-brand">
                        <img className="nav-brand-logo" src="/walrus-memory-logo.svg" alt="Walrus Memory" />
                    </Link>
                    <div className="nav-user">
                        <span className="nav-address">
                            {address.slice(0, 6)}...{address.slice(-4)}
                        </span>
                        <button className="lp-nav-cta" onClick={handleLogout}>
                            Sign out <LogOut size={14} />
                        </button>
                    </div>
                </div>
            </nav>

            <main className="dash-shell">
                {/* Header */}
                <div className={`dashboard-header${showDashboardSubtitle ? '' : ' dashboard-header--compact'}`}>
                    <h2>Welcome to your Dashboard</h2>
                    {showDashboardSubtitle && <p>{dashboardSubtitle}</p>}
                </div>

                {isRecoveringExistingAccount && (
                    <div className="dash-alert" style={{ marginBottom: 24 }}>
                        <TriangleAlert className="dash-alert-icon" size={24} strokeWidth={2.3} aria-hidden="true" />
                        <p>
                            Your Walrus Memory account is active, but this browser has no saved delegate key. Create a new key to continue, or revoke an old one below.
                        </p>
                    </div>
                )}

                {isNewAccount && (
                    <div className="dash-alert" style={{ marginBottom: 24 }}>
                        <TriangleAlert className="dash-alert-icon" size={24} strokeWidth={2.3} aria-hidden="true" />
                        <p>
                            No Walrus Memory account found for this wallet. Create a delegate key to get started.
                        </p>
                    </div>
                )}

                {hasMaxDelegateKeys && (
                    <div className="dash-alert" style={{ marginBottom: 24 }}>
                        <TriangleAlert className="dash-alert-icon" size={24} strokeWidth={2.3} aria-hidden="true" />
                        <p>{MAX_DELEGATE_KEYS_MESSAGE}</p>
                    </div>
                )}

                {/* Action CTAs */}
                <div className="dashboard-cta-row dashboard-cta-row--primary">
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
                                <div className="dashboard-cta-title">Developer playground</div>
                                <div className="dashboard-cta-subtitle">Test memory features with your current setup.</div>
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
                    <a
                        href={docsHref}
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
                            <div className="dashboard-cta-subtitle">Guides, examples & API references</div>
                        </div>
                        <CtaArrowIcon className="dashboard-cta-arrow" />
                    </a>
                </div>

                {/* Resources */}
                <div className="dashboard-section-head">
                    <h3>Resources</h3>
                    <p>Quick links for setup, development, and support.</p>
                </div>
                <div className="dashboard-cta-row dashboard-cta-row--resources">
                    <a
                        href={githubHref}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="dashboard-cta"
                        onClick={() => trackEvent('outbound_link_click', { link: 'github', location: 'dashboard' })}
                    >
                        <span className="dashboard-cta-icon-wrap" aria-hidden="true">
                            <Github className="dashboard-cta-icon" />
                        </span>
                        <div className="dashboard-cta-text">
                            <div className="dashboard-cta-title">GitHub</div>
                            <div className="dashboard-cta-subtitle">Explore SDK source code and releases</div>
                        </div>
                        <CtaArrowIcon className="dashboard-cta-arrow" />
                    </a>
                    <a
                        href={discordHref}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="dashboard-cta"
                        onClick={() => trackEvent('outbound_link_click', { link: 'discord', location: 'dashboard' })}
                    >
                        <span className="dashboard-cta-icon-wrap" aria-hidden="true">
                            <MessageCircle className="dashboard-cta-icon" />
                        </span>
                        <div className="dashboard-cta-text">
                            <div className="dashboard-cta-title">Discord</div>
                            <div className="dashboard-cta-subtitle">Get help from the community</div>
                        </div>
                        <CtaArrowIcon className="dashboard-cta-arrow" />
                    </a>
                </div>


                {/* Current Delegate Key */}
                {delegateKey && (
                    <Card
                        className="dashboard-credentials-card"
                        title="SDK credentials"
                        subtitle={`Copy the delegate private key into server env as ${PRIVATE_KEY_ENV}`}
                    >

                    <div className="dashboard-credentials-alert">
                        <TriangleAlert className="dashboard-credentials-alert-icon" size={24} strokeWidth={2.3} aria-hidden="true" />
                        <div className="dashboard-credentials-alert-copy">
                            <p>
                                <strong>{activeEnvironmentLabel}</strong>
                                <span>Configured relayer: <code>{config.memwalServerUrl}</code> ({relayerEnvironmentLabel}).</span>
                                <span>Expected relayer: <code>{expectedRelayerUrl}</code>.</span>
                            </p>
                            {relayerLooksMismatched && (
                                <p>
                                    This dashboard network and relayer URL look mismatched; API calls may fail with 401.
                                </p>
                            )}
                        </div>
                    </div>

                    <div className="dashboard-credentials-panel">
                        {effectiveAccountObjectId && (
                            <div className="dashboard-credential-row">
                                <div className="dashboard-credential-main">
                                    <div className="dashboard-credential-label">
                                        Account ID <span>{ACCOUNT_ID_ENV}</span>
                                    </div>
                                    <code className="dashboard-credential-value">{effectiveAccountObjectId}</code>
                                </div>
                                <div className="dashboard-credential-actions">
                                    <button
                                        type="button"
                                        className={`dashboard-credential-icon-button${copied === 'acct' ? ' dashboard-credential-icon-button--copied' : ''}`}
                                        onClick={() => copyToClipboard(effectiveAccountObjectId, 'acct')}
                                        aria-label="Copy account ID"
                                        title={copied === 'acct' ? 'Copied' : 'Copy account ID'}
                                    >
                                        <Copy size={14} />
                                    </button>
                                </div>
                            </div>
                        )}

                        <div className="dashboard-credential-row">
                            <div className="dashboard-credential-main">
                                <div className="dashboard-credential-label">
                                    Relayer URL <span>{SERVER_URL_ENV}</span>
                                </div>
                                <code className="dashboard-credential-value">{config.memwalServerUrl}</code>
                            </div>
                            <div className="dashboard-credential-actions">
                                <button
                                    type="button"
                                    className={`dashboard-credential-icon-button${copied === 'server-env' ? ' dashboard-credential-icon-button--copied' : ''}`}
                                    onClick={() => copyToClipboard(`${SERVER_URL_ENV}=${config.memwalServerUrl}`, 'server-env')}
                                    aria-label="Copy relayer URL env line"
                                    title={copied === 'server-env' ? 'Copied' : 'Copy env line'}
                                >
                                    <Copy size={14} />
                                </button>
                            </div>
                        </div>

                        <div className="dashboard-credential-row">
                            <div className="dashboard-credential-main">
                                <div className="dashboard-credential-label">Delegate public key</div>
                                <code className="dashboard-credential-value">{delegatePublicKey}</code>
                            </div>
                            <div className="dashboard-credential-actions">
                                <button
                                    type="button"
                                    className={`dashboard-credential-icon-button${copied === 'pub' ? ' dashboard-credential-icon-button--copied' : ''}`}
                                    onClick={() => copyToClipboard(delegatePublicKey!, 'pub')}
                                    aria-label="Copy delegate public key"
                                    title={copied === 'pub' ? 'Copied' : 'Copy public key'}
                                >
                                    <Copy size={14} />
                                </button>
                            </div>
                        </div>

                        <div className="dashboard-credential-row">
                            <div className="dashboard-credential-main">
                                <div className="dashboard-credential-label">
                                    Delegate private key <span>{PRIVATE_KEY_ENV}</span>
                                </div>
                                <code className="dashboard-credential-value">
                                    {showKey ? delegateKey : '•'.repeat(48)}
                                </code>
                            </div>
                            <div className="dashboard-credential-actions">
                                {showKey && (
                                    <>
                                        <button
                                            type="button"
                                            className={`dashboard-credential-icon-button${copied === 'priv' ? ' dashboard-credential-icon-button--copied' : ''}`}
                                            onClick={() => copyToClipboard(delegateKey!, 'priv')}
                                            aria-label="Copy delegate private key"
                                            title={copied === 'priv' ? 'Copied' : 'Copy private key'}
                                        >
                                            <Copy size={14} />
                                        </button>
                                    </>
                                )}
                                <button
                                    type="button"
                                    className="dashboard-credential-icon-button"
                                    onClick={() => setShowKey((value) => !value)}
                                    aria-label={showKey ? 'Hide delegate private key' : 'Reveal delegate private key'}
                                    title={showKey ? 'Hide private key' : 'Reveal private key'}
                                >
                                    {showKey ? <EyeOff size={14} /> : <Eye size={14} />}
                                </button>
                            </div>
                        </div>
                    </div>
                    </Card>
                )}

                {/* On-Chain Delegate Keys Management */}
                <Card
                    className={`dashboard-keys-card${isKeyListRefreshing ? ' dashboard-keys-card--refreshing' : ''}`}
                    title="Delegate keys"
                    subtitle="All keys registered to your Walrus Memory account"
                    action={
                        <div className="card-header-actions">
                            <button
                                className="btn btn-secondary btn-sm dashboard-keys-refresh"
                                onClick={fetchOnChainKeys}
                                disabled={loadingKeys || accountLookupPending}
                                aria-busy={loadingKeys || accountLookupPending}
                            >
                                <RefreshCw size={12} /> Refresh
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
                                    openAddKeyForm()
                                }}
                                disabled={showAddForm || addingKey || accountLookupPending || !effectiveAccountObjectId || hasMaxDelegateKeys}
                            >
                                Add key <Plus size={18} strokeWidth={2.5} aria-hidden="true" />
                            </button>
                        </div>
                    }
                >

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
                        <div className="dashboard-key-ready-block">
                            <div className="warning-box dashboard-key-ready-warning">
                                <TriangleAlert className="dashboard-key-ready-warning-icon" size={24} strokeWidth={2.3} aria-hidden="true" />
                                <p>
                                    <strong>Your delegate key is ready.</strong> Save this key now. For your security,
                                    we won't show it again. You'll need the key to configure the Walrus Memory SDK.
                                </p>
                            </div>
                            <div className="key-display key-display--white dashboard-key-ready-display">
                                <div className="key-label">Delegate private key</div>
                                <div className="key-value">{newPrivateKey}</div>
                                <div className="key-actions">
                                    <button
                                        className="btn btn-secondary btn-sm"
                                        onClick={() => copyToClipboard(newPrivateKey, 'new-priv')}
                                    >
                                        <Copy size={12} /> {copied === 'new-priv' ? 'Copied' : 'Copy private key'}
                                    </button>
                                    <button
                                        className="btn btn-secondary btn-sm"
                                        onClick={() => setNewPrivateKey(null)}
                                    >
                                        Continue
                                    </button>
                                </div>
                            </div>
                        </div>
                    )}

                    {/* Add Key Form */}
                    {showAddForm && (
                        <div className={`dashboard-add-key-form${addKeyFormClosing ? ' dashboard-add-key-form--closing' : ''}`}>
                            <div className="dashboard-add-key-field">
                                <label className="dashboard-add-key-label">
                                    Key name
                                </label>
                                <input
                                    className="dashboard-add-key-input"
                                    type="text"
                                    value={newKeyLabel}
                                    maxLength={64}
                                    onChange={(e) =>
                                        // strip HTML special chars and control characters on every keystroke
                                        setNewKeyLabel(sanitizeLabel(e.target.value))
                                    }
                                    placeholder="New key"
                                />
                            </div>
                            <p className="dashboard-add-key-note">
                                A new keypair will be created, and the private key will be copied to your clipboard.
                                Save it somewhere secure — it can't be shown again.
                            </p>
                            <div className="dashboard-add-key-actions">
                                <button
                                    className="btn btn-secondary btn-sm dashboard-add-key-cancel"
                                    onClick={closeAddKeyForm}
                                    disabled={addingKey}
                                >
                                    Cancel
                                </button>
                                <button
                                    className="btn btn-primary btn-sm dashboard-add-key-create"
                                    onClick={handleAddKey}
                                    disabled={addingKey || hasMaxDelegateKeys || accountLookupPending || !effectiveAccountObjectId}
                                    aria-busy={addingKey}
                                >
                                    {addingKey ? 'Creating...' : 'Create'}
                                </button>
                            </div>
                        </div>
                    )}

                    {showKeySelectionControls && (
                        <div className="dashboard-key-selection-bar">
                            <span className="dashboard-key-selection-status">
                                {selectedKeyCount} selected
                            </span>
                            <div className="dashboard-key-bulk-actions">
                                <button
                                    type="button"
                                    className="btn btn-secondary btn-sm dashboard-key-clear-selection"
                                    onClick={clearSelectedKeys}
                                    disabled={keyRemovalBusy}
                                >
                                    Clear
                                </button>
                                <button
                                    type="button"
                                    className="btn btn-danger btn-sm dashboard-key-remove-selected"
                                    onClick={handleRemoveSelectedKeys}
                                    disabled={keyRemovalBusy}
                                >
                                    <Trash2 size={12} />
                                    {removingSelectedKeys ? 'Removing...' : 'Remove selected'}
                                </button>
                            </div>
                        </div>
                    )}

                    {/* Key List */}
                    {isKeyListLoading ? (
                        <DelegateKeySkeletonList />
                    ) : !effectiveAccountObjectId ? (
                        <div className="dashboard-empty-message dashboard-empty-message--account">
                            <span>No keys yet. </span>
                            <button type="button" className="dashboard-empty-message-link" onClick={() => navigate('/setup')}>Create one</button>
                            <span> to connect to Walrus Memory</span>
                        </div>
                    ) : onChainKeys.length === 0 ? (
                        <div className="dashboard-empty-message dashboard-empty-message--account">
                            <span>No keys yet. </span>
                            <button type="button" className="dashboard-empty-message-link" onClick={() => navigate('/setup')}>Create one</button>
                            <span> to connect to Walrus Memory</span>
                        </div>
                    ) : (
                        <div className={`dashboard-key-table-wrap${isKeyListRefreshing ? ' dashboard-key-list--busy' : ''}`}>
                            <table className="dashboard-key-table">
                                <thead>
                                    <tr>
                                        <th scope="col" className="dashboard-key-table-select">Select</th>
                                        <th scope="col">Key name</th>
                                        <th scope="col">Public key</th>
                                        <th scope="col">Created</th>
                                        <th scope="col" className="dashboard-key-table-actions">Actions</th>
                                    </tr>
                                </thead>
                                <tbody>
                                    {onChainKeys.map((k) => {
                                        const isCurrentKey = k.publicKey === delegatePublicKey
                                        const isRemoving = removingKey === k.publicKey
                                        const isSelected = selectedKeySet.has(k.publicKey)
                                        const copyPublicKeyLabel = `pk-${k.publicKey.slice(0,8)}`
                                        return (
                                            <tr
                                                key={k.publicKey}
                                                className={`dashboard-key-row${isSelected ? ' dashboard-key-row--selected' : ''}`}
                                            >
                                                <td data-label="Select" className="dashboard-key-cell-select">
                                                    <label className="dashboard-key-checkbox" aria-label={`Select ${k.label || 'delegate key'}`}>
                                                        <input
                                                            type="checkbox"
                                                            checked={isSelected}
                                                            onChange={() => toggleKeySelection(k.publicKey)}
                                                            disabled={keyRemovalBusy}
                                                        />
                                                        <span className="dashboard-key-checkbox-box" aria-hidden="true" />
                                                    </label>
                                                </td>
                                                <td data-label="Key name">
                                                    <div className="dashboard-key-name">
                                                        <span>{k.label || 'Untitled'}</span>
                                                        {isCurrentKey && <span className="dashboard-key-current-badge">current</span>}
                                                    </div>
                                                </td>
                                                <td data-label="Public key">
                                                    <code className="dashboard-key-public" title={k.publicKey}>
                                                        {compactPublicKey(k.publicKey)}
                                                    </code>
                                                </td>
                                                <td data-label="Created" className="dashboard-key-created">
                                                    {new Date(k.createdAt).toLocaleDateString()}
                                                </td>
                                                <td data-label="Actions" className="dashboard-key-row-actions">
                                                    <div className="dashboard-key-actions">
                                                        <button
                                                            className={`btn btn-secondary btn-sm dashboard-key-icon-action${copied === copyPublicKeyLabel ? ' dashboard-key-icon-action--copied' : ''}`}
                                                            onClick={() => copyToClipboard(k.publicKey, copyPublicKeyLabel)}
                                                            aria-label={copied === copyPublicKeyLabel ? 'Public key copied' : 'Copy public key'}
                                                            title={copied === copyPublicKeyLabel ? 'Copied' : 'Copy public key'}
                                                        >
                                                            <Copy size={14} />
                                                        </button>
                                                        <button
                                                            className="btn btn-danger btn-sm dashboard-key-icon-action"
                                                            onClick={() => handleRemoveKey(k.publicKey)}
                                                            disabled={keyRemovalBusy}
                                                            aria-busy={isRemoving}
                                                            aria-label={isRemoving ? 'Removing delegate key' : 'Remove delegate key'}
                                                            title={isRemoving ? 'Removing' : 'Remove delegate key'}
                                                        >
                                                            <Trash2 size={14} />
                                                        </button>
                                                    </div>
                                                </td>
                                            </tr>
                                        )
                                    })}
                                </tbody>
                            </table>
                        </div>
                    )}
                </Card>

                {/* Quick Start: SDK */}
                <Card
                    className="dashboard-quickstart-card"
                    title="Quickstart — SDK"
                    subtitle="Copy the setup code and start in minutes"
                    action={
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
                    }
                >
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
                </Card>

                {/* Quick Start: AI SDK */}
                <Card
                    className="dashboard-quickstart-card"
                    title="AI SDK integration"
                    subtitle="Wrap your model with Walrus Memory using the AI SDK"
                >
                    <div className="dashboard-quickstart-codewrap">
                        <button
                            className="btn btn-secondary btn-sm dashboard-quickstart-copy"
                            onClick={() => copyToClipboard(aiSnippet, 'ai')}
                            aria-label="Copy AI SDK snippet"
                        >
                            <Copy size={14} />
                            <span className="dashboard-quickstart-copy-label">{copied === 'ai' ? 'done' : 'copy'}</span>
                        </button>
                        <SyntaxHighlighter language="javascript" style={walrusCodeTheme} className="demo-code-block" customStyle={{ margin: 0, padding: 28, background: '#050505', color: '#faf8f5' }}>
                            {aiSnippet}
                        </SyntaxHighlighter>
                    </div>
                </Card>

                {/* Install */}
                <Card
                    className="dashboard-install-card"
                    title="Install the SDK"
                    subtitle="Choose your package manager and copy the install command"
                >
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
                    <div className="dashboard-install-codewrap">
                        <code className="install-command install-command-text">{installCommand}</code>
                        <button
                            className="dashboard-install-copy"
                            type="button"
                            onClick={() => copyToClipboard(installCommand, installCopyLabel)}
                            aria-label="Copy install command"
                        >
                            <Copy size={14} />
                        </button>
                    </div>
                </Card>

                {removeKeysConfirm && (
                    <div
                        className="dashboard-confirm-backdrop"
                        onMouseDown={(event) => {
                            if (event.target === event.currentTarget && !removeConfirmBusy) {
                                setRemoveKeysConfirm(null)
                            }
                        }}
                    >
                        <section
                            className="dashboard-confirm-dialog"
                            role="dialog"
                            aria-modal="true"
                            aria-labelledby="dashboard-confirm-title"
                            aria-describedby="dashboard-confirm-description"
                        >
                            <div className="dashboard-confirm-copy">
                                <h3 id="dashboard-confirm-title">{removeConfirmTitle}</h3>
                                <p id="dashboard-confirm-description">{removeConfirmDescription}</p>
                            </div>
                            <div className="dashboard-confirm-actions">
                                <button
                                    type="button"
                                    className="btn btn-secondary dashboard-confirm-cancel"
                                    onClick={() => setRemoveKeysConfirm(null)}
                                    disabled={removeConfirmBusy}
                                    autoFocus
                                >
                                    Cancel
                                </button>
                                <button
                                    type="button"
                                    className="btn btn-danger dashboard-confirm-remove"
                                    onClick={confirmRemoveKeys}
                                    disabled={removeConfirmBusy}
                                    aria-busy={removeConfirmBusy}
                                >
                                    {removeConfirmBusy ? 'Removing...' : 'Remove'}
                                </button>
                            </div>
                        </section>
                    </div>
                )}
            </main>
        </div>
    )
}
