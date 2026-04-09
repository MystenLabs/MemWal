/**
 * Landing Page — Two login options via "SDK Playground" popover:
 *
 * 1. Sign in with Google (Enoki) — silent key gen + on-chain registration, no key display
 * 2. Connect Wallet (any Sui wallet) — shows key + copy + confirm before on-chain registration
 */

import {
    ConnectButton,
    useConnectWallet,
    useCurrentAccount,
    useWallets,
    useSuiClient,
} from '@mysten/dapp-kit'
import { isEnokiWallet, type EnokiWallet, type AuthProvider } from '@mysten/enoki'
import { Transaction } from '@mysten/sui/transactions'
import { ChevronDown, Github, Copy } from 'lucide-react'
import { useRef, useState, useEffect, useCallback } from 'react'
import { useNavigate } from 'react-router-dom'
import { useSponsoredTransaction } from '../hooks/useSponsoredTransaction'
import { useDelegateKey } from '../App'
import { config } from '../config'
import memwalLogo from '../assets/memwal-logo.svg'

type SetupStep = 'idle' | 'generating' | 'show-key' | 'onchain' | 'done' | 'error'
type AuthMethod = 'enoki' | 'wallet' | null

// ── Persist authMethod across OAuth redirects ──
const AUTH_METHOD_KEY = 'memwal_auth_method'

function getPersistedAuthMethod(): AuthMethod {
    const val = sessionStorage.getItem(AUTH_METHOD_KEY)
    if (val === 'enoki' || val === 'wallet') return val
    return null
}

function persistAuthMethod(method: AuthMethod) {
    if (method) {
        sessionStorage.setItem(AUTH_METHOD_KEY, method)
    } else {
        sessionStorage.removeItem(AUTH_METHOD_KEY)
    }
}

