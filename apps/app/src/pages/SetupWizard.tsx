/**
 * Setup Wizard — Generate delegate key + create Walrus Memory account onchain
 *
 * Steps:
 * 1. Intro — explain delegate keys, "generate delegate key" button
 * 2. Generate Ed25519 keypair → show key + copy + confirm (both flows)
 * 3. On-chain registration (Enoki: sponsored/silent, Wallet: user approves)
 * 4. Save key to sessionStorage → redirect to Dashboard
 */

import { useState, useCallback, useEffect, useRef } from 'react'
import {
    useCurrentAccount,
    useDisconnectWallet,
    useSuiClient,
} from '@mysten/dapp-kit'
import { Transaction } from '@mysten/sui/transactions'
import { useSponsoredTransaction } from '../hooks/useSponsoredTransaction'
import { useDelegateKey } from '../App'
import { Link, useNavigate } from 'react-router-dom'
import { LogOut, Copy } from 'lucide-react'
import { config } from '../config'
import { getAnalyticsErrorType, trackEvent } from '../utils/analytics'
import {
    getDelegateKeyFields,
    getMoveFields,
    type AccountObjectFields,
    type DynamicFieldObjectFields,
    type RegistryObjectFields,
} from '../utils/suiFields'
import memwalLogo from '../assets/memwal-logo.svg'

type Step = 'intro' | 'generating' | 'show-key' | 'onchain' | 'done' | 'error'

const MAX_DELEGATE_KEYS = 20
const MAX_DELEGATE_KEYS_ERROR = `this wallet already has ${MAX_DELEGATE_KEYS} delegate keys. go to the dashboard, remove an old key, then create a new delegate key.`

const AUTH_METHOD_KEY = 'memwal_auth_method'

function getPersistedAuthMethod(): string | null {
    return sessionStorage.getItem(AUTH_METHOD_KEY)
}

function isMaxDelegateKeysError(err: unknown): boolean {
    const message = err instanceof Error ? err.message : String(err)
    return message.includes('abort code: 2') && message.includes('add_delegate_key')
}

function normalizePrivateKeyHex(raw: string): string {
    return raw.trim().replace(/^0x/i, '').replace(/\s+/g, '').toLowerCase()
}

function bytesToHex(bytes: Uint8Array | number[]): string {
    return Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('')
}

function hexToBytes(hex: string): Uint8Array {
    return new Uint8Array(
        Array.from({ length: hex.length / 2 }, (_, i) => parseInt(hex.slice(i * 2, i * 2 + 2), 16))
    )
}

async function getAccountObjectId(suiClient: ReturnType<typeof useSuiClient>, ownerAddress: string): Promise<string | null> {
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
                    name: { type: 'address', value: ownerAddress },
                })
                const dynFields = getMoveFields<DynamicFieldObjectFields>(dynField?.data?.content)
                if (dynFields?.value) return dynFields.value
            }
        }
    } catch {
        return null
    }

    return null
}

async function getDelegateKeyCount(suiClient: ReturnType<typeof useSuiClient>, accountId: string): Promise<number> {
    const obj = await suiClient.getObject({
        id: accountId,
        options: { showContent: true },
    })
    const fields = getMoveFields<AccountObjectFields>(obj?.data?.content)
    if (fields) return (fields.delegate_keys ?? []).length

    return 0
}

async function getRegisteredDelegatePublicKeys(suiClient: ReturnType<typeof useSuiClient>, accountId: string): Promise<string[]> {
    const obj = await suiClient.getObject({
        id: accountId,
        options: { showContent: true },
    })
    const fields = getMoveFields<AccountObjectFields>(obj?.data?.content)
    if (fields) {
        const keys = fields.delegate_keys ?? []
        return keys.map((k) => {
            const f = getDelegateKeyFields(k)
            const pkBytes: number[] = f.public_key ?? []
            return bytesToHex(pkBytes)
        })
    }

    return []
}

