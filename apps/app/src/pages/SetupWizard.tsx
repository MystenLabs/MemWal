/**
 * Setup Wizard — Generate delegate key + create MemWalAccount onchain
 *
 * Steps:
 * 1. Intro — explain delegate keys, "generate delegate key" button
 * 2. Generate Ed25519 keypair
 * 3. Enoki: silent on-chain registration → done
 *    Wallet: show key + confirm → on-chain registration → done
 * 4. Save key to localStorage → proceed to Dashboard
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
import memwalLogo from '../assets/memwal-logo.svg'

type Step = 'intro' | 'generating' | 'show-key' | 'onchain' | 'done' | 'error'

const AUTH_METHOD_KEY = 'memwal_auth_method'

function getPersistedAuthMethod(): string | null {
    return sessionStorage.getItem(AUTH_METHOD_KEY)
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

    // ── Generate Ed25519 keypair (shared) ──
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

    // ── Register delegate key on-chain (shared) ──
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

        setStep('generating')
        setError('')

        try {
            const { privHex, pubHex, suiAddr } = await generateKeys()

            if (isEnoki) {
                // Enoki: silent registration, no key display
                setStep('onchain')
                setTxStatus('registering delegate key...')
                const accountId = await registerOnchain(address, pubHex, suiAddr)
                setDelegateKeys(privHex, pubHex, accountId)
                setStep('done')
            } else {
                // Wallet: show key for user to save
                setPrivateKeyHex(privHex)
                setPublicKeyHex(pubHex)
                setSuiAddress(suiAddr)
                setStep('show-key')
            }
        } catch (err) {
            console.error('Setup failed:', err)
            const message = err instanceof Error ? err.message : 'setup failed. please try again.'
            setError(message)
            setStep('error')
        } finally {
            setupRunningRef.current = false
        }
    }, [generateKeys, isEnoki, address, registerOnchain, setDelegateKeys])

    // ── Wallet: register on-chain after user confirms key ──
    const executeOnchain = useCallback(async () => {
        if (setupRunningRef.current) return
        setupRunningRef.current = true

        setStep('onchain')
        setError('')
        setTxStatus('checking existing account...')

        try {
            const accountId = await registerOnchain(address, publicKeyHex, suiAddress)
            setTxStatus('delegate key registered onchain!')
            setDelegateKeys(privateKeyHex, publicKeyHex, accountId)
            setPrivateKeyHex('')
            setStep('done')
        } catch (err: unknown) {
            console.error('Onchain operation failed:', err)
            const message = err instanceof Error ? err.message : 'transaction failed. please try again.'
            setError(message)
            setStep('show-key')
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
        setStep('intro')
    }, [])

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
                        <button className="lp-nav-cta" onClick={() => disconnect()}>
                            <LogOut size={14} /> sign out
                        </button>
                    </div>
                </div>
            </nav>

            <div className="container">
                <div style={{ maxWidth: 520, margin: '60px auto' }}>

                    {/* ===== Step 1: Intro ===== */}
                    {step === 'intro' && (
                        <div style={{ textAlign: 'center' }}>

                            <h2 style={{ fontSize: '1.6rem', fontWeight: 700, marginBottom: 12, letterSpacing: '-0.02em' }}>
                                create your delegate key
                            </h2>
                            <p style={{ color: 'var(--text-secondary)', lineHeight: 1.6, marginBottom: 32 }}>
                                a delegate key lets your AI apps access memwal on your behalf.
                                it's a lightweight Ed25519 keypair — separate from your wallet.
                            </p>

                            <div className="card" style={{ textAlign: 'left', marginBottom: 24 }}>
                                <div style={{ display: 'flex', gap: 12, marginBottom: 16 }}>

                                    <div>
                                        <strong style={{ fontSize: '0.9rem' }}>low risk</strong>
                                        <p style={{ color: 'var(--text-muted)', fontSize: '0.8rem', margin: '4px 0 0' }}>
                                            cannot access funds or sign Sui transactions
                                        </p>
                                    </div>
                                </div>
                                <div style={{ display: 'flex', gap: 12, marginBottom: 16 }}>
                                    <div>
                                        <strong style={{ fontSize: '0.9rem' }}>revocable</strong>
                                        <p style={{ color: 'var(--text-muted)', fontSize: '0.8rem', margin: '4px 0 0' }}>
                                            remove anytime from your memwal dashboard
                                        </p>
                                    </div>
                                </div>
                                <div style={{ display: 'flex', gap: 12 }}>
                                    <div>
                                        <strong style={{ fontSize: '0.9rem' }}>onchain registration</strong>
                                        <p style={{ color: 'var(--text-muted)', fontSize: '0.8rem', margin: '4px 0 0' }}>
                                            key is verified on Sui blockchain for maximum security
                                        </p>
                                    </div>
                                </div>
                            </div>

                            <button className="lp-btn-yellow" onClick={handleGenerate}>
                                generate delegate key
                            </button>
                        </div>
                    )}

                    {/* ===== Generating ===== */}
                    {step === 'generating' && (
                        <div style={{ textAlign: 'center', padding: '60px 0' }}>
                            <div className="spinner" style={{ margin: '0 auto 20px', width: 32, height: 32 }} />
                            <p style={{ color: 'var(--text-secondary)' }}>generating keypair...</p>
                        </div>
                    )}

                    {/* ===== Step 2: Show Key (wallet only) ===== */}
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
            </div>
        </>
    )
}
