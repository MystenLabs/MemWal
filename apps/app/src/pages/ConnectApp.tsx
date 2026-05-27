/**
 * Connect App — hosted Walrus Memory app-auth flow for third-party backend apps.
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
import { Link, useSearchParams } from 'react-router-dom'
import { useSponsoredTransaction } from '../hooks/useSponsoredTransaction'
import { config } from '../config'

type Step = 'loading' | 'consent' | 'registering' | 'redirecting' | 'error'
type Provider = 'wallet' | 'google'

const MAX_DELEGATE_KEYS = 20

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

function isAddDelegateAbort(err: unknown, abortCode: number): boolean {
    const message = err instanceof Error ? err.message : String(err)
    return message.includes(`abort code: ${abortCode}`) && message.includes('add_delegate_key')
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
            throw new Error('could not resolve or create a Walrus Memory account for this wallet')
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
        let addResult
        try {
            addResult = await signAndExecute({ transaction: addTx })
        } catch (txErr) {
            if (isAddDelegateAbort(txErr, 2)) {
                throw new Error(
                    `This Walrus Memory account already has the maximum number of delegate keys (${MAX_DELEGATE_KEYS}). ` +
                    `Open the dashboard and revoke an unused key, then retry Connect App.`,
                )
            }
            if (isAddDelegateAbort(txErr, 0)) {
                throw new Error(
                    `This wallet (${currentAccount.address.slice(0, 10)}...${currentAccount.address.slice(-6)}) is not the owner of Walrus Memory account ${accountId.slice(0, 10)}...${accountId.slice(-6)}. ` +
                    `Switch to the wallet that created this Walrus Memory account, then retry Connect App.`,
                )
            }
            throw txErr
        }
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
                    <Link to="/" className="lp-nav-brand" style={appNavBrandStyle}>
                        <span style={memwalWordmarkStyle}>MemWal</span>
                        <span style={mcpNavTitleStyle}>Connect App</span>
                    </Link>
                </div>
            </nav>

            <main style={mainStyle}>
                {step === 'loading' && (
                    <section style={cardStyle} aria-busy="true">
                        <p style={eyebrowStyle}>Secure request</p>
                        <h1 style={h1Style}>Checking app request</h1>
                        <p style={subtleStyle}>Walrus Memory is validating this connection request.</p>
                    </section>
                )}

                {step === 'consent' && session && (
                    <section style={cardStyle}>
                        <p style={eyebrowStyle}>Third-party app access</p>
                        <h1 style={h1Style}>Connect Walrus Memory</h1>
                        <p style={bodyStyle}>
                            {session.client.display_name} wants to connect to your Walrus Memory account.
                        </p>

                        <div style={detailGridStyle}>
                            <div>
                                <div style={detailLabelStyle}>App</div>
                                <div style={detailValueStyle}>{session.client.display_name}</div>
                            </div>
                            <div>
                                <div style={detailLabelStyle}>Return origin</div>
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
                                        Continue with Google
                                    </button>
                                )}
                                <ConnectModal
                                    trigger={(
                                        <button style={secondaryButtonStyle} onClick={() => setProvider('wallet')}>
                                            Connect Sui wallet
                                        </button>
                                    )}
                                    open={walletPickerOpen}
                                    onOpenChange={setWalletPickerOpen}
                                />
                            </div>
                        ) : (
                            <>
                                <div style={connectedStyle}>
                                    <span style={connectedLabelStyle}>Wallet</span>
                                    <span>{currentAccount.address.slice(0, 8)}…{currentAccount.address.slice(-6)}</span>
                                </div>
                                <div style={buttonRowStyle}>
                                    <button style={primaryButtonStyle} onClick={handleAuthorize}>
                                        Authorize app
                                    </button>
                                    <button style={secondaryButtonStyle} onClick={() => redirectWithError('access_denied')}>
                                        Cancel
                                    </button>
                                </div>
                            </>
                        )}
                    </section>
                )}

                {step === 'registering' && (
                    <section style={cardStyle} aria-busy="true">
                        <p style={eyebrowStyle}>On-chain setup</p>
                        <h1 style={h1Style}>Registering delegate</h1>
                        <p style={subtleStyle}>
                            Walrus Memory is adding an app-specific delegate key on-chain.
                        </p>
                    </section>
                )}

                {step === 'redirecting' && (
                    <section style={cardStyle}>
                        <p style={eyebrowStyle}>Connected</p>
                        <h1 style={h1Style}>Connected</h1>
                        <p style={subtleStyle}>Returning to the app.</p>
                    </section>
                )}

                {step === 'error' && (
                    <section style={cardStyle}>
                        <p style={dangerEyebrowStyle}>Connection failed</p>
                        <h1 style={h1Style}>Connection failed</h1>
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
                            <p style={subtleStyle}>Walrus Memory did not redirect because the app request was not safe.</p>
                        )}
                    </section>
                )}
            </main>

        </div>
    )
}

const pageStyle: CSSProperties = {
    minHeight: '100vh',
    background: '#FAF8F5',
    color: '#1a1a1a',
}

const appNavBrandStyle: CSSProperties = {
    gap: 12,
}

const memwalWordmarkStyle: CSSProperties = {
    color: '#000',
    fontSize: 26,
    fontWeight: 900,
    lineHeight: 1,
}

const mcpNavTitleStyle: CSSProperties = {
    color: '#000',
    fontSize: '1rem',
    fontWeight: 700,
    lineHeight: 1,
    transform: 'translateY(8px)',
}

const mainStyle: CSSProperties = {
    maxWidth: 640,
    margin: '40px auto',
    padding: '0 24px',
    display: 'flex',
    flexDirection: 'column',
    gap: 24,
}

const cardStyle: CSSProperties = {
    background: '#fff',
    border: '2px solid #000',
    borderRadius: 12,
    padding: 28,
    boxShadow: '4px 4px 0 #000',
}

const h1Style: CSSProperties = {
    margin: '0 0 12px',
    fontSize: 22,
    fontWeight: 800,
    letterSpacing: 0,
}

const eyebrowStyle: CSSProperties = {
    margin: '0 0 14px',
    color: '#525252',
    fontSize: 12,
    fontWeight: 700,
    letterSpacing: 0,
    textTransform: 'uppercase',
}

const dangerEyebrowStyle: CSSProperties = {
    ...eyebrowStyle,
    color: '#dc2626',
}

const bodyStyle: CSSProperties = {
    color: '#525252',
    lineHeight: 1.55,
    margin: '0 0 22px',
}

const subtleStyle: CSSProperties = {
    color: '#525252',
    lineHeight: 1.55,
    margin: 0,
}

const errorStyle: CSSProperties = {
    color: '#dc2626',
    lineHeight: 1.55,
}

const detailGridStyle: CSSProperties = {
    display: 'grid',
    gap: 12,
    border: '2px solid #000',
    borderRadius: 8,
    padding: 16,
    margin: '20px 0',
    background: '#FAF8F5',
}

const detailLabelStyle: CSSProperties = {
    color: '#525252',
    fontSize: 12,
    fontWeight: 700,
    textTransform: 'uppercase',
    letterSpacing: 0,
}

const detailValueStyle: CSSProperties = {
    color: '#1a1a1a',
    fontSize: 14,
    overflowWrap: 'anywhere',
    marginTop: 3,
}

const connectedStyle: CSSProperties = {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    color: '#1a1a1a',
    fontFamily: 'var(--font-mono)',
    fontSize: 13,
    margin: '10px 0 18px',
}

const connectedLabelStyle: CSSProperties = {
    color: '#525252',
    fontFamily: 'Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
    fontSize: 12,
    fontWeight: 700,
    textTransform: 'uppercase',
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
    border: '2px solid #000',
    background: '#e8ff57',
    color: '#1a1a1a',
    borderRadius: 8,
    boxShadow: '4px 4px 0 #000',
    padding: '12px 16px',
    fontWeight: 900,
    cursor: 'pointer',
}

const secondaryButtonStyle: CSSProperties = {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    border: '2px solid #000',
    background: '#fff',
    color: '#1a1a1a',
    borderRadius: 8,
    padding: '12px 16px',
    fontWeight: 800,
    cursor: 'pointer',
}