export default function SetupWizard() {
    const currentAccount = useCurrentAccount()
    const { mutateAsync: disconnect } = useDisconnectWallet()
    const { mutateAsync: signAndExecute } = useSponsoredTransaction()
    const suiClient = useSuiClient()
    const { setDelegateKeys } = useDelegateKey()
    const navigate = useNavigate()

    const [step, setStep] = useState<Step>('intro')
    const [privateKeyHex, setPrivateKeyHex] = useState('')
    const [publicKeyHex, setPublicKeyHex] = useState('')
    const [copied, setCopied] = useState(false)
    const [confirmed, setConfirmed] = useState(false)
    const [txStatus, setTxStatus] = useState('')
    const [error, setError] = useState('')
    const [importKeyHex, setImportKeyHex] = useState('')
    const [importingKey, setImportingKey] = useState(false)
    const [suiAddress, setSuiAddress] = useState('')

    const setupRunningRef = useRef(false)
    const address = currentAccount?.address || ''
    const isEnoki = getPersistedAuthMethod() === 'enoki'

    // ── Done: redirect to dashboard ──
    useEffect(() => {
        if (step === 'done') {
            sessionStorage.removeItem(AUTH_METHOD_KEY)
            const timer = setTimeout(() => navigate('/dashboard'), 1500)
            return () => clearTimeout(timer)
        }
    }, [step, navigate])

    const deriveDelegateKey = useCallback(async (privateKeyHexValue: string) => {
        const ed = await import('@noble/ed25519')
        const { blake2b } = await import('@noble/hashes/blake2.js')
        const privateKey = hexToBytes(privateKeyHexValue)
        const publicKey = await ed.getPublicKeyAsync(privateKey)

        const input = new Uint8Array(33)
        input[0] = 0x00
        input.set(publicKey, 1)
        const addressBytes = blake2b(input, { dkLen: 32 })
        const suiAddr = '0x' + bytesToHex(new Uint8Array(addressBytes))

        return { privHex: privateKeyHexValue, pubHex: bytesToHex(publicKey), suiAddr }
    }, [])

    // ── Generate Ed25519 keypair (shared) ──
    const generateKeys = useCallback(async () => {
        const privateKey = new Uint8Array(32)
        crypto.getRandomValues(privateKey)
        return deriveDelegateKey(bytesToHex(privateKey))
    }, [deriveDelegateKey])

    // ── Register delegate key on-chain (shared) ──
    const registerOnchain = useCallback(async (
        ownerAddress: string,
        pubKeyHex: string,
        delegateSuiAddress: string,
    ): Promise<string> => {
        let knownAccountId = await getAccountObjectId(suiClient, ownerAddress)

        const pubKeyBytes = Array.from(
            { length: pubKeyHex.length / 2 },
            (_, i) => parseInt(pubKeyHex.slice(i * 2, i * 2 + 2), 16)
        )

        if (knownAccountId) {
            const delegateKeyCount = await getDelegateKeyCount(suiClient, knownAccountId)
            if (delegateKeyCount >= MAX_DELEGATE_KEYS) {
                throw new Error(MAX_DELEGATE_KEYS_ERROR)
            }

            setTxStatus('account found! adding delegate key...')
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
            setTxStatus('creating account...')
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

            setTxStatus('adding delegate key...')
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

        return knownAccountId!
    }, [suiClient, signAndExecute])

    // ── "Generate delegate key" button handler ──
    const handleGenerate = useCallback(async () => {
        if (setupRunningRef.current) return
        setupRunningRef.current = true

        trackEvent('delegate_key_generate_start', { location: 'setup' })
        setStep('generating')
        setError('')

        try {
            const { privHex, pubHex, suiAddr } = await generateKeys()
            setPrivateKeyHex(privHex)
            setPublicKeyHex(pubHex)
            setSuiAddress(suiAddr)
            setStep('show-key')
            trackEvent('delegate_key_generated', { location: 'setup' })
        } catch (err) {
            console.error('Setup failed:', err)
            const message = err instanceof Error ? err.message : 'setup failed. please try again.'
            setError(message)
            setStep('error')
            trackEvent('delegate_key_generate_failed', { error_type: getAnalyticsErrorType(err) })
        } finally {
            setupRunningRef.current = false
        }
    }, [generateKeys])

    const handleImportKey = useCallback(async () => {
        if (setupRunningRef.current) return

        const normalizedKey = normalizePrivateKeyHex(importKeyHex)
        if (!/^[0-9a-f]{64}$/.test(normalizedKey)) {
            setError('delegate key must be a 64-character hex private key.')
            trackEvent('delegate_key_import_failed', { error_type: 'invalid_input' })
            return
        }

        setupRunningRef.current = true
        setImportingKey(true)
        setError('')
        trackEvent('delegate_key_import_start', { location: 'setup' })

        try {
            const accountId = await getAccountObjectId(suiClient, address)
            if (!accountId) {
                throw new Error('no Walrus Memory account found for this wallet. generate a new delegate key first.')
            }

            const { pubHex } = await deriveDelegateKey(normalizedKey)
            const registeredPublicKeys = await getRegisteredDelegatePublicKeys(suiClient, accountId)
            if (!registeredPublicKeys.includes(pubHex)) {
                throw new Error('this delegate key is not registered on-chain for the connected wallet.')
            }

            setDelegateKeys(normalizedKey, pubHex, accountId)
            setImportKeyHex('')
            setStep('done')
            trackEvent('delegate_key_import_complete', { location: 'setup' })
        } catch (err) {
            const message = err instanceof Error ? err.message : 'failed to import delegate key. please try again.'
            setError(message)
            trackEvent('delegate_key_import_failed', { error_type: getAnalyticsErrorType(err) })
        } finally {
            setImportingKey(false)
            setupRunningRef.current = false
        }
    }, [address, importKeyHex, deriveDelegateKey, suiClient, setDelegateKeys])

    // ── Wallet: register on-chain after user confirms key ──
    const executeOnchain = useCallback(async () => {
        if (setupRunningRef.current) return
        setupRunningRef.current = true

        trackEvent('delegate_key_register_start', {
            auth_method: isEnoki ? 'enoki' : 'wallet',
            location: 'setup',
        })
        setStep('onchain')
        setError('')
        setTxStatus('checking existing account...')

        try {
            const accountId = await registerOnchain(address, publicKeyHex, suiAddress)
            setTxStatus('delegate key registered onchain!')
            setDelegateKeys(privateKeyHex, publicKeyHex, accountId)
            setPrivateKeyHex('')
            setStep('done')
            trackEvent('delegate_key_register_complete', {
                auth_method: isEnoki ? 'enoki' : 'wallet',
                location: 'setup',
            })
        } catch (err: unknown) {
            console.error('Onchain operation failed:', err)
            setError((isMaxDelegateKeysError(err) || (err instanceof Error && err.message === MAX_DELEGATE_KEYS_ERROR)) ? MAX_DELEGATE_KEYS_ERROR : err instanceof Error ? err.message : 'transaction failed. please try again.')
            setStep('show-key')
            trackEvent('delegate_key_register_failed', { error_type: getAnalyticsErrorType(err) })
        } finally {
            setupRunningRef.current = false
        }
    }, [address, publicKeyHex, privateKeyHex, suiAddress, registerOnchain, setDelegateKeys, isEnoki])

    const copyKey = useCallback(async () => {
        await navigator.clipboard.writeText(privateKeyHex)
        setCopied(true)
        setTimeout(() => setCopied(false), 2000)
    }, [privateKeyHex])

    const handleRetry = useCallback(() => {
        setError('')
        setStep('intro')
    }, [])

    return (
        <div className="setup-classic">
            <nav className="nav setup-classic-nav">
                <div className="nav-inner">
                    <Link to="/" className="nav-brand">
                        <img src={memwalLogo} alt="Walrus Memory" style={{ height: 22 }} />
                    </Link>
                    <div className="nav-user">
                        <span className="nav-address">
                            {address.slice(0, 6)}...{address.slice(-4)}
                        </span>
                        <button
                            className="lp-nav-cta"
                            onClick={() => {
                                trackEvent('sign_out', { location: 'setup' })
                                disconnect()
                            }}
                        >
                            <LogOut size={14} /> sign out
                        </button>
                    </div>
                </div>
            </nav>

            <main className="container setup-classic-container">
                <div className="setup-classic-panel">

                    {/* ===== Step 1: Intro ===== */}
                    {step === 'intro' && (
                        <div className="setup-classic-intro">

                            <h2 className="setup-classic-title">
                                create your delegate key
                            </h2>
                            <p className="setup-classic-description">
                                a delegate key lets your AI apps access Walrus Memory on your behalf.
                                it's a lightweight Ed25519 keypair — separate from your wallet.
                            </p>

                            <div className="card setup-classic-feature-card">
                                <div className="setup-classic-feature">

                                    <div>
                                        <strong>low risk</strong>
                                        <p>
                                            cannot access funds or sign Sui transactions
                                        </p>
                                    </div>
                                </div>
                                <div className="setup-classic-feature">
                                    <div>
                                        <strong>revocable</strong>
                                        <p>
                                            remove anytime from your Walrus Memory dashboard
                                        </p>
                                    </div>
                                </div>
                                <div className="setup-classic-feature">
                                    <div>
                                        <strong>onchain registration</strong>
                                        <p>
                                            key is verified on Sui blockchain for maximum security
                                        </p>
                                    </div>
                                </div>
                            </div>

                            <button className="lp-btn-yellow setup-classic-generate" onClick={handleGenerate}>
                                generate delegate key
                            </button>

                            <div className="setup-classic-divider">
                                or
                            </div>

                            <div className="setup-classic-import">
                                <div className="input-group">
                                    <textarea
                                        id="delegate-key-input"
                                        className="input setup-import-textarea"
                                        rows={3}
                                        value={importKeyHex}
                                        onChange={(e) => setImportKeyHex(e.target.value)}
                                        placeholder="paste your delegate private key"
                                        aria-label="existing delegate key"
                                        spellCheck={false}
                                    />
                                </div>
                                {error && (
                                    <div style={{
                                        background: 'rgba(248,113,113,0.08)',
                                        border: '1px solid rgba(248,113,113,0.2)',
                                        borderRadius: 'var(--radius-md)',
                                        padding: 12,
                                        marginBottom: 12,
                                        color: 'var(--danger)',
                                        fontSize: '0.82rem',
                                    }}>
                                        {error}
                                    </div>
                                )}
                                <button
                                    className="btn btn-secondary setup-import-button"
                                    onClick={handleImportKey}
                                    disabled={importingKey || !importKeyHex.trim()}
                                >
                                    {importingKey ? 'checking key...' : 'use delegate key'}
                                </button>
                            </div>
                        </div>
                    )}

                    {/* ===== Generating ===== */}
                    {step === 'generating' && (
                        <div style={{ textAlign: 'center', padding: '60px 0' }}>
                            <div className="spinner" style={{ margin: '0 auto 20px', width: 32, height: 32 }} />
                            <p style={{ color: 'var(--text-secondary)' }}>generating keypair...</p>
                        </div>
                    )}

                    {/* ===== Step 2: Show Key ===== */}
                    {step === 'show-key' && (
                        <div>
                            <div style={{ textAlign: 'center', marginBottom: 24 }}>

                                <h2 style={{ fontSize: '1.4rem', fontWeight: 700, letterSpacing: '-0.02em' }}>
                                    key generated!
                                </h2>
                            </div>

                            <div className="warning-box">
                                <p>
                                    <strong>save this private key now!</strong> it will not be shown again.
                                    store it securely — you'll need it to configure the Walrus Memory SDK.
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
                                    <div>{error}</div>
                                    {error === MAX_DELEGATE_KEYS_ERROR && (
                                        <Link to="/dashboard" className="btn btn-secondary btn-sm" style={{ marginTop: 12 }}>
                                            manage keys in dashboard
                                        </Link>
                                    )}
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
                                {isEnoki ? 'continue →' : 'register key onchain & continue →'}
                            </button>
                        </div>
                    )}

                    {/* ===== Onchain tx in progress ===== */}
                    {step === 'onchain' && (
                        <div style={{ textAlign: 'center', padding: '60px 0' }}>
                            <div className="spinner" style={{ margin: '0 auto 20px', width: 32, height: 32 }} />
                            <p style={{ color: 'var(--text-secondary)', marginBottom: 8 }}>{txStatus}</p>
                            <p style={{ color: 'var(--text-muted)', fontSize: '0.8rem' }}>
                                {isEnoki
                                    ? 'this may take a few seconds...'
                                    : 'please approve the transaction in your wallet'}
                            </p>
                        </div>
                    )}

                    {/* ===== Error ===== */}
                    {step === 'error' && (
                        <div style={{ textAlign: 'center', padding: '60px 0' }}>
                            <h2 style={{ fontSize: '1.4rem', fontWeight: 700, marginBottom: 8, color: 'var(--danger)' }}>
                                setup failed
                            </h2>
                            <p style={{ color: 'var(--text-secondary)', marginBottom: 16, fontSize: '0.85rem' }}>
                                {error}
                            </p>
                            <button className="lp-btn-yellow" onClick={handleRetry}>
                                try again
                            </button>
                        </div>
                    )}

                    {/* ===== Done ===== */}
                    {step === 'done' && (
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
            </main>
        </div>
    )
}
