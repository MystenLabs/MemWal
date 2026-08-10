/**
 * Connect Claude — consent screen for the MCP OAuth 2.1 flow
 * (`services/server/src/routes/oauth.rs`), used by Claude's native
 * custom-connector "Add" flow and any other OAuth-speaking MCP client.
 *
 * Unlike `ConnectMcp.tsx` (which drives itself entirely from query-string
 * params supplied by a local CLI process), this page takes a single opaque
 * `session` id and fetches everything it displays from the server
 * (`GET /api/oauth/session/{id}`). That's deliberate: WALM-288 found that
 * `/connect/mcp` trusted attacker-controlled query params for the consent
 * text, enabling a phishing link that granted a stranger persistent
 * account access. Nothing here is rendered from `useSearchParams()` except
 * the session id itself, which is meaningless without a valid, unexpired
 * server-side session row behind it.
 *
 * Flow:
 *   1. GET /api/oauth/session/{id} → client name (untrusted, labeled as
 *      such), the *server-validated* redirect host, scopes, delegate
 *      pubkey/address.
 *   2. User connects a Sui wallet.
 *   3. POST .../account {accountId, ownerAddress} → server checks whether
 *      this account already has an active OAuth delegate from a previous
 *      grant; if so, no on-chain tx is needed.
 *   4. If needed: sign `add_delegate_key` (identical tx shape to
 *      ConnectMcp.tsx), same sponsored-transaction path.
 *   5. POST .../complete {accountId, ownerAddress, txDigest} → server
 *      verifies on-chain, mints a one-time code, returns `redirect_url`.
 *   6. `window.location.replace(redirect_url)` — hands control back to
 *      Claude (or whatever OAuth client started the flow).
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import {
    ConnectModal,
    useCurrentAccount,
    useSuiClient,
} from '@mysten/dapp-kit'
import { Transaction } from '@mysten/sui/transactions'
import { Link, useSearchParams } from 'react-router-dom'
import { useSponsoredTransaction } from '../hooks/useSponsoredTransaction'
import { config } from '../config'
import { getAnalyticsErrorType, trackEvent } from '../utils/analytics'
import { fetchAccountIdForOwner } from '../utils/suiClientCompat'

const WALRUS_MEMORY_LOGO = '/walrus-memory-logo.svg'

type Step =
    | 'loading'
    | 'consent'
    | 'signing'
    | 'finishing'
    | 'redirecting'
    | 'no-account'
    | 'error'

interface SessionView {
    client_name: string
    redirect_host: string
    scopes: string[]
    delegate_public_key: string
    delegate_sui_address: string
    expires_at: string
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
        return await fetchAccountIdForOwner(suiClient, config.memwalRegistryId, ownerAddress)
    } catch {
        return null
    }
}

async function fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
    const res = await fetch(url, {
        ...init,
        headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) },
    })
    const body = await res.json().catch(() => null)
    if (!res.ok) {
        const description =
            body && typeof body === 'object' && 'error_description' in body
                ? String((body as { error_description: unknown }).error_description)
                : `request failed (${res.status})`
        throw new Error(description)
    }
    return body as T
}

export default function ConnectClaude() {
    const [params] = useSearchParams()
    const sessionId = params.get('session') ?? ''
    const currentAccount = useCurrentAccount()
    const suiClient = useSuiClient()
    const { mutateAsync: signAndExecute } = useSponsoredTransaction()

    const apiBase = config.memwalServerUrl.replace(/\/$/, '')

    const [step, setStep] = useState<Step>('loading')
    const [errorMsg, setErrorMsg] = useState('')
    const [walletPickerOpen, setWalletPickerOpen] = useState(false)
    const [session, setSession] = useState<SessionView | null>(null)

    const sessionValid = useMemo(() => /^mws_[A-Za-z0-9_-]{20,}$/.test(sessionId), [sessionId])

    useEffect(() => {
        if (!sessionValid) {
            setStep('error')
            setErrorMsg('This link is missing or malformed — ask the connecting app to start over.')
            return
        }
        let cancelled = false
        fetchJson<SessionView>(`${apiBase}/api/oauth/session/${sessionId}`)
            .then((view) => {
                if (cancelled) return
                setSession(view)
                setStep('consent')
            })
            .catch((err) => {
                if (cancelled) return
                setErrorMsg(err instanceof Error ? err.message : String(err))
                setStep('error')
            })
        return () => {
            cancelled = true
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [sessionValid, sessionId])

    // Persist the resume breadcrumb across the Enoki/Google OAuth redirect,
    // same mechanism `ConnectMcp.tsx` uses for `memwal_mcp_connect`.
    useEffect(() => {
        if (!sessionValid) return
        sessionStorage.setItem('memwal_claude_connect', JSON.stringify({ session: sessionId }))
    }, [sessionValid, sessionId])

    const handleConnect = useCallback(async () => {
        if (!session) return
        if (!currentAccount) {
            trackEvent('claude_connect_start', { wallet_connected: false })
            setWalletPickerOpen(true)
            return
        }

        trackEvent('claude_connect_start', { wallet_connected: true })
        setStep('signing')
        try {
            const accountId = await resolveAccountId(suiClient, currentAccount.address)
            if (!accountId) {
                trackEvent('claude_connect_failed', { error_type: 'no_account' })
                setStep('no-account')
                return
            }

            const preflight = await fetchJson<{
                needs_onchain_registration: boolean
                delegate_public_key: string
                delegate_sui_address: string
            }>(`${apiBase}/api/oauth/session/${sessionId}/account`, {
                method: 'POST',
                body: JSON.stringify({ account_id: accountId, owner_address: currentAccount.address }),
            })

            let txDigest = ''
            if (preflight.needs_onchain_registration) {
                const tx = new Transaction()
                tx.moveCall({
                    target: `${config.memwalPackageId}::account::add_delegate_key`,
                    arguments: [
                        tx.object(accountId),
                        tx.pure('vector<u8>', hexToBytes(preflight.delegate_public_key)),
                        tx.pure('address', preflight.delegate_sui_address),
                        tx.pure('string', `Claude (${new Date().toISOString().slice(0, 10)})`),
                        tx.object('0x6'),
                    ],
                })
                let result
                try {
                    result = await signAndExecute({ transaction: tx })
                } catch (txErr: unknown) {
                    const m = txErr instanceof Error ? txErr.message : String(txErr)
                    if (m.includes('abort code: 0') && m.includes('add_delegate_key')) {
                        setErrorMsg(
                            `This wallet (${currentAccount.address.slice(0, 10)}…${currentAccount.address.slice(-6)}) is not the owner of Walrus Memory account ${accountId.slice(0, 10)}…${accountId.slice(-6)}. ` +
                            `Switch to the wallet that created this account, or run /setup for a new one.`
                        )
                        trackEvent('claude_connect_failed', { error_type: 'owner_mismatch' })
                        setStep('error')
                        return
                    }
                    if (m.includes('abort code: 2') && m.includes('add_delegate_key')) {
                        setErrorMsg(
                            `This account already has the maximum number of delegate keys (20). Go to /dashboard and revoke an unused key, then try again.`
                        )
                        trackEvent('claude_connect_failed', { error_type: 'max_delegate_keys' })
                        setStep('error')
                        return
                    }
                    throw txErr
                }
                await suiClient.waitForTransaction({ digest: result.digest })
                txDigest = result.digest
            }

            setStep('finishing')
            const { redirect_url } = await fetchJson<{ redirect_url: string }>(
                `${apiBase}/api/oauth/session/${sessionId}/complete`,
                {
                    method: 'POST',
                    body: JSON.stringify({
                        account_id: accountId,
                        owner_address: currentAccount.address,
                        tx_digest: txDigest || 'reused-delegate',
                    }),
                },
            )
            sessionStorage.removeItem('memwal_claude_connect')
            setStep('redirecting')
            trackEvent('claude_connect_complete', { reused_delegate: !preflight.needs_onchain_registration })
            window.location.replace(redirect_url)
        } catch (err) {
            setErrorMsg(err instanceof Error ? err.message : String(err))
            setStep('error')
            trackEvent('claude_connect_failed', { error_type: getAnalyticsErrorType(err) })
        }
    }, [session, currentAccount, suiClient, signAndExecute, apiBase, sessionId])

    const handleCancel = useCallback(async () => {
        try {
            const { redirect_url } = await fetchJson<{ redirect_url: string }>(
                `${apiBase}/api/oauth/session/${sessionId}/cancel`,
                { method: 'POST', body: JSON.stringify({ error: 'access_denied' }) },
            )
            trackEvent('cta_click', { cta: 'claude_connect_deny', location: 'connect_claude' })
            window.location.replace(redirect_url)
        } catch {
            // Session already consumed/expired — nothing sensible to redirect
            // to. Leave the user on this page rather than guessing a URL.
        }
    }, [apiBase, sessionId])

    // Auto-proceed once the wallet popup resolves.
    useEffect(() => {
        if (!walletPickerOpen && currentAccount && step === 'consent') {
            void handleConnect()
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [walletPickerOpen, currentAccount])

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
                        <div className="setup-classic-intro">
                            <h2 className="setup-classic-title">Loading…</h2>
                        </div>
                    )}

                    {step === 'consent' && session && (
                        <ConsentCard session={session} wallet={currentAccount?.address ?? null} onConnect={handleConnect} onCancel={handleCancel} />
                    )}

                    {step === 'signing' && (
                        <div className="setup-classic-intro">
                            <h2 className="setup-classic-title">Confirm in your wallet…</h2>
                            <p className="setup-classic-description">
                                A wallet popup is registering this delegate key on chain. Approve the transaction to continue.
                            </p>
                        </div>
                    )}

                    {step === 'finishing' && (
                        <div className="setup-classic-intro">
                            <h2 className="setup-classic-title">Finishing up…</h2>
                            <p className="setup-classic-description">Verifying on-chain and handing back to the connecting app.</p>
                        </div>
                    )}

                    {step === 'redirecting' && (
                        <div className="setup-classic-intro">
                            <h2 className="setup-classic-title"><span style={{ color: '#22c55e' }}>✓</span> Connected</h2>
                            <p className="setup-classic-description">Redirecting you back…</p>
                        </div>
                    )}

                    {step === 'no-account' && (
                        <div className="setup-classic-intro">
                            <h2 className="setup-classic-title">Create a Walrus Memory account first</h2>
                            <p className="setup-classic-description">
                                This wallet doesn't have a Walrus Memory account yet. Run through the one-time setup, then come back here.
                            </p>
                            <div className="setup-classic-actions">
                                <Link to="/setup" className="lp-btn-yellow">Create account</Link>
                            </div>
                        </div>
                    )}

                    {step === 'error' && (
                        <div className="setup-classic-intro">
                            <h2 className="setup-classic-title">Something went wrong</h2>
                            <p className="setup-classic-description" style={errorTextStyle}>{errorMsg}</p>
                        </div>
                    )}
                </div>
            </main>

            <ConnectModal trigger={<></>} open={walletPickerOpen} onOpenChange={setWalletPickerOpen} />
        </div>
    )
}

function ConsentCard({
    session,
    wallet,
    onConnect,
    onCancel,
}: {
    session: SessionView
    wallet: string | null
    onConnect: () => void
    onCancel: () => void
}) {
    return (
        <div className="setup-classic-intro">
            <h2 className="setup-classic-title">Connect to Walrus Memory</h2>
            <p className="setup-classic-description">
                <strong style={{ color: '#faf8f5' }}>{session.client_name}</strong>{' '}
                <span style={{ color: '#8f9294' }}>(name supplied by the connecting app — not verified by Walrus Memory)</span>{' '}
                wants access to your Walrus Memory account.
            </p>

            <div className="card setup-classic-feature-card">
                <p style={cardLabelStyle}>This grants persistent access, until you revoke it</p>
                <ul style={permListStyle}>
                    {session.scopes.includes('memwal:read') && <li>✓ Read your memories</li>}
                    {session.scopes.includes('memwal:write') && <li>✓ Save new memories</li>}
                    <li>✓ Walrus Memory will hold an encrypted key on your behalf to authorize these actions — it never leaves our servers, and you can revoke it from the dashboard at any time</li>
                </ul>

                <div style={dividerStyle} />

                <p style={cardLabelStyle}>Verified redirect destination</p>
                <div style={detailRowStyle}>
                    <span style={detailValueStyle}>{session.redirect_host}</span>
                </div>

                <div style={dividerStyle} />

                <p style={cardLabelStyle}>Connected wallet</p>
                <div style={detailRowStyle}>
                    <span style={detailValueStyle}>
                        {wallet ? `${wallet.slice(0, 12)}…${wallet.slice(-6)}` : '(not connected yet)'}
                    </span>
                </div>
            </div>

            <div className="setup-classic-actions" style={{ display: 'flex', gap: 12 }}>
                <button onClick={onConnect} className="lp-btn-yellow">
                    {wallet ? 'Approve' : 'Connect Sui wallet'}
                </button>
                <button onClick={onCancel} className="lp-btn-yellow" style={{ background: 'transparent', color: '#8f9294' }}>
                    Deny
                </button>
            </div>
        </div>
    )
}

const cardLabelStyle: React.CSSProperties = {
    margin: '0 0 10px',
    fontFamily: 'var(--font-mono)',
    fontSize: '0.7rem',
    fontWeight: 600,
    textTransform: 'uppercase',
    letterSpacing: '0.08em',
    color: '#8f9294',
}

const permListStyle: React.CSSProperties = {
    listStyle: 'none',
    padding: 0,
    margin: 0,
    lineHeight: 1.7,
    fontSize: '0.9rem',
    color: '#faf8f5',
}

const dividerStyle: React.CSSProperties = {
    height: 1,
    background: '#2a2c2e',
    margin: '18px 0',
}

const detailRowStyle: React.CSSProperties = {
    display: 'flex',
    flexDirection: 'column',
    gap: 2,
    marginBottom: 12,
}

const detailValueStyle: React.CSSProperties = {
    fontFamily: 'var(--font-mono)',
    fontSize: '0.84rem',
    color: '#faf8f5',
    wordBreak: 'break-all',
}

const errorTextStyle: React.CSSProperties = {
    color: '#ff6b6b',
}
