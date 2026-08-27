/**
 * Connect MCP — browser-based wallet sign-in flow for the `@mysten-incubation/memwal-mcp`
 * stdio bridge.
 *
 * The MCP package opens this page in the user's browser with a query string:
 *
 *   /connect/mcp?port=17463
 *               &publicKey=<64-hex Ed25519 pub>
 *               &label=<URL-encoded label>
 *               &relayer=<URL-encoded relayer base URL>
 *               &connectState=<64-hex CSRF token>  (legacy bridges: `state`)
 *
 * Flow:
 *   1. Verify the exact state/public-key tuple against the localhost MCP
 *      bridge. A copied/emailed URL has no matching bridge and fails closed.
 *   2. Render consent screen — show requested permissions + the full delegate
 *      public key/address returned by the verified bridge.
 *   3. User clicks "Connect Sui Wallet" → standard dApp Kit wallet popup.
 *   4. Build + sign `add_delegate_key(account, registry, publicKey, label, clock)`
 *      via useSponsoredTransaction (matches SetupWizard pattern).
 *   5. POST result {accountId, walletAddress, packageId, txDigest, label}
 *      to http://localhost:<port>/callback — the MCP package's listener.
 *   6. Show success screen — user can close the tab.
 *
 * Error paths:
 *   - Wallet not connected → wallet picker.
 *   - User has no Walrus Memory account yet → link to /setup.
 *   - Wallet rejects tx → retry button.
 *   - localhost callback unreachable or refused → on-chain key stands but never
 *     reaches the client; send the user back through sign-in.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
    ConnectModal,
    useCurrentAccount,
    useSuiClient,
} from '@mysten/dapp-kit'
import { Transaction } from '@mysten/sui/transactions'
import { Ed25519PublicKey } from '@mysten/sui/keypairs/ed25519'
import { Link, useSearchParams } from 'react-router-dom'
import { useSponsoredTransaction } from '../hooks/useSponsoredTransaction'
import { config } from '../config'
import { getAnalyticsErrorType, trackEvent } from '../utils/analytics'
import { fetchAccountIdForOwner } from '../utils/suiClientCompat'

// Walrus Memory wordmark (public asset, same one the dashboard nav uses).
const WALRUS_MEMORY_LOGO = '/walrus-memory-logo.svg'

type Step =
    | 'verifying'
    | 'consent'
    | 'signing'
    | 'callback'
    | 'success'
    | 'no-account'
    | 'error'

/** Hand-off result; the two failures have different causes, so not one boolean. */
type CallbackOutcome = 'delivered' | 'unreachable' | 'rejected'

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

interface McpCallbackPayload {
    accountId: string
    walletAddress: string
    packageId: string
    txDigest: string
    label: string
    /** Echoes the state token the bridge issued in the query string. */
    state: string
}

interface VerifiedBridge {
    publicKey: string
    label: string
    relayer: string
}

function isVerifiedBridge(
    value: unknown,
    expectedPublicKey: string,
    expectedRelayer: string,
): value is VerifiedBridge & { ok: true } {
    if (!value || typeof value !== 'object') return false
    const candidate = value as Record<string, unknown>
    return (
        candidate.ok === true &&
        typeof candidate.publicKey === 'string' &&
        candidate.publicKey.toLowerCase() === expectedPublicKey.toLowerCase() &&
        typeof candidate.label === 'string' &&
        candidate.label.length > 0 &&
        typeof candidate.relayer === 'string' &&
        candidate.relayer.replace(/\/+$/, '') === expectedRelayer.replace(/\/+$/, '')
    )
}

