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
import { fetchAccountIdForOwner, fetchObjectJson } from '../utils/suiClientCompat'

// Walrus Memory wordmark (public asset, same one the dashboard/MCP connect nav uses).
const WALRUS_MEMORY_LOGO = '/walrus-memory-logo.svg'

type Step = 'loading' | 'consent' | 'registering' | 'redirecting' | 'error'
type Provider = 'wallet' | 'google'

const MAX_DELEGATE_KEYS = 20
const MAX_DELEGATE_KEYS_MESSAGE =
    `This Walrus Memory account already has ${MAX_DELEGATE_KEYS} delegate keys. ` +
    'Open the dashboard and remove an unused key, then retry Connect App.'

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
        return await fetchAccountIdForOwner(suiClient, config.memwalRegistryId, ownerAddress)
    } catch {
        return null
    }
}

async function fetchDelegateKeyCount(
    suiClient: ReturnType<typeof useSuiClient>,
    accountId: string,
): Promise<number> {
    const json = await fetchObjectJson(suiClient, accountId) as { delegate_keys?: unknown[] } | null
    return Array.isArray(json?.delegate_keys) ? json.delegate_keys.length : 0
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
    const [delegateKeyCount, setDelegateKeyCount] = useState<number | null>(null)
    const [checkingDelegateKeys, setCheckingDelegateKeys] = useState(false)

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
    const hasMaxDelegateKeys = delegateKeyCount !== null && delegateKeyCount >= MAX_DELEGATE_KEYS

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

    useEffect(() => {
        let cancelled = false

        if (!currentAccount) {
            setDelegateKeyCount(null)
            setCheckingDelegateKeys(false)
            return () => {
                cancelled = true
            }
        }

        setCheckingDelegateKeys(true)
        setDelegateKeyCount(null)

        ;(async () => {
            try {
                const accountId = await resolveAccountId(suiClient, currentAccount.address)
                if (!accountId) {
                    if (!cancelled) setDelegateKeyCount(0)
                    return
                }
                const count = await fetchDelegateKeyCount(suiClient, accountId)
                if (!cancelled) setDelegateKeyCount(count)
            } catch {
                if (!cancelled) setDelegateKeyCount(null)
            } finally {
                if (!cancelled) setCheckingDelegateKeys(false)
            }
        })()

        return () => {
            cancelled = true
        }
    }, [currentAccount, suiClient])

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
                addTx.object(config.memwalRegistryId),
                addTx.pure('vector<u8>', publicKeyBytes),
                // v1_new derives the Sui address on-chain — no address arg.
                addTx.pure('string', session.label),
                addTx.object('0x6'),
            ],
        })
        let addResult
        try {
            addResult = await signAndExecute({ transaction: addTx })
        } catch (txErr) {
            if (isAddDelegateAbort(txErr, 2)) {
                throw new Error(MAX_DELEGATE_KEYS_MESSAGE)
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
        if (hasMaxDelegateKeys) {
            setErrorMsg(MAX_DELEGATE_KEYS_MESSAGE)
            setStep('error')
            return
        }
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
    }, [currentAccount, hasMaxDelegateKeys, provider, registerDelegate, session])

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
        <div className="setup-classic">
            <nav className="nav setup-classic-nav">
                <div className="nav-inner">
                    <Link to="/" className="nav-brand">
                        <img className="nav-brand-logo" src={WALRUS_MEMORY_LOGO} alt="Walrus Memory" />
                    </Link>
                </div>
            </nav>

            <main className="container setup-classic-container">
                <div className="setup-classic-panel">
                    {step === 'loading' && (
                        <div className="setup-classic-intro" aria-busy="true">
                            <h2 className="setup-classic-title">Checking app request</h2>
                            <p className="setup-classic-description">Walrus Memory is validating this connection request.</p>
                        </div>
                    )}

                    {step === 'consent' && session && (
                        <div className="setup-classic-intro">
                            <h2 className="setup-classic-title">Connect Walrus Memory</h2>
                            <p className="setup-classic-description">
                                {session.client.display_name} wants to connect to your Walrus Memory account.
                            </p>

                            <div className="card setup-classic-feature-card">
                                <p style={cardLabelStyle}>Request details</p>
                                <div style={detailRowStyle}>
                                    <span style={detailLabelStyle}>App</span>
                                    <span style={detailValueStyle}>{session.client.display_name}</span>
                                </div>
                                <div style={detailRowStyle}>
                                    <span style={detailLabelStyle}>Return origin</span>
                                    <span style={detailValueStyle}>{session.redirect_host}</span>
                                </div>
                                <div style={detailRowStyle}>
                                    <span style={detailLabelStyle}>Delegate label</span>
                                    <span style={detailValueStyle}>{session.label}</span>
                                </div>
                                <div style={detailRowStyle}>
                                    <span style={detailLabelStyle}>Delegate public key</span>
                                    <span style={detailValueStyle}>
                                        {session.delegate.public_key.slice(0, 16)}…{session.delegate.public_key.slice(-12)}
                                    </span>
                                </div>
                                <div style={{ ...detailRowStyle, marginBottom: 0 }}>
                                    <span style={detailLabelStyle}>Wallet</span>
                                    <span style={detailValueStyle}>
                                        {currentAccount ? `${currentAccount.address.slice(0, 8)}…${currentAccount.address.slice(-6)}` : '(not connected yet)'}
                                    </span>
                                </div>
                            </div>

                            {!currentAccount ? (
                                <div className="setup-classic-actions">
                                    {hasGoogle && (
                                        <button className="btn-google" onClick={handleGoogleConnect}>
                                            <svg width="20" height="20" viewBox="0 0 24 24" aria-hidden="true">
                                                <path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 0 1-2.2 3.32v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.1z" fill="#4285F4" />
                                                <path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" fill="#34A853" />
                                                <path d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z" fill="#FBBC05" />
                                                <path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" fill="#EA4335" />
                                            </svg>
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
                                    {checkingDelegateKeys && (
                                        <p style={capacityNoteStyle}>Checking delegate key capacity…</p>
                                    )}
                                    {hasMaxDelegateKeys && (
                                        <p style={capacityErrorStyle}>{MAX_DELEGATE_KEYS_MESSAGE}</p>
                                    )}
                                    <div className="setup-classic-actions">
                                        <button
                                            className="lp-btn-yellow"
                                            style={checkingDelegateKeys || hasMaxDelegateKeys ? disabledPrimaryStyle : undefined}
                                            onClick={handleAuthorize}
                                            disabled={checkingDelegateKeys || hasMaxDelegateKeys}
                                        >
                                            {checkingDelegateKeys ? 'Checking account' : 'Authorize app'}
                                        </button>
                                        <button style={secondaryButtonStyle} onClick={() => redirectWithError('access_denied')}>
                                            Cancel
                                        </button>
                                    </div>
                                </>
                            )}
                        </div>
                    )}

                    {step === 'registering' && (
                        <div className="setup-classic-intro" aria-busy="true">
                            <h2 className="setup-classic-title">Registering delegate</h2>
                            <p className="setup-classic-description">
                                Walrus Memory is adding an app-specific delegate key on-chain.
                            </p>
                        </div>
                    )}

                    {step === 'redirecting' && (
                        <div className="setup-classic-intro">
                            <h2 className="setup-classic-title">
                                <span style={{ color: '#22c55e' }}>✓</span> Connected
                            </h2>
                            <p className="setup-classic-description">Returning to the app.</p>
                        </div>
                    )}

                    {step === 'error' && (
                        <div className="setup-classic-intro">
                            <h2 className="setup-classic-title">Connection failed</h2>
                            <p className="setup-classic-description" style={errorTextStyle}>
                                {errorMsg || 'This app connection request could not be completed.'}
                            </p>
                            {session ? (
                                <div className="setup-classic-actions">
                                    <button className="lp-btn-yellow" onClick={() => setStep('consent')}>
                                        Try again
                                    </button>
                                    <button style={secondaryButtonStyle} onClick={() => redirectWithError('delegate_setup_failed')}>
                                        Return to app
                                    </button>
                                </div>
                            ) : (
                                <p className="setup-classic-description">
                                    Walrus Memory did not redirect because the app request was not safe.
                                </p>
                            )}
                        </div>
                    )}
                </div>
            </main>
        </div>
    )
}