export default function LandingPage() {
    const currentAccount = useCurrentAccount()
    const { mutate: connect } = useConnectWallet()
    const wallets = useWallets()
    const enokiWallets = wallets.filter(isEnokiWallet)
    const suiClient = useSuiClient()
    const { mutateAsync: signAndExecute } = useSponsoredTransaction()
    const { delegateKey, setDelegateKeys } = useDelegateKey()

    // Find Google wallet from registered Enoki wallets
    const walletsByProvider = enokiWallets.reduce(
        (map, wallet) => map.set(wallet.provider, wallet),
        new Map<AuthProvider, EnokiWallet>(),
    )
    const googleWallet = walletsByProvider.get('google')

    const navigate = useNavigate()
    const hasEnokiConfig = !!(config.enokiApiKey && config.googleClientId)
    const demoUrls = config.demoUrls

    // ── Dropdown states ──
    const [demoOpen, setDemoOpen] = useState(false)
    const demoRef = useRef<HTMLDivElement>(null)
    const [loginOpen, setLoginOpen] = useState(false)
    const loginRef = useRef<HTMLDivElement>(null)

    // ── Auth method tracking (restored from sessionStorage on mount for OAuth redirects) ──
    const [authMethod, setAuthMethod] = useState<AuthMethod>(getPersistedAuthMethod)

    // ── Refs ──
    const setupRunningRef = useRef(false)
    const walletClickedRef = useRef(false)

    // ── Setup state ──
    const [setupStep, setSetupStep] = useState<SetupStep>('idle')
    const [privateKeyHex, setPrivateKeyHex] = useState('')
    const [publicKeyHex, setPublicKeyHex] = useState('')
    const [suiAddress, setSuiAddress] = useState('')
    const [copied, setCopied] = useState(false)
    const [confirmed, setConfirmed] = useState(false)
    const [txStatus, setTxStatus] = useState('')
    const [error, setError] = useState('')

    const address = currentAccount?.address || ''
    const isNewUser = !!currentAccount && !delegateKey

    // ── Sync authMethod to sessionStorage ──
    const updateAuthMethod = useCallback((method: AuthMethod) => {
        setAuthMethod(method)
        persistAuthMethod(method)
    }, [])

    // ════════════════════════════════════════════════════════════
    // Callbacks — declared before effects that reference them
    // ════════════════════════════════════════════════════════════

    // ── Generate Ed25519 keypair (returns the keys) ──
    const generateKeys = useCallback(async () => {
        const ed = await import('@noble/ed25519')
        const { blake2b } = await import('@noble/hashes/blake2.js')
        const privateKey = new Uint8Array(32)
        crypto.getRandomValues(privateKey)
        const publicKey = await ed.getPublicKeyAsync(privateKey)

        const privHex = Array.from(privateKey).map(b => b.toString(16).padStart(2, '0')).join('')
        const pubHex = Array.from(publicKey).map(b => b.toString(16).padStart(2, '0')).join('')

        const input = new Uint8Array(33)
        input[0] = 0x00
        input.set(publicKey, 1)
        const addressBytes = blake2b(input, { dkLen: 32 })
        const suiAddr = '0x' + Array.from(new Uint8Array(addressBytes)).map((b: number) => b.toString(16).padStart(2, '0')).join('')

        return { privHex, pubHex, suiAddr }
    }, [])

    // ── Register delegate key on-chain (shared logic) ──
    const registerOnchain = useCallback(async (
        ownerAddress: string,
        pubKeyHex: string,
        delegateSuiAddress: string,
    ): Promise<string> => {
        let knownAccountId: string | null = null

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
                        name: { type: 'address', value: ownerAddress },
                    })
                    if (dynField?.data?.content && 'fields' in dynField.data.content) {
                        knownAccountId = (dynField.data.content.fields as any).value as string
                    }
                }
            }
        } catch {
            // Dynamic field not found → no account yet
        }

        const pubKeyBytes = Array.from(
            { length: pubKeyHex.length / 2 },
            (_, i) => parseInt(pubKeyHex.slice(i * 2, i * 2 + 2), 16)
        )

        if (knownAccountId) {
            const tx = new Transaction()
            tx.moveCall({
                target: `${config.memwalPackageId}::account::add_delegate_key`,
                arguments: [
                    tx.object(knownAccountId),
                    tx.pure('vector<u8>', pubKeyBytes),
                    tx.pure('address', delegateSuiAddress),
                    tx.pure('string', 'Web App'),
                    tx.object('0x6'),
                ],
            })
            const result = await signAndExecute({ transaction: tx })
            await suiClient.waitForTransaction({ digest: result.digest })
        } else {
            const tx = new Transaction()
            tx.moveCall({
                target: `${config.memwalPackageId}::account::create_account`,
                arguments: [
                    tx.object(config.memwalRegistryId),
                    tx.object('0x6'),
                ],
            })
            const createResult = await signAndExecute({ transaction: tx })
            await suiClient.waitForTransaction({ digest: createResult.digest })

            const txDetails = await suiClient.getTransactionBlock({
                digest: createResult.digest,
                options: { showObjectChanges: true },
            })
            const createdObj = txDetails.objectChanges?.find(
                (c) => c.type === 'created' &&
                    'objectType' in c &&
                    c.objectType.includes('MemWalAccount')
            )
            if (createdObj && 'objectId' in createdObj) {
                knownAccountId = createdObj.objectId
            }

            if (!knownAccountId) {
                throw new Error('Account created but object ID not found in transaction. Please try again.')
            }

            const tx2 = new Transaction()
            tx2.moveCall({
                target: `${config.memwalPackageId}::account::add_delegate_key`,
                arguments: [
                    tx2.object(knownAccountId),
                    tx2.pure('vector<u8>', pubKeyBytes),
                    tx2.pure('address', delegateSuiAddress),
                    tx2.pure('string', 'Web App'),
                    tx2.object('0x6'),
                ],
            })
            const addResult = await signAndExecute({ transaction: tx2 })
            await suiClient.waitForTransaction({ digest: addResult.digest })
        }

        return knownAccountId
    }, [suiClient, signAndExecute])

    // ── Enoki: silent key gen + register + save (no UI) ──
    const runEnokiSilentSetup = useCallback(async () => {
        if (setupRunningRef.current) return
        setupRunningRef.current = true

        if (!address) {
            setupRunningRef.current = false
            return
        }

        setSetupStep('onchain')
        setError('')
        setTxStatus('setting up your account...')

        try {
            const { privHex, pubHex, suiAddr } = await generateKeys()
            setTxStatus('registering delegate key...')
            const accountId = await registerOnchain(address, pubHex, suiAddr)
            setDelegateKeys(privHex, pubHex, accountId)
            setSetupStep('done')
        } catch (err: unknown) {
            console.error('Enoki setup failed:', err)
            const message = err instanceof Error ? err.message : 'setup failed. please try again.'
            setError(message)
            setSetupStep('error')
        } finally {
            setupRunningRef.current = false
        }
    }, [address, generateKeys, registerOnchain, setDelegateKeys])

    // ── Wallet: generate keypair (shows key in UI) ──
    const generateKeypair = useCallback(async () => {
        if (setupRunningRef.current) return
        setupRunningRef.current = true

        setSetupStep('generating')
        setError('')

        try {
            const { privHex, pubHex, suiAddr } = await generateKeys()
            setPrivateKeyHex(privHex)
            setPublicKeyHex(pubHex)
            setSuiAddress(suiAddr)
            setSetupStep('show-key')
        } catch (err) {
            console.error('Key generation failed:', err)
            setError('failed to generate key. please try again.')
            setSetupStep('error')
        } finally {
            setupRunningRef.current = false
        }
    }, [generateKeys])

    // ── Wallet: register on-chain after user confirms key ──
    const executeOnchain = useCallback(async () => {
        if (setupRunningRef.current) return
        setupRunningRef.current = true

        setSetupStep('onchain')
        setError('')
        setTxStatus('checking existing account...')

        try {
            const accountId = await registerOnchain(address, publicKeyHex, suiAddress)
            setTxStatus('delegate key registered onchain!')
            setDelegateKeys(privateKeyHex, publicKeyHex, accountId)
            setPrivateKeyHex('')
            setSetupStep('done')
        } catch (err: unknown) {
            console.error('Onchain operation failed:', err)
            const message = err instanceof Error ? err.message : 'transaction failed. please try again.'
            setError(message)
            setSetupStep('show-key')
        } finally {
            setupRunningRef.current = false
        }
    }, [address, publicKeyHex, privateKeyHex, suiAddress, registerOnchain, setDelegateKeys])

    const copyKey = useCallback(async () => {
        await navigator.clipboard.writeText(privateKeyHex)
        setCopied(true)
        setTimeout(() => setCopied(false), 2000)
    }, [privateKeyHex])

    const handleRetry = useCallback(() => {
        setError('')
        setSetupStep('idle')
    }, [])

    // ── Button handlers ──
    const handleEnokiConnect = () => {
        if (!googleWallet) return
        updateAuthMethod('enoki')
        setLoginOpen(false)
        connect({ wallet: googleWallet })
    }

    const handleWalletClick = () => {
        walletClickedRef.current = true
        setLoginOpen(false)
    }

    // ════════════════════════════════════════════════════════════
    // Effects — all referenced callbacks are declared above
    // ════════════════════════════════════════════════════════════

    // ── Close dropdowns on outside click ──
    useEffect(() => {
        const handleClickOutside = (e: MouseEvent) => {
            if (demoRef.current && !demoRef.current.contains(e.target as Node)) {
                setDemoOpen(false)
            }
            if (loginRef.current && !loginRef.current.contains(e.target as Node)) {
                setLoginOpen(false)
            }
        }
        document.addEventListener('mousedown', handleClickOutside)
        return () => document.removeEventListener('mousedown', handleClickOutside)
    }, [])

    // ── Returning user: auto-redirect to dashboard ──
    useEffect(() => {
        if (currentAccount && delegateKey) {
            persistAuthMethod(null)
            navigate('/dashboard')
        }
    }, [currentAccount, delegateKey, navigate])

    // ── New user + Enoki: run full silent setup ──
    useEffect(() => {
        if (isNewUser && authMethod === 'enoki' && setupStep === 'idle') {
            runEnokiSilentSetup()
        }
    }, [isNewUser, authMethod, setupStep, runEnokiSilentSetup])

    // ── New user + Wallet: auto-trigger key generation (shows key UI) ──
    useEffect(() => {
        if (isNewUser && authMethod === 'wallet' && setupStep === 'idle') {
            generateKeypair()
        }
    }, [isNewUser, authMethod, setupStep, generateKeypair])

    // ── Wallet disconnect during active setup → show error ──
    useEffect(() => {
        if (!currentAccount && setupStep !== 'idle' && setupStep !== 'done' && setupStep !== 'error') {
            setError('Wallet disconnected. Please reconnect and try again.')
            setSetupStep('error')
            setupRunningRef.current = false
        }
    }, [currentAccount, setupStep])

    // ── Done: redirect to dashboard ──
    useEffect(() => {
        if (setupStep === 'done') {
            persistAuthMethod(null)
            const timer = setTimeout(() => navigate('/dashboard'), 1500)
            return () => clearTimeout(timer)
        }
    }, [setupStep, navigate])

    // ── Detect wallet connection via ConnectButton ──
    useEffect(() => {
        if (currentAccount && !delegateKey && authMethod === null) {
            const persisted = getPersistedAuthMethod()
            if (persisted) {
                setAuthMethod(persisted)
            } else if (walletClickedRef.current) {
                walletClickedRef.current = false
                updateAuthMethod('wallet')
            }
        }
    }, [currentAccount, delegateKey, authMethod, updateAuthMethod])

    // ════════════════════════════════════════════════════════════
    // Render
    // ════════════════════════════════════════════════════════════

    const showSetupFlow = (isNewUser && authMethod !== null)
        || setupStep === 'error'

    const renderWalletSetupFlow = () => (
        <section className="lp-hero" style={{ justifyContent: 'center', padding: '0 24px' }}>
            <div style={{ maxWidth: 520, width: '100%', margin: '0 auto' }}>

                {setupStep === 'idle' && (
                    <div style={{ textAlign: 'center', padding: '60px 0' }}>
                        <div className="spinner" style={{ margin: '0 auto 20px', width: 32, height: 32 }} />
                        <p style={{ color: 'var(--text-secondary)' }}>connecting wallet...</p>
                    </div>
                )}

                {setupStep === 'generating' && (
                    <div style={{ textAlign: 'center', padding: '60px 0' }}>
                        <div className="spinner" style={{ margin: '0 auto 20px', width: 32, height: 32 }} />
                        <p style={{ color: 'var(--text-secondary)' }}>generating keypair...</p>
                    </div>
                )}

                {setupStep === 'show-key' && (
                    <div>
                        <div style={{ textAlign: 'center', marginBottom: 24 }}>
                            <h2 style={{ fontSize: '1.4rem', fontWeight: 700, letterSpacing: '-0.02em' }}>
                                key generated!
                            </h2>
                            <p style={{ color: 'var(--text-secondary)', marginTop: 8, fontSize: '0.9rem' }}>
                                a delegate key lets your AI apps access memwal on your behalf.
                            </p>
                        </div>

                        <div className="warning-box">
                            <p>
                                <strong>save this private key now!</strong> it will not be shown again.
                                store it securely — you'll need it to configure the memwal SDK.
                            </p>
                        </div>

                        <div className="key-display" style={{ marginBottom: 16 }}>
                            <div className="key-label">private key (keep secret)</div>
                            <div className="key-value">{privateKeyHex}</div>
                            <div className="key-actions">
                                <button className="btn btn-secondary btn-sm" onClick={copyKey}>
                                    <Copy size={12} /> {copied ? 'copied!' : 'copy'}
                                </button>
                            </div>
                        </div>

                        <div className="key-display" style={{ marginBottom: 24, borderColor: 'var(--border)' }}>
                            <div className="key-label" style={{ color: 'var(--text-muted)' }}>
                                public key (shareable)
                            </div>
                            <div className="key-value" style={{ color: 'var(--text-secondary)' }}>
                                {publicKeyHex}
                            </div>
                        </div>

                        {error && (
                            <div style={{
                                background: 'rgba(248,113,113,0.08)',
                                border: '1px solid rgba(248,113,113,0.2)',
                                borderRadius: 'var(--radius-md)',
                                padding: 16,
                                marginBottom: 20,
                                color: 'var(--danger)',
                                fontSize: '0.85rem',
                            }}>
                                {error}
                            </div>
                        )}

                        <div style={{ marginBottom: 24 }}>
                            <label style={{
                                display: 'flex', alignItems: 'flex-start', gap: 10, cursor: 'pointer',
                                fontSize: '0.85rem', color: 'var(--text-secondary)', lineHeight: 1.5
                            }}>
                                <input
                                    type="checkbox"
                                    checked={confirmed}
                                    onChange={(e) => setConfirmed(e.target.checked)}
                                    style={{ marginTop: 3 }}
                                />
                                i have saved my private key securely. i understand it cannot be recovered.
                            </label>
                        </div>

                        <button
                            className="lp-btn-yellow"
                            style={{ width: '100%', justifyContent: 'center' }}
                            disabled={!confirmed}
                            onClick={executeOnchain}
                        >
                            register key onchain & continue →
                        </button>
                    </div>
                )}

                {setupStep === 'onchain' && (
                    <div style={{ textAlign: 'center', padding: '60px 0' }}>
                        <div className="spinner" style={{ margin: '0 auto 20px', width: 32, height: 32 }} />
                        <p style={{ color: 'var(--text-secondary)', marginBottom: 8 }}>{txStatus}</p>
                        <p style={{ color: 'var(--text-muted)', fontSize: '0.8rem' }}>
                            please approve the transaction in your wallet
                        </p>
                    </div>
                )}

                {setupStep === 'error' && (
                    <div style={{ textAlign: 'center', padding: '60px 0' }}>
                        <h2 style={{ fontSize: '1.4rem', fontWeight: 700, marginBottom: 8, color: 'var(--danger)' }}>
                            setup failed
                        </h2>
                        <p style={{ color: 'var(--text-secondary)', marginBottom: 16, fontSize: '0.9rem' }}>
                            {error}
                        </p>
                        <button className="lp-btn-yellow" onClick={handleRetry}>
                            try again
                        </button>
                    </div>
                )}

                {setupStep === 'done' && (
                    <div style={{ textAlign: 'center', padding: '60px 0' }}>
                        <h2 style={{ fontSize: '1.4rem', fontWeight: 700, marginBottom: 8 }}>
                            all set!
                        </h2>
                        <p style={{ color: 'var(--text-secondary)', marginBottom: 24 }}>
                            your delegate key has been registered onchain. loading dashboard...
                        </p>
                    </div>
                )}

            </div>
        </section>
    )

    const renderEnokiSetupFlow = () => (
        <section className="lp-hero" style={{ justifyContent: 'center', padding: '0 24px' }}>
            <div style={{ maxWidth: 520, width: '100%', margin: '0 auto' }}>

                {setupStep === 'done' ? (
                    <div style={{ textAlign: 'center', padding: '60px 0' }}>
                        <h2 style={{ fontSize: '1.4rem', fontWeight: 700, marginBottom: 8 }}>
                            all set!
                        </h2>
                        <p style={{ color: 'var(--text-secondary)', marginBottom: 24 }}>
                            your account is ready. loading dashboard...
                        </p>
                    </div>
                ) : setupStep === 'error' ? (
                    <div style={{ textAlign: 'center', padding: '60px 0' }}>
                        <h2 style={{ fontSize: '1.4rem', fontWeight: 700, marginBottom: 8, color: 'var(--danger)' }}>
                            setup failed
                        </h2>
                        <p style={{ color: 'var(--text-secondary)', marginBottom: 16, fontSize: '0.9rem' }}>
                            {error}
                        </p>
                        <button className="lp-btn-yellow" onClick={handleRetry}>
                            try again
                        </button>
                    </div>
                ) : (
                    <div style={{ textAlign: 'center', padding: '60px 0' }}>
                        <div className="spinner" style={{ margin: '0 auto 20px', width: 32, height: 32 }} />
                        <p style={{ color: 'var(--text-secondary)', marginBottom: 8 }}>{txStatus || 'setting up your account...'}</p>
                    </div>
                )}

            </div>
        </section>
    )

    return (
        <div className="lp-page">
            {/* ── Nav ── */}
            <nav className="lp-nav">
                <div className="lp-nav-inner">
                    <a href="/" className="lp-nav-brand">
                        <img src={memwalLogo} alt="MemWal" height="28" />
                    </a>

                    <div className="lp-nav-links">
                        {demoUrls.length > 0 && (
                            <div className="lp-demo-dropdown" ref={demoRef}>
                                <button
                                    className="lp-demo-trigger"
                                    onClick={() => setDemoOpen(o => !o)}
                                >
                                    Demo <ChevronDown size={14} className={`lp-demo-chevron${demoOpen ? ' open' : ''}`} />
                                </button>
                                {demoOpen && (
                                    <div className="lp-demo-menu">
                                        {demoUrls.map(({ label, url }) => (
                                            <a
                                                key={url}
                                                href={url}
                                                target="_blank"
                                                rel="noopener noreferrer"
                                                className="lp-demo-item"
                                                onClick={() => setDemoOpen(false)}
                                            >
                                                {label} <span className="lp-arrow">↗</span>
                                            </a>
                                        ))}
                                    </div>
                                )}
                            </div>
                        )}

                        {currentAccount && delegateKey ? (
                            <button className="lp-nav-cta" onClick={() => navigate('/dashboard')}>
                                SDK Playground <span className="lp-arrow">↗</span>
                            </button>
                        ) : (
                            <div className="lp-demo-dropdown" ref={loginRef}>
                                <button
                                    className="lp-nav-cta"
                                    onClick={() => setLoginOpen(o => !o)}
                                >
                                    SDK Playground <span className="lp-arrow">↗</span>
                                </button>
                                {loginOpen && (
                                    <div className="lp-demo-menu" style={{ minWidth: 240, padding: 12, display: 'flex', flexDirection: 'column', gap: 8 }}>
                                        {hasEnokiConfig && googleWallet && (
                                            <button
                                                onClick={handleEnokiConnect}
                                                style={{
                                                    display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 10,
                                                    width: '100%', padding: '10px 16px',
                                                    background: '#E8FF75', color: '#000', border: '2px solid #000',
                                                    borderRadius: 10, fontSize: '0.88rem', fontWeight: 700,
                                                    fontFamily: 'var(--font-sans)', cursor: 'pointer',
                                                    boxShadow: '3px 3px 0 #000',
                                                    transition: 'transform 0.15s, box-shadow 0.15s',
                                                }}
                                                onMouseEnter={e => { e.currentTarget.style.transform = 'translate(-1px,-1px)'; e.currentTarget.style.boxShadow = '4px 4px 0 #000' }}
                                                onMouseLeave={e => { e.currentTarget.style.transform = 'none'; e.currentTarget.style.boxShadow = '3px 3px 0 #000' }}
                                            >
                                                <svg width="16" height="16" viewBox="0 0 24 24">
                                                    <path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 0 1-2.2 3.32v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.1z" fill="#4285F4" />
                                                    <path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" fill="#34A853" />
                                                    <path d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z" fill="#FBBC05" />
                                                    <path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" fill="#EA4335" />
                                                </svg>
                                                Sign in with Google
                                            </button>
                                        )}

                                        <div
                                            onClick={handleWalletClick}
                                            className="lp-login-wallet-btn"
                                        >
                                            <ConnectButton connectText="Connect Wallet" />
                                        </div>
                                    </div>
                                )}
                            </div>
                        )}
                    </div>
                </div>
            </nav>

            {/* ── Hero or Setup Flow ── */}
            {showSetupFlow && authMethod === 'enoki' ? renderEnokiSetupFlow() :
             showSetupFlow && authMethod === 'wallet' ? renderWalletSetupFlow() : (
                <section className="lp-hero">
                    <div className="lp-hero-inner">
                        <div className="lp-hero-copy">
                            <h1>Long-Term Memory<br />for AI Agents</h1>
                            <p>
                                MemWal introduces a long-term, verifiable memory layer on
                                Walrus, allowing agents to remember, share, and reuse
                                information reliably.
                            </p>

                            <div className="lp-hero-actions">
                                {config.docsUrl && (
                                    <a
                                        href={config.docsUrl}
                                        target="_blank"
                                        rel="noopener noreferrer"
                                        className="lp-btn-yellow"
                                    >
                                        Documentation <span className="lp-arrow">↗</span>
                                    </a>
                                )}
                                <a
                                    href="https://github.com/MystenLabs/memwal"
                                    target="_blank"
                                    rel="noopener noreferrer"
                                    className="lp-btn-outline"
                                >
                                    <Github size={18} /> GitHub <span className="lp-arrow">↗</span>
                                </a>
                            </div>
                        </div>

                        <div className="lp-hero-art">
                            <img
                                src="/memwal-grid-bg.png"
                                alt=""
                                className="lp-hero-grid"
                                aria-hidden="true"
                            />
                            <img
                                src="/memwal-mascot.png"
                                alt="MemWal mascot"
                                className="lp-hero-mascot"
                            />
                        </div>
                    </div>
                </section>
            )}
        </div>
    )
}