export default function ConnectMcp() {
    const [params] = useSearchParams()
    const currentAccount = useCurrentAccount()
    const suiClient = useSuiClient()
    const { mutateAsync: signAndExecute } = useSponsoredTransaction()

    const port = params.get('port') ?? ''
    const publicKey = params.get('publicKey') ?? ''
    const relayer = params.get('relayer') ?? config.memwalServerUrl
    /**
     * Cryptographic state token from the MCP bridge. Must be echoed verbatim
     * in the callback POST — the bridge constant-time compares it to defeat
     * cross-origin CSRF (audit C2). Empty string if absent (older bridge);
     * the bridge will then reject our callback with 400.
     *
     * Read from `connectState` (current bridge) with a fallback to the legacy
     * `state` param. The bridge renamed this param away from `state` because
     * `state` is a reserved OAuth 2.0 response parameter: when this page starts
     * Enoki/Google sign-in it reuses the current URL as the OAuth redirect_uri,
     * and Google rejects any redirect_uri carrying a reserved param (WALM-86:
     * "Access blocked: invalid_request — Invalid redirect_uri contains reserved
     * response param state"). We still echo it back in the POST body as `state`.
     */
    const state = params.get('connectState') ?? params.get('state') ?? ''

    const [step, setStep] = useState<Step>('verifying')
    const [errorMsg, setErrorMsg] = useState('')
    const [walletPickerOpen, setWalletPickerOpen] = useState(false)
    const [callbackPayload, setCallbackPayload] = useState<McpCallbackPayload | null>(null)
    const [callbackOutcome, setCallbackOutcome] = useState<CallbackOutcome | null>(null)
    const [verifiedBridge, setVerifiedBridge] = useState<VerifiedBridge | null>(null)
    const [preflightAttempt, setPreflightAttempt] = useState(0)
    const invalidRequestTrackedRef = useRef(false)

    // Validate query string up-front.
    const paramsValid = useMemo(() => {
        const portNum = Number(port)
        return (
            Number.isFinite(portNum) &&
            portNum > 1024 &&
            portNum < 65536 &&
            /^[0-9a-fA-F]{64}$/.test(publicKey) &&
            // delegateAddress is derived on-chain (v1_new) and no longer sent
            // in the tx, so it is not required for a valid request.
            // State token is a 32-byte hex string emitted by the MCP bridge.
            // Old bridges without state will fail this check — by design;
            // forces a bridge upgrade so we never accept stateless callbacks.
            /^[0-9a-f]{64}$/.test(state)
        )
    }, [port, publicKey, state])

    // Never trust/display the legacy delegateAddress query parameter. The
    // contract derives this same Sui address from the Ed25519 public key.
    const delegateAddress = useMemo(() => {
        if (!/^[0-9a-fA-F]{64}$/.test(publicKey)) return ''
        return new Ed25519PublicKey(Uint8Array.from(hexToBytes(publicKey))).toSuiAddress()
    }, [publicKey])

    useEffect(() => {
        if (!paramsValid) {
            setVerifiedBridge(null)
            return
        }
        const controller = new AbortController()
        setStep('verifying')
        setErrorMsg('')
        setVerifiedBridge(null)

        void (async () => {
            try {
                const response = await fetch(`http://127.0.0.1:${port}/preflight`, {
                    method: 'POST',
                    headers: { 'content-type': 'application/json' },
                    body: JSON.stringify({ state, publicKey, relayer }),
                    signal: controller.signal,
                })
                const body: unknown = await response.json().catch(() => null)
                if (!response.ok || !isVerifiedBridge(body, publicKey, relayer)) {
                    throw new Error('The local MCP bridge did not verify this connection request.')
                }
                setVerifiedBridge({
                    publicKey: body.publicKey,
                    label: body.label,
                    relayer: body.relayer,
                })
                setStep('consent')
            } catch (error) {
                if (controller.signal.aborted) return
                setVerifiedBridge(null)
                const openedTooLate = error instanceof TypeError
                setErrorMsg(
                    openedTooLate
                        ? 'Nothing answered on your computer. Sign-in links stop working after five minutes, so most often the link was simply opened too late.'
                        : error instanceof Error
                          ? error.message
                          : 'Could not verify the local MCP bridge.',
                )
                setStep('error')
                trackEvent('mcp_connect_failed', { error_type: 'bridge_preflight_failed' })
            }
        })()

        return () => controller.abort()
    }, [paramsValid, port, preflightAttempt, publicKey, relayer, state])

    const postCallback = useCallback(
        async (payload: McpCallbackPayload): Promise<boolean> => {
            try {
                const res = await fetch(`http://127.0.0.1:${port}/callback`, {
                    method: 'POST',
                    headers: { 'content-type': 'application/json' },
                    body: JSON.stringify(payload),
                })
                // A listener answered and refused — different cause than nothing answering.
                setCallbackOutcome(res.ok ? 'delivered' : 'rejected')
                return res.ok
            } catch {
                setCallbackOutcome('unreachable')
                return false
            }
        },
        [port],
    )

    const handleConnect = useCallback(async () => {
        if (!paramsValid || !verifiedBridge) {
            trackEvent('mcp_connect_failed', { error_type: 'invalid_request' })
            setErrorMsg('This request was not verified by the local MCP client.')
            setStep('error')
            return
        }
        if (!currentAccount) {
            trackEvent('mcp_connect_start', { wallet_connected: false })
            setWalletPickerOpen(true)
            return
        }

        trackEvent('mcp_connect_start', { wallet_connected: true })
        setStep('signing')
        try {
            // Resolve the user's Walrus Memory account object.
            const accountId = await resolveAccountId(suiClient, currentAccount.address)
            if (!accountId) {
                trackEvent('mcp_connect_failed', { error_type: 'no_account' })
                setStep('no-account')
                return
            }

            // Build + sign add_delegate_key tx.
            const tx = new Transaction()
            tx.moveCall({
                target: `${config.memwalPackageId}::account::add_delegate_key`,
                arguments: [
                    tx.object(accountId),
                    tx.object(config.memwalRegistryId),
                    tx.pure('vector<u8>', hexToBytes(verifiedBridge.publicKey)),
                    // v1_new derives the Sui address on-chain — no address arg.
                    tx.pure('string', verifiedBridge.label),
                    tx.object('0x6'),
                ],
            })
            let result
            try {
                result = await signAndExecute({ transaction: tx })
            } catch (txErr: unknown) {
                const m = txErr instanceof Error ? txErr.message : String(txErr)
                // Friendly mapping for common contract aborts.
                if (m.includes('abort code: 0') && m.includes('add_delegate_key')) {
                    setErrorMsg(
                        `This wallet (${currentAccount.address.slice(0, 10)}…${currentAccount.address.slice(-6)}) is not the owner of Walrus Memory account ${accountId.slice(0, 10)}…${accountId.slice(-6)}. ` +
                        `Switch your wallet to the account that originally created this Walrus Memory account, OR run /setup to create a new Walrus Memory account for the current wallet.`
                    )
                    trackEvent('mcp_connect_failed', { error_type: 'owner_mismatch' })
                    setStep('error')
                    return
                }
                if (m.includes('abort code: 2') && m.includes('add_delegate_key')) {
                    setErrorMsg(
                        `This Walrus Memory account already has the maximum number of delegate keys (20). Go to /dashboard and revoke an unused key, then try again.`
                    )
                    trackEvent('mcp_connect_failed', { error_type: 'max_delegate_keys' })
                    setStep('error')
                    return
                }
                throw txErr
            }
            await suiClient.waitForTransaction({ digest: result.digest })

            const payload: McpCallbackPayload = {
                accountId,
                walletAddress: currentAccount.address,
                packageId: config.memwalPackageId,
                txDigest: result.digest,
                label: verifiedBridge.label,
                state,
            }
            setCallbackPayload(payload)
            setStep('callback')
            const delivered = await postCallback(payload)
            // Flow done — drop the OAuth-resume breadcrumb so a later visit to
            // `/` goes to the dashboard instead of looping back here.
            sessionStorage.removeItem('memwal_mcp_connect')
            setStep('success')
            trackEvent('mcp_connect_complete', { callback_delivered: delivered })
        } catch (err) {
            setErrorMsg(err instanceof Error ? err.message : String(err))
            setStep('error')
            trackEvent('mcp_connect_failed', { error_type: getAnalyticsErrorType(err) })
        }
    }, [
        paramsValid,
        currentAccount,
        suiClient,
        signAndExecute,
        verifiedBridge,
        state,
        postCallback,
    ])

    useEffect(() => {
        if (paramsValid || invalidRequestTrackedRef.current) return
        invalidRequestTrackedRef.current = true
        trackEvent('mcp_connect_failed', { error_type: 'invalid_request' })
    }, [paramsValid])

    // Persist the connect request so it survives the Google OAuth redirect.
    // Enoki's redirect_uri is pinned to the app root (App.tsx), so signing in
    // with Google leaves this page and returns to `/` — losing the query
    // string. App's PostAuthRedirect reads this back and re-opens
    // /connect/mcp with the params restored. Keyed identically to the URL
    // params (note `connectState`, not `state`). Cleared on success below.
    useEffect(() => {
        if (!paramsValid) return
        sessionStorage.setItem(
            'memwal_mcp_connect',
            JSON.stringify({ port, publicKey, delegateAddress, relayer, connectState: state }),
        )
    }, [paramsValid, port, publicKey, delegateAddress, relayer, state])

    // If the wallet popup completes after we asked it to open, auto-proceed.
    useEffect(() => {
        if (!walletPickerOpen && currentAccount && step === 'consent') {
            // user picked a wallet — kick off the connect flow.
            void handleConnect()
        }
        // we only want this to fire on wallet→connected transition.
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
                    {!paramsValid && (
                        <div className="setup-classic-intro">
                            <h2 className="setup-classic-title">Invalid request</h2>
                            <p className="setup-classic-description">
                                This page must be opened by the{' '}
                                <code style={codeStyle}>@mysten-incubation/memwal-mcp</code> package during its login flow.
                            </p>
                            <div className="card setup-classic-feature-card">
                                <div style={detailRowStyle}>
                                    <span style={detailLabelStyle}>Got</span>
                                    <span style={detailValueStyle}>
                                        port={port || '(none)'} · publicKey={publicKey ? publicKey.slice(0, 12) + '…' : '(none)'}
                                    </span>
                                </div>
                            </div>
                        </div>
                    )}

                    {paramsValid && step === 'verifying' && (
                        <div className="setup-classic-intro">
                            <h2 className="setup-classic-title">Verifying local MCP client…</h2>
                            <p className="setup-classic-description">
                                Checking that this request came from an MCP login listener running on this device.
                            </p>
                        </div>
                    )}

                    {paramsValid && step === 'consent' && verifiedBridge && (
                        <ConsentCard
                            label={verifiedBridge.label}
                            publicKey={verifiedBridge.publicKey}
                            delegateAddress={delegateAddress}
                            relayer={verifiedBridge.relayer}
                            wallet={currentAccount?.address ?? null}
                            onConnect={handleConnect}
                        />
                    )}

                    {paramsValid && step === 'signing' && (
                        <div className="setup-classic-intro">
                            <h2 className="setup-classic-title">Confirm in your wallet…</h2>
                            <p className="setup-classic-description">
                                A wallet popup is registering this delegate key on chain. Approve the transaction to continue.
                            </p>
                        </div>
                    )}

                    {paramsValid && step === 'callback' && (
                        <div className="setup-classic-intro">
                            <h2 className="setup-classic-title">Wrapping up…</h2>
                            <p className="setup-classic-description">Sending credentials back to your MCP client.</p>
                        </div>
                    )}

                    {paramsValid && step === 'success' && callbackPayload && (
                        <SuccessCard
                            payload={callbackPayload}
                            callbackOutcome={callbackOutcome}
                            port={port}
                        />
                    )}

                    {paramsValid && step === 'no-account' && (
                        <div className="setup-classic-intro">
                            <h2 className="setup-classic-title">Create a Walrus Memory account first</h2>
                            <p className="setup-classic-description">
                                This wallet doesn't have a Walrus Memory account yet. Run through the one-time setup, then we'll bring you back here to finish connecting.
                            </p>
                            <div className="setup-classic-actions">
                                <Link
                                    to="/setup"
                                    className="lp-btn-yellow"
                                    onClick={() => trackEvent('cta_click', { cta: 'mcp_create_account', location: 'connect_mcp' })}
                                >
                                    Create account and continue
                                </Link>
                            </div>
                        </div>
                    )}

                    {paramsValid && step === 'error' && (
                        <div className="setup-classic-intro">
                            <h2 className="setup-classic-title">Something went wrong</h2>
                            <p className="setup-classic-description" style={errorTextStyle}>{errorMsg}</p>
                            <div className="setup-classic-actions">
                                <button
                                    className="lp-btn-yellow"
                                    onClick={() => {
                                        trackEvent('cta_click', { cta: 'mcp_retry', location: 'connect_mcp' })
                                        setErrorMsg('')
                                        if (verifiedBridge) {
                                            setStep('consent')
                                        } else {
                                            setPreflightAttempt(attempt => attempt + 1)
                                        }
                                    }}
                                >
                                    Try again
                                </button>
                            </div>
                        </div>
                    )}
                </div>
            </main>

            <ConnectModal
                trigger={<></>}
                open={walletPickerOpen}
                onOpenChange={setWalletPickerOpen}
            />
        </div>
    )
}

function ConsentCard({
    label,
    publicKey,
    delegateAddress,
    relayer,
    wallet,
    onConnect,
}: {
    label: string
    publicKey: string
    delegateAddress: string
    relayer: string
    wallet: string | null
    onConnect: () => void
}) {
    return (
        <div className="setup-classic-intro">
            <h2 className="setup-classic-title">
                A local MCP client is requesting access
            </h2>
            <p className="setup-classic-description">
                This local app calls itself <code style={codeStyle}>{label}</code>. This name is not verified.
                Approving grants persistent access until you revoke the delegate key on-chain.
            </p>

            <div className="card setup-classic-feature-card">
                <p style={cardLabelStyle}>Permissions requested</p>
                <ul style={permListStyle}>
                    <li>✓ Read and decrypt all your memories (<code style={codeStyle}>memwal_recall</code>)</li>
                    <li>✓ Write new memories (<code style={codeStyle}>memwal_remember</code>)</li>
                    <li>✓ Extract facts from text (<code style={codeStyle}>memwal_analyze</code>)</li>
                    <li>✓ Re-index from Walrus (<code style={codeStyle}>memwal_restore</code>)</li>
                </ul>

                <div style={dividerStyle} />

                <p style={cardLabelStyle}>Details</p>
                <div style={detailRowStyle}>
                    <span style={detailLabelStyle}>Relayer</span>
                    <span style={detailValueStyle}>{relayer}</span>
                </div>
                <div style={detailRowStyle}>
                    <span style={detailLabelStyle}>Delegate public key</span>
                    <span style={{ ...detailValueStyle, overflowWrap: 'anywhere' }}>{publicKey}</span>
                </div>
                <div style={detailRowStyle}>
                    <span style={detailLabelStyle}>Delegate address</span>
                    <span style={{ ...detailValueStyle, overflowWrap: 'anywhere' }}>{delegateAddress}</span>
                </div>
                <div style={detailRowStyle}>
                    <span style={detailLabelStyle}>Connected wallet</span>
                    <span style={detailValueStyle}>
                        {wallet ? `${wallet.slice(0, 12)}…${wallet.slice(-6)}` : '(not connected yet)'}
                    </span>
                </div>
            </div>

            <div className="setup-classic-actions">
                <button onClick={onConnect} className="lp-btn-yellow">
                    {wallet ? 'Approve in wallet' : 'Connect Sui wallet'}
                </button>
            </div>
        </div>
    )
}

function SuccessCard({
    payload,
    callbackOutcome,
    port,
}: {
    payload: McpCallbackPayload
    callbackOutcome: CallbackOutcome | null
    port: string
}) {
    const delivered = callbackOutcome === 'delivered'
    return (
        <div className="setup-classic-intro">
            {/* Heading follows the outcome; it used to say "connected" even on failure. */}
            <h2 className="setup-classic-title">
                {delivered ? (
                    <>
                        <span style={{ color: '#22c55e' }}>✓</span> MCP client connected
                    </>
                ) : (
                    <>
                        <span style={{ color: '#e8ff75' }}>!</span> Almost there — one step
                        left
                    </>
                )}
            </h2>
            {delivered && (
                <p className="setup-classic-description">
                    Credentials were handed off to your MCP client. You can close this tab safely.
                </p>
            )}
            {!delivered && callbackOutcome !== null && (
                <>
                    <p className="setup-classic-description">
                        The first half of sign-in succeeded: your key was created and registered
                        to your account. What did not work is the last step: this page could not
                        pass the key back to the Walrus Memory app running on your computer, so
                        your MCP client cannot use it yet.
                    </p>
                    <p className="setup-classic-description">
                        {callbackOutcome === 'unreachable'
                            ? 'Nothing answered on your computer. The app stopped waiting after this tab was already open, which usually means the wallet prompt sat through the deadline, the MCP client restarted, or the login command was cancelled.'
                            : 'The app on your computer turned down the hand-off. That usually means a newer sign-in was started while this tab was still open.'}
                    </p>
                    <p className="setup-classic-description">
                        The unused key from this attempt is already on your account. Remove it
                        from the dashboard if you are not using it.
                    </p>
                    <p className="setup-classic-description">
                        <strong>Sign in again and open the new link straight away.</strong> The
                        second attempt usually works.{' '}
                        {config.docsUrl && (
                            <a
                                href={`${config.docsUrl}/troubleshooting/overview#sign-in-succeeds-but-credentials-are-not-saved`}
                                target="_blank"
                                rel="noopener noreferrer"
                                onClick={() =>
                                    trackEvent('outbound_link_click', {
                                        link: 'docs',
                                        location: 'connect_mcp_callback_failed',
                                    })
                                }
                            >
                                If it keeps failing, see troubleshooting.
                            </a>
                        )}
                    </p>
                </>
            )}
            <div className="card setup-classic-feature-card">
                <div style={detailRowStyle}>
                    <span style={detailLabelStyle}>Account</span>
                    <span style={detailValueStyle}>{payload.accountId}</span>
                </div>
                {/* Demoted out of the prose, kept for debugging the listener. */}
                {!delivered && callbackOutcome !== null && (
                    <div style={detailRowStyle}>
                        <span style={detailLabelStyle}>Hand-off address</span>
                        <span style={{ ...detailValueStyle, ...codeStyle }}>
                            http://127.0.0.1:{port}/callback
                        </span>
                    </div>
                )}
            </div>
            <div className="setup-classic-actions">
                <Link
                    to="/dashboard"
                    className="lp-btn-yellow"
                    onClick={() => trackEvent('cta_click', { cta: 'mcp_success_dashboard', location: 'connect_mcp' })}
                >
                    Go to dashboard
                </Link>
            </div>
        </div>
    )
}

// ---------- inline styles for bits the .setup-classic design system doesn't class ----------
// The page reuses the SetupWizard dark theme (.setup-classic, .setup-classic-*,
// .card.setup-classic-feature-card, .lp-btn-yellow) so the MCP consent screen is
// visually identical to the Walrus Memory setup flow. These cover the small inner
// labels / code / detail rows inside the dark feature card.

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
    lineHeight: 2,
    fontSize: '0.9rem',
    color: '#faf8f5',
}

const codeStyle: React.CSSProperties = {
    fontFamily: 'var(--font-mono)',
    fontSize: '0.82em',
    color: '#cbb6ff',
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

const detailLabelStyle: React.CSSProperties = {
    fontFamily: 'var(--font-mono)',
    fontSize: '0.7rem',
    textTransform: 'uppercase',
    letterSpacing: '0.06em',
    color: '#8f9294',
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
