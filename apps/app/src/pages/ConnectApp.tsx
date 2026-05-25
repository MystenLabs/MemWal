/**
 * Connect App — hosted MemWal app-auth flow for third-party backend apps.
 *
 * Flow:
 *   1. Read /connect/app query params and ask the relayer to create a
 *      short-lived app-auth session.
 *   2. User signs in with Google/Enoki or a Sui wallet.
 *   3. Browser registers the server-generated delegate public key on-chain.
 *   4. Browser tells the relayer the tx/account result.
 *   5. Relayer verifies on-chain state and returns a safe app redirect URL.
 *
 * The browser never receives the delegate private key, token exchange secret,
 * bearer credential, or any long-lived app credential.
 */

import { useCallback, useEffect, useMemo, useState, type CSSProperties } from 'react'
import {
    ConnectModal,
    useConnectWallet,
    useCurrentAccount,
    useSuiClient,
    useWallets,
} from '@mysten/dapp-kit'
import { isEnokiWallet, type EnokiWallet, type AuthProvider } from '@mysten/enoki'
import { Transaction } from '@mysten/sui/transactions'
import { AlertCircle, CheckCircle2, Loader2, LogIn, ShieldCheck, X } from 'lucide-react'
import { Link, useSearchParams } from 'react-router-dom'
import { useSponsoredTransaction } from '../hooks/useSponsoredTransaction'
import { config } from '../config'
import memwalLogo from '../assets/memwal-logo.svg'

type Step = 'loading' | 'consent' | 'registering' | 'redirecting' | 'error'
type Provider = 'wallet' | 'google'

interface AppAuthSession {
    session_id: string
    client: {
        client_id: string
        display_name: string
    }
    redirect_host: string
    label: string
    expires_at: string
    delegate: {
        public_key: string
        sui_address: string
    }
}

interface AppAuthRedirectResponse {
    redirect_url: string
}

function hexToBytes(hex: string): number[] {
    const clean = hex.startsWith('0x') ? hex.slice(2) : hex
    const out: number[] = []
    for (let i = 0; i < clean.length; i += 2) {
        out.push(parseInt(clean.slice(i, i + 2), 16))
    }
    return out
}

async function resolveAccountId(
    suiClient: ReturnType<typeof useSuiClient>,
    ownerAddress: string,
): Promise<string | null> {
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
                    return (dynField.data.content.fields as any).value as string
                }
            }
        }
    } catch {
        return null
    }
    return null
}