// ---------- inline styles for bits the .setup-classic design system doesn't class ----------
// Reuses the SetupWizard/ConnectMcp dark theme (.setup-classic, .setup-classic-*,
// .card.setup-classic-feature-card, .lp-btn-yellow) so the app-auth consent screen is
// visually identical to the rest of the Walrus Memory connect flow.

const cardLabelStyle: CSSProperties = {
    margin: '0 0 10px',
    fontFamily: 'var(--font-mono)',
    fontSize: '0.7rem',
    fontWeight: 600,
    textTransform: 'uppercase',
    letterSpacing: '0.08em',
    color: '#8f9294',
}

const detailRowStyle: CSSProperties = {
    display: 'flex',
    flexDirection: 'column',
    gap: 2,
    marginBottom: 12,
}

const detailLabelStyle: CSSProperties = {
    fontFamily: 'var(--font-mono)',
    fontSize: '0.7rem',
    textTransform: 'uppercase',
    letterSpacing: '0.06em',
    color: '#8f9294',
}

const detailValueStyle: CSSProperties = {
    fontFamily: 'var(--font-mono)',
    fontSize: '0.84rem',
    color: '#faf8f5',
    wordBreak: 'break-all',
}

const errorTextStyle: CSSProperties = {
    color: '#ff6b6b',
}

const capacityNoteStyle: CSSProperties = {
    border: '1px solid #54575a',
    borderRadius: 12,
    background: '#0a0a0a',
    color: '#c7c5c1',
    fontSize: '0.85rem',
    lineHeight: 1.5,
    margin: '0 0 20px',
    padding: '12px 14px',
}

const capacityErrorStyle: CSSProperties = {
    border: '2px solid var(--danger-border)',
    borderRadius: 12,
    background: 'rgba(239, 68, 68, 0.08)',
    color: '#fca5a5',
    fontSize: '0.85rem',
    fontWeight: 600,
    lineHeight: 1.5,
    margin: '0 0 20px',
    padding: '12px 14px',
}

const disabledPrimaryStyle: CSSProperties = {
    background: '#3a3a3a',
    color: '#8a8a8a',
    borderColor: '#3a3a3a',
    boxShadow: 'none',
    cursor: 'not-allowed',
}

const secondaryButtonStyle: CSSProperties = {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    background: 'transparent',
    color: '#faf8f5',
    border: '2px solid rgba(250, 248, 245, 0.35)',
    borderRadius: 12,
    padding: '12px 26px',
    fontSize: '0.94rem',
    fontWeight: 600,
    fontFamily: 'var(--font-sans)',
    cursor: 'pointer',
}
