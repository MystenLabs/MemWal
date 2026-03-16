/**
 * Setup Wizard — Generate delegate key + create MemWalAccount onchain
 *
 * Steps:
 * 1. Generate Ed25519 keypair
 * 2. Create MemWalAccount onchain (if not exists)
 * 3. Add delegate key onchain
 * 4. Save key to localStorage → proceed to Dashboard
 */

import { useState, useCallback } from 'react'
import {
    useCurrentAccount,
    useDisconnectWallet,
    useSignAndExecuteTransaction,
    useSuiClient,
} from '@mysten/dapp-kit'
import { Transaction } from '@mysten/sui/transactions'
import { useDelegateKey } from '../App'
import { config } from '../config'

type Step = 'intro' | 'generating' | 'show-key' | 'onchain' | 'done'

export default function SetupWizard() {
    const currentAccount = useCurrentAccount()
    const { mutateAsync: disconnect } = useDisconnectWallet()
    const { mutateAsync: signAndExecute } = useSignAndExecuteTransaction()
    const suiClient = useSuiClient()
    const { setDelegateKeys } = useDelegateKey()

    const [step, setStep] = useState<Step>('intro')
    const [privateKeyHex, setPrivateKeyHex] = useState('')
    const [publicKeyHex, setPublicKeyHex] = useState('')
    const [copied, setCopied] = useState(false)
    const [confirmed, setConfirmed] = useState(false)
    const [txStatus, setTxStatus] = useState('')
    const [error, setError] = useState('')

    const address = currentAccount?.address || ''

    // --------------------------------------------------------
    // Step 1: Generate Ed25519 keypair
    // --------------------------------------------------------
    const generateKeypair = useCallback(async () => {
        setStep('generating')
        setError('')

        try {
            const ed = await import('@noble/ed25519')
            const privateKey = new Uint8Array(32)
            crypto.getRandomValues(privateKey)
            const publicKey = await ed.getPublicKeyAsync(privateKey)

            const privHex = Array.from(privateKey).map(b => b.toString(16).padStart(2, '0')).join('')
            const pubHex = Array.from(publicKey).map(b => b.toString(16).padStart(2, '0')).join('')

            setPrivateKeyHex(privHex)
            setPublicKeyHex(pubHex)
            setStep('show-key')
        } catch (err) {
            console.error('Key generation failed:', err)
            setError('failed to generate key. please try again.')
            setStep('intro')
        }
    }, [])

    // --------------------------------------------------------
    // Step 2: Onchain — create account + add delegate key
    // --------------------------------------------------------
    const executeOnchain = useCallback(async () => {
        setStep('onchain')
        setError('')

        try {
            // Check if user already has a MemWalAccount
            setTxStatus('checking existing account...')
            const ownedObjects = await suiClient.getOwnedObjects({
                owner: address,
                filter: {
                    StructType: `${config.memwalPackageId}::account::MemWalAccount`,
                },
                options: { showContent: true },
            })

            const pubKeyBytes = Array.from(
                { length: publicKeyHex.length / 2 },
                (_, i) => parseInt(publicKeyHex.slice(i * 2, i * 2 + 2), 16)
            )

            const tx = new Transaction()
            let knownAccountId: string | null = null

            if (ownedObjects.data.length > 0) {
                // Account exists — just add delegate key
                knownAccountId = ownedObjects.data[0].data!.objectId
                setTxStatus('account found! adding delegate key...')

                tx.moveCall({
                    target: `${config.memwalPackageId}::account::add_delegate_key`,
                    arguments: [
                        tx.object(knownAccountId),
                        tx.pure('vector<u8>', pubKeyBytes),
                        tx.pure('string', 'Web App'),
                    ],
                })

                const result = await signAndExecute({ transaction: tx })
                await suiClient.waitForTransaction({ digest: result.digest })
            } else {
                // Step A: Create account first (entry fn — transfers object internally)
                setTxStatus('creating account...')

                tx.moveCall({
                    target: `${config.memwalPackageId}::account::create_account`,
                    arguments: [
                        tx.object(config.memwalRegistryId),
                    ],
                })

                const createResult = await signAndExecute({ transaction: tx })
                await suiClient.waitForTransaction({ digest: createResult.digest })

                // Find the created MemWalAccount object
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

                // Step B: Add delegate key to the new account
                setTxStatus('adding delegate key...')
                const tx2 = new Transaction()
                tx2.moveCall({
                    target: `${config.memwalPackageId}::account::add_delegate_key`,
                    arguments: [
                        tx2.object(knownAccountId!),
                        tx2.pure('vector<u8>', pubKeyBytes),
                        tx2.pure('string', 'Web App'),
                    ],
                })

                const addResult = await signAndExecute({ transaction: tx2 })
                await suiClient.waitForTransaction({ digest: addResult.digest })
            }

            setTxStatus('delegate key registered onchain!')

            // Save to localStorage (including account object ID)
            setDelegateKeys(privateKeyHex, publicKeyHex, knownAccountId || '')
            setStep('done')
        } catch (err: unknown) {
            console.error('Onchain operation failed:', err)
            const message = err instanceof Error ? err.message : 'transaction failed. please try again.'
            setError(message)
            setStep('show-key') // Go back to key display
        }
    }, [address, publicKeyHex, privateKeyHex, suiClient, signAndExecute, setDelegateKeys])

    const copyKey = useCallback(async () => {
        await navigator.clipboard.writeText(privateKeyHex)
        setCopied(true)
        setTimeout(() => setCopied(false), 2000)
    }, [privateKeyHex])

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
                        <button className="btn btn-secondary btn-sm" onClick={() => disconnect()}>
                            sign out
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

                            <button className="btn btn-primary btn-lg" onClick={generateKeypair}>
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
                                    store it securely — you'll need it to configure the memwal SDK.
                                </p>
                            </div>

                            <div className="key-display" style={{ marginBottom: 16 }}>
                                <div className="key-label">private key (keep secret)</div>
                                <div className="key-value">{privateKeyHex}</div>
                                <div className="key-actions">
                                    <button className="btn btn-secondary btn-sm" onClick={copyKey}>
                                        {copied ? 'copied!' : 'copy'}
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
                                className="btn btn-primary btn-lg"
                                style={{ width: '100%' }}
                                disabled={!confirmed}
                                onClick={executeOnchain}
                            >
                                register key onchain & continue →
                            </button>
                        </div>
                    )}

                    {/* ===== Step 3: Onchain tx in progress ===== */}
                    {step === 'onchain' && (
                        <div style={{ textAlign: 'center', padding: '60px 0' }}>
                            <div className="spinner" style={{ margin: '0 auto 20px', width: 32, height: 32 }} />
                            <p style={{ color: 'var(--text-secondary)', marginBottom: 8 }}>{txStatus}</p>
                            <p style={{ color: 'var(--text-muted)', fontSize: '0.8rem' }}>
                                please approve the transaction in your wallet
                            </p>
                        </div>
                    )}

                    {/* ===== Done ===== */}
                    {step === 'done' && (
                        <div style={{ textAlign: 'center', padding: '60px 0' }}>
                            <h2 style={{ fontSize: '1.4rem', fontWeight: 700, marginBottom: 8 }}>
                                all set!
                            </h2>
                            <p style={{ color: 'var(--text-secondary)', marginBottom: 24 }}>
                                your delegate key has been registered onchain. redirecting to dashboard...
                            </p>
                        </div>
                    )}

                </div>
            </div>
        </>
    )
}