async function apiPost<T>(path: string, body: unknown): Promise<T> {
    const res = await fetch(`${config.memwalServerUrl}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
    })
    if (!res.ok) {
        let message = `request failed (${res.status})`
        try {
            const data = await res.json()
            if (typeof data?.error === 'string') message = data.error
        } catch {
            // keep status fallback
        }
        throw new Error(message)
    }
    return res.json() as Promise<T>
}

export default function ConnectApp() {
    const [params] = useSearchParams()
    const currentAccount = useCurrentAccount()
    const suiClient = useSuiClient()
    const wallets = useWallets()
    const { mutate: connect } = useConnectWallet()
    const { mutateAsync: signAndExecute } = useSponsoredTransaction()

    const [step, setStep] = useState<Step>('loading')
    const [session, setSession] = useState<AppAuthSession | null>(null)
    const [errorMsg, setErrorMsg] = useState('')
    const [walletPickerOpen, setWalletPickerOpen] = useState(false)
    const [provider, setProvider] = useState<Provider>('wallet')

    const request = useMemo(() => ({
        client_id: params.get('client_id') ?? '',
        redirect_uri: params.get('redirect_uri') ?? '',
        state: params.get('state') ?? '',
        label: params.get('label') || undefined,
        intent: params.get('intent') ?? '',
        fallback_uri: params.get('fallback_uri') || undefined,
    }), [params])

    const enokiWallets = wallets.filter(isEnokiWallet)
    const walletsByProvider = enokiWallets.reduce(
        (map, wallet) => map.set(wallet.provider, wallet),
        new Map<AuthProvider, EnokiWallet>(),
    )
    const googleWallet = walletsByProvider.get('google')
    const hasGoogle = !!(config.enokiApiKey && config.googleClientId && googleWallet)

    useEffect(() => {
        let cancelled = false
        setStep('loading')
        setErrorMsg('')

        apiPost<AppAuthSession>('/api/app-auth/start', request)
            .then((data) => {
                if (cancelled) return
                setSession(data)
                setStep('consent')
            })
            .catch((err) => {
                if (cancelled) return
                setErrorMsg(err instanceof Error ? err.message : String(err))
                setStep('error')
            })

        return () => {
            cancelled = true
            setSession(null)
        }
    }, [request])

    const registerDelegate = useCallback(async (): Promise<{ accountId: string, digest: string }> => {
        if (!session) throw new Error('missing app auth session')
        if (!currentAccount) throw new Error('connect a wallet first')

        let accountId = await resolveAccountId(suiClient, currentAccount.address)
        const publicKeyBytes = hexToBytes(session.delegate.public_key)

        if (!accountId) {
            const createTx = new Transaction()
            createTx.moveCall({
                target: `${config.memwalPackageId}::account::create_account`,
                arguments: [
                    createTx.object(config.memwalRegistryId),
                    createTx.object('0x6'),
                ],
            })
            const createResult = await signAndExecute({ transaction: createTx })
            await suiClient.waitForTransaction({ digest: createResult.digest })

            const txDetails = await suiClient.getTransactionBlock({
                digest: createResult.digest,
                options: { showObjectChanges: true },
            })
            const createdObj = txDetails.objectChanges?.find(
                (change) => change.type === 'created'
                    && 'objectType' in change
                    && change.objectType.includes('MemWalAccount')
            )
            if (createdObj && 'objectId' in createdObj) {
                accountId = createdObj.objectId
            }
        }

        if (!accountId) {
            throw new Error('could not resolve or create a MemWal account for this wallet')
        }

        const addTx = new Transaction()
        addTx.moveCall({
            target: `${config.memwalPackageId}::account::add_delegate_key`,
            arguments: [
                addTx.object(accountId),
                addTx.pure('vector<u8>', publicKeyBytes),
                addTx.pure('address', session.delegate.sui_address),
                addTx.pure('string', session.label),
                addTx.object('0x6'),
            ],
        })
        const addResult = await signAndExecute({ transaction: addTx })
        await suiClient.waitForTransaction({ digest: addResult.digest })
        return { accountId, digest: addResult.digest }
    }, [currentAccount, session, signAndExecute, suiClient])

    const handleAuthorize = useCallback(async () => {
        if (!session) return
        if (!currentAccount) {
            setProvider('wallet')
            setWalletPickerOpen(true)
            return
        }

        setStep('registering')
        setErrorMsg('')

        try {
            const { accountId, digest } = await registerDelegate()
            const complete = await apiPost<AppAuthRedirectResponse>('/api/app-auth/complete', {
                session_id: session.session_id,
                account_id: accountId,
                owner_address: currentAccount.address,
                provider,
                tx_digest: digest,
            })
            setStep('redirecting')
            window.location.assign(complete.redirect_url)
        } catch (err) {
            setErrorMsg(err instanceof Error ? err.message : String(err))
            setStep('error')
        }
    }, [currentAccount, provider, registerDelegate, session])

    const handleGoogleConnect = useCallback(() => {
        if (!googleWallet) return
        setProvider('google')
        connect({ wallet: googleWallet })
    }, [connect, googleWallet])

    const redirectWithError = useCallback(async (error: string) => {
        if (!session) return
        try {
            const redirect = await apiPost<AppAuthRedirectResponse>('/api/app-auth/cancel', {
                session_id: session.session_id,
                error,
            })
            window.location.assign(redirect.redirect_url)
        } catch (err) {
            setErrorMsg(err instanceof Error ? err.message : String(err))
            setStep('error')
        }
    }, [session])

    return (
        <div style={pageStyle}>
            <nav className="lp-nav">
                <div className="lp-nav-inner">
                    <Link to="/" className="lp-nav-brand" style={brandStyle}>
                        <img src={memwalLogo} alt="MemWal" height="28" />
                        <span style={brandTextStyle}>Connect app</span>
                    </Link>
                </div>
            </nav>

            <main style={mainStyle}>
                {step === 'loading' && (
                    <section style={panelStyle}>
                        <Loader2 size={28} style={spinStyle} />
                        <h1 style={titleStyle}>Checking app request</h1>
                        <p style={mutedStyle}>MemWal is validating this connection request.</p>
                    </section>
                )}

                {step === 'consent' && session && (
                    <section style={panelStyle}>
                        <ShieldCheck size={34} color="#0f9f6e" />
                        <h1 style={titleStyle}>Connect MemWal</h1>
                        <p style={bodyStyle}>
                            {session.client.display_name} wants to connect to your MemWal account.
                        </p>

                        <div style={detailGridStyle}>
                            <div>
                                <div style={detailLabelStyle}>App</div>
                                <div style={detailValueStyle}>{session.client.display_name}</div>
                            </div>
                            <div>
                                <div style={detailLabelStyle}>Return host</div>
                                <div style={detailValueStyle}>{session.redirect_host}</div>
                            </div>
                            <div>
                                <div style={detailLabelStyle}>Delegate label</div>
                                <div style={detailValueStyle}>{session.label}</div>
                            </div>
                            <div>
                                <div style={detailLabelStyle}>Delegate public key</div>
                                <div style={{ ...detailValueStyle, fontFamily: 'var(--font-mono)', fontSize: 12 }}>
                                    {session.delegate.public_key.slice(0, 16)}…{session.delegate.public_key.slice(-12)}
                                </div>
                            </div>
                        </div>

                        {!currentAccount ? (
                            <div style={buttonRowStyle}>
                                {hasGoogle && (
                                    <button style={primaryButtonStyle} onClick={handleGoogleConnect}>
                                        <LogIn size={16} /> Continue with Google
                                    </button>
                                )}
                                <ConnectModal
                                    trigger={(
                                        <button style={secondaryButtonStyle} onClick={() => setProvider('wallet')}>
                                            <LogIn size={16} /> Connect Sui wallet
                                        </button>
                                    )}
                                    open={walletPickerOpen}
                                    onOpenChange={setWalletPickerOpen}
                                />
                            </div>
                        ) : (
                            <>
                                <div style={connectedStyle}>
                                    <CheckCircle2 size={15} color="#0f9f6e" />
                                    <span>{currentAccount.address.slice(0, 8)}…{currentAccount.address.slice(-6)}</span>
                                </div>
                                <div style={buttonRowStyle}>
                                    <button style={primaryButtonStyle} onClick={handleAuthorize}>
                                        <ShieldCheck size={16} /> Authorize app
                                    </button>
                                    <button style={secondaryButtonStyle} onClick={() => redirectWithError('access_denied')}>
                                        <X size={16} /> Cancel
                                    </button>
                                </div>
                            </>
                        )}
                    </section>
                )}

                {step === 'registering' && (
                    <section style={panelStyle}>
                        <Loader2 size={28} style={spinStyle} />
                        <h1 style={titleStyle}>Registering delegate</h1>
                        <p style={mutedStyle}>
                            MemWal is adding an app-specific delegate key on-chain.
                        </p>
                    </section>
                )}

                {step === 'redirecting' && (
                    <section style={panelStyle}>
                        <CheckCircle2 size={34} color="#0f9f6e" />
                        <h1 style={titleStyle}>Connected</h1>
                        <p style={mutedStyle}>Returning to the app.</p>
                    </section>
                )}

                {step === 'error' && (
                    <section style={panelStyle}>
                        <AlertCircle size={34} color="#dc2626" />
                        <h1 style={titleStyle}>Connection failed</h1>
                        <p style={errorStyle}>{errorMsg || 'This app connection request could not be completed.'}</p>
                        {session ? (
                            <div style={buttonRowStyle}>
                                <button style={primaryButtonStyle} onClick={() => setStep('consent')}>
                                    Try again
                                </button>
                                <button style={secondaryButtonStyle} onClick={() => redirectWithError('delegate_setup_failed')}>
                                    Return to app
                                </button>
                            </div>
                        ) : (
                            <p style={mutedStyle}>MemWal did not redirect because the app request was not safe.</p>
                        )}
                    </section>
                )}
            </main>

        </div>
    )
}

const pageStyle: CSSProperties = {
    minHeight: '100vh',
    background: 'var(--bg-primary)',
    color: 'var(--text-primary)',
}

const brandStyle: CSSProperties = {
    display: 'flex',
    alignItems: 'center',
    gap: 12,
    textDecoration: 'none',
}

const brandTextStyle: CSSProperties = {
    fontSize: 14,
    color: 'var(--text-secondary)',
    fontWeight: 700,
}

const mainStyle: CSSProperties = {
    minHeight: 'calc(100vh - 76px)',
    display: 'grid',
    placeItems: 'center',
    padding: '32px 18px',
}

const panelStyle: CSSProperties = {
    width: 'min(100%, 520px)',
    border: '1px solid var(--border)',
    background: 'var(--bg-secondary)',
    borderRadius: 8,
    padding: 28,
    boxShadow: '0 20px 60px rgba(15, 23, 42, 0.08)',
}

const titleStyle: CSSProperties = {
    margin: '16px 0 8px',
    fontSize: 26,
    lineHeight: 1.15,
    fontWeight: 800,
    letterSpacing: 0,
}

const bodyStyle: CSSProperties = {
    color: 'var(--text-secondary)',
    lineHeight: 1.55,
    margin: '0 0 22px',
}

const mutedStyle: CSSProperties = {
    color: 'var(--text-muted)',
    lineHeight: 1.55,
}

const errorStyle: CSSProperties = {
    color: '#dc2626',
    lineHeight: 1.55,
}

const detailGridStyle: CSSProperties = {
    display: 'grid',
    gap: 12,
    border: '1px solid var(--border)',
    borderRadius: 8,
    padding: 16,
    margin: '20px 0',
}

const detailLabelStyle: CSSProperties = {
    color: 'var(--text-muted)',
    fontSize: 12,
    fontWeight: 700,
    textTransform: 'uppercase',
}

const detailValueStyle: CSSProperties = {
    color: 'var(--text-primary)',
    fontSize: 14,
    overflowWrap: 'anywhere',
    marginTop: 3,
}

const connectedStyle: CSSProperties = {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    color: 'var(--text-secondary)',
    fontFamily: 'var(--font-mono)',
    fontSize: 13,
    margin: '10px 0 18px',
}

const buttonRowStyle: CSSProperties = {
    display: 'flex',
    flexWrap: 'wrap',
    gap: 10,
}

const primaryButtonStyle: CSSProperties = {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    border: '1px solid #111827',
    background: '#111827',
    color: '#fff',
    borderRadius: 8,
    padding: '11px 14px',
    fontWeight: 800,
    cursor: 'pointer',
}

const secondaryButtonStyle: CSSProperties = {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    border: '1px solid var(--border)',
    background: 'var(--bg-primary)',
    color: 'var(--text-primary)',
    borderRadius: 8,
    padding: '11px 14px',
    fontWeight: 800,
    cursor: 'pointer',
}

const spinStyle: CSSProperties = {
    animation: 'spin 0.9s linear infinite',
}
