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
    useSuiClient,
} from '@mysten/dapp-kit'
import { Transaction } from '@mysten/sui/transactions'
import { useSponsoredTransaction } from '../hooks/useSponsoredTransaction'
import { useDelegateKey } from '../App'
import { LogOut, Copy } from 'lucide-react'
import { config } from '../config'
import memwalLogo from '../assets/memwal-logo.svg'

type Step = 'intro' | 'generating' | 'show-key' | 'onchain' | 'done'

export default function SetupWizard() {
    const currentAccount = useCurrentAccount()
    const { mutateAsync: disconnect } = useDisconnectWallet()
    const { mutateAsync: signAndExecute } = useSponsoredTransaction()
    const suiClient = useSuiClient()
    const { setDelegateKeys } = useDelegateKey()

    const [step, setStep] = useState<Step>('intro')
    const [privateKeyHex, setPrivateKeyHex] = useState('')
    const [publicKeyHex, setPublicKeyHex] = useState('')
    const [copied, setCopied] = useState(false)
    const [confirmed, setConfirmed] = useState(false)
    const [txStatus, setTxStatus] = useState('')
    const [error, setError] = useState('')
    const [suiAddress, setSuiAddress] = useState('')

    const address = currentAccount?.address || ''

    // --------------------------------------------------------
    // Step 1: Generate Ed25519 keypair
    // --------------------------------------------------------
    const generateKeypair = useCallback(async () => {
        setStep('generating')
        setError('')

        try {
            const ed = await import('@noble/ed25519')
            const { blake2b } = await import('@noble/hashes/blake2.js')
            const privateKey = new Uint8Array(32)
            crypto.getRandomValues(privateKey)
            const publicKey = await ed.getPublicKeyAsync(privateKey)

            const privHex = Array.from(privateKey).map(b => b.toString(16).padStart(2, '0')).join('')
            const pubHex = Array.from(publicKey).map(b => b.toString(16).padStart(2, '0')).join('')

            // Derive Sui address: blake2b256(0x00 || public_key)
            const input = new Uint8Array(33)
            input[0] = 0x00 // Ed25519 scheme flag
            input.set(publicKey, 1)
            const addressBytes = blake2b(input, { dkLen: 32 })
            const suiAddr = '0x' + Array.from(new Uint8Array(addressBytes)).map((b: number) => b.toString(16).padStart(2, '0')).join('')

            setPrivateKeyHex(privHex)
            setPublicKeyHex(pubHex)
            setSuiAddress(suiAddr)
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
            // Check if user already has a MemWalAccount via registry lookup
            setTxStatus('checking existing account...')
            let knownAccountId: string | null = null

            try {
                // First, get the registry object to find the Table's inner ID
                // (Move Table stores dynamic fields on its own UID, not the parent's)
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
                            knownAccountId = (dynField.data.content.fields as any).value as string
                        }
                    }
                }
            } catch {
                // Dynamic field not found → no account yet
            }

            const pubKeyBytes = Array.from(
                { length: publicKeyHex.length / 2 },
                (_, i) => parseInt(publicKeyHex.slice(i * 2, i * 2 + 2), 16)
            )

            if (knownAccountId) {
                // Account exists — add user delegate key
                setTxStatus('account found! adding delegate key...')
                const tx = new Transaction()

                tx.moveCall({
                    target: `${config.memwalPackageId}::account::add_delegate_key`,
                    arguments: [
                        tx.object(knownAccountId),
                        tx.pure('vector<u8>', pubKeyBytes),
                        tx.pure('address', suiAddress),
                        tx.pure('string', 'Web App'),
                        tx.object('0x6'),
                    ],
                })

                const result = await signAndExecute({ transaction: tx })
                await suiClient.waitForTransaction({ digest: result.digest })
            } else {
                // Step A: Create account first (now creates a shared object)
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

                // Find the created MemWalAccount object (now shared)
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

                // Step B: Add user's delegate key
                setTxStatus('adding delegate key...')
                const tx2 = new Transaction()
                tx2.moveCall({
                    target: `${config.memwalPackageId}::account::add_delegate_key`,
                    arguments: [
                        tx2.object(knownAccountId!),
                        tx2.pure('vector<u8>', pubKeyBytes),
                        tx2.pure('address', suiAddress),
                        tx2.pure('string', 'Web App'),
                        tx2.object('0x6'),
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
    }, [address, publicKeyHex, privateKeyHex, suiAddress, suiClient, signAndExecute, setDelegateKeys])

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
                        <img src={memwalLogo} alt="MemWal" style={{ height: 22 }} />
                    </div>
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

                            <button className="lp-btn-yellow" onClick={generateKeypair}>
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
                                your delegate key has been registered onchain. loading playground...
                            </p>
                        </div>
                    )}

                </div>
            </div>
        </>
    )
}
