/**
 * Connect MCP — browser-based wallet sign-in flow for the `@mysten-incubation/memwal-mcp`
 * stdio bridge.
 *
 * The MCP package opens this page in the user's browser with a query string:
 *
 *   /connect/mcp?port=17463
 *               &publicKey=<64-hex Ed25519 pub>
 *               &delegateAddress=<0x-prefixed Sui address>
 *               &label=<URL-encoded label>
 *               &relayer=<URL-encoded relayer base URL>
 *               &connectState=<64-hex CSRF token>  (legacy bridges: `state`)
 *
 * Flow:
 *   1. Render consent screen — show requested permissions + key fingerprint.
 *   2. User clicks "Connect Sui Wallet" → standard dApp Kit wallet popup.
 *   3. Build + sign `add_delegate_key(account, publicKey, delegateAddress, label, clock)`
 *      via useSponsoredTransaction (matches SetupWizard pattern).
 *   4. POST result {accountId, walletAddress, packageId, txDigest, label}
 *      to http://localhost:<port>/callback — the MCP package's listener.
 *   5. Show success screen — user can close the tab.
 *
 * Error paths:
 *   - Wallet not connected → wallet picker.
 *   - User has no Walrus Memory account yet → link to /setup.
 *   - Wallet rejects tx → retry button.
 *   - localhost callback unreachable → keep success on-chain anyway, ask user
 *     to manually copy creds (rare — only if the MCP listener died).
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
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

// Walrus Memory wordmark (public asset, same one the dashboard nav uses).
const WALRUS_MEMORY_LOGO = '/walrus-memory-logo.svg'

type Step =
    | 'consent'
    | 'signing'
    | 'callback'
    | 'success'
    | 'no-account'
    | 'error'

function hexToBytes(hex: string): number[] {
    const clean = hex.startsWith('0x') ? hex.slice(2) : hex
    const out: number[] = []
    for (let i = 0; i < clean.length; i += 2) {
        out.push(parseInt(clean.slice(i, i + 2), 16))
    }
    return out
}

/**
 * Prove the request came from a Walrus Memory MCP bridge running on THIS
 * machine before we register a delegate key on-chain (issue #368).
 *
 * The bridge mints a single-use `connectState` token, keeps it in memory, and
 * only puts it in the `/connect/mcp` URL it opens itself. We hand that token
 * back to the bridge's localhost `/handshake`; it answers `{ ok: true }` only
 * when the token matches the one it minted. A phishing link opened from an
 * email carries an attacker-chosen token and reaches no local bridge (or a
 * bridge whose token differs), so this returns false and we refuse to sign.
 *
 * Any failure — no listener, wrong token, CORS/PNA block, non-bridge process
 * on the port — is treated as "not verified". False negatives are safe: they
 * only ask a legitimate user to restart the MCP login command.
 */
/** Compare two relayer URLs ignoring trailing slashes and case. */
function sameRelayer(a: string, b: string): boolean {
    const norm = (s: string) => s.replace(/\/+$/, '').toLowerCase()
    return norm(a) === norm(b)
}

async function verifyLocalBridge(port: string, state: string): Promise<boolean> {
    try {
        const res = await fetch(
            `http://127.0.0.1:${port}/handshake?state=${encodeURIComponent(state)}`,
            { method: 'GET' },
        )
        if (!res.ok) return false
        const data = (await res.json().catch(() => null)) as { ok?: unknown } | null
        return data?.ok === true
    } catch {
        return false
    }
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

export default function ConnectMcp() {
    const [params] = useSearchParams()
    const currentAccount = useCurrentAccount()
    const suiClient = useSuiClient()
    const { mutateAsync: signAndExecute } = useSponsoredTransaction()

    const port = params.get('port') ?? ''
    const publicKey = params.get('publicKey') ?? ''
    const delegateAddress = params.get('delegateAddress') ?? ''
    const label = params.get('label') ?? 'Walrus Memory MCP'
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

    const [step, setStep] = useState<Step>('consent')
    const [errorMsg, setErrorMsg] = useState('')
    const [walletPickerOpen, setWalletPickerOpen] = useState(false)
    const [callbackPayload, setCallbackPayload] = useState<McpCallbackPayload | null>(null)
    const [callbackDelivered, setCallbackDelivered] = useState<boolean | null>(null)
    // Bridge binding (issue #368): null = still checking, true = a local bridge
    // confirmed it issued this request, false = could not confirm (a phishing
    // link opened from elsewhere, or the local bridge has exited). We refuse to
    // sign `add_delegate_key` unless this is true.
    const [bridgeVerified, setBridgeVerified] = useState<boolean | null>(null)
    const invalidRequestTrackedRef = useRef(false)
    // True once the user actively started the flow (clicked the consent button).
    // Gates the wallet-picker auto-proceed effect so a pre-connected wallet does
    // NOT skip straight past the consent screen on mount — the user must read
    // and click through the disclosure first (issue #368).
    const initiatedRef = useRef(false)

    // Validate query string up-front.
    const paramsValid = useMemo(() => {
        const portNum = Number(port)
        return (
            Number.isFinite(portNum) &&
            portNum > 1024 &&
            portNum < 65536 &&
            /^[0-9a-fA-F]{64}$/.test(publicKey) &&
            /^0x[0-9a-fA-F]{64}$/.test(delegateAddress) &&
            // State token is a 32-byte hex string emitted by the MCP bridge.
            // Old bridges without state will fail this check — by design;
            // forces a bridge upgrade so we never accept stateless callbacks.
            /^[0-9a-f]{64}$/.test(state)
        )
    }, [port, publicKey, delegateAddress, state])

    const postCallback = useCallback(
        async (payload: McpCallbackPayload): Promise<boolean> => {
            try {
                const res = await fetch(`http://127.0.0.1:${port}/callback`, {
                    method: 'POST',
                    headers: { 'content-type': 'application/json' },
                    body: JSON.stringify(payload),
                })
                setCallbackDelivered(res.ok)
                return res.ok
            } catch {
                setCallbackDelivered(false)
                return false
            }
        },
        [port],
    )

    const handleConnect = useCallback(async () => {
        // Mark the flow as user-initiated so the auto-proceed effect below is
        // allowed to run after the wallet picker closes (issue #368).
        initiatedRef.current = true
        if (!paramsValid) {
            trackEvent('mcp_connect_failed', { error_type: 'invalid_request' })
            setErrorMsg('Invalid query parameters from MCP client.')
            setStep('error')
            return
        }
        if (!currentAccount) {
            trackEvent('mcp_connect_start', { wallet_connected: false })
            setWalletPickerOpen(true)
            return
        }

        trackEvent('mcp_connect_start', { wallet_connected: true })

        // Bind this on-chain write to the local bridge (issue #368). Never sign
        // add_delegate_key for a request we can't prove a bridge on this port
        // issued — this is what blocks a consent-phishing link opened from an
        // email/chat, where no local bridge (or a bridge with a different token)
        // answers the handshake. Re-checked here right before signing even
        // though the page already probed on load, in case the bridge exited in
        // between.
        const bridgeOk = await verifyLocalBridge(port, state)
        setBridgeVerified(bridgeOk)
        if (!bridgeOk) {
            trackEvent('mcp_connect_failed', { error_type: 'bridge_unverified' })
            setErrorMsg(
                'Could not confirm this request came from a Walrus Memory MCP login running on this computer, ' +
                'so nothing was registered on-chain. ' +
                'If you did NOT start this yourself — for example you opened a link from an email or chat message — ' +
                'close this tab: approving would grant someone else ongoing access to all your memories. ' +
                'If you DID start this, make sure you are running the latest MCP client ' +
                '(e.g. `npx @mysten-incubation/memwal-mcp@latest login`) and restart the login command, then try again.'
            )
            setStep('error')
            return
        }

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
                    tx.pure('vector<u8>', hexToBytes(publicKey)),
                    tx.pure('address', delegateAddress),
                    tx.pure('string', label),
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
                label,
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
        publicKey,
        delegateAddress,
        label,
        port,
        state,
        postCallback,
    ])

    useEffect(() => {
        if (paramsValid || invalidRequestTrackedRef.current) return
        invalidRequestTrackedRef.current = true
        trackEvent('mcp_connect_failed', { error_type: 'invalid_request' })
    }, [paramsValid])

    // Probe the local bridge as soon as the request looks well-formed, so the
    // consent screen can warn — and disable Approve — before the user ever
    // connects a wallet if this link did not come from a bridge on this machine
    // (issue #368). handleConnect re-checks right before signing.
    useEffect(() => {
        setBridgeVerified(null)
        if (!paramsValid) return
        let cancelled = false
        void verifyLocalBridge(port, state).then((ok) => {
            if (!cancelled) setBridgeVerified(ok)
        })
        return () => {
            cancelled = true
        }
    }, [paramsValid, port, state])

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
            JSON.stringify({ port, publicKey, delegateAddress, label, relayer, connectState: state }),
        )
    }, [paramsValid, port, publicKey, delegateAddress, label, relayer, state])

    // If the wallet popup completes after we asked it to open, auto-proceed.
    // Gated on initiatedRef so a wallet that was ALREADY connected on mount does
    // not skip the consent screen — the user must click through it first (#368).
    useEffect(() => {
        if (initiatedRef.current && !walletPickerOpen && currentAccount && step === 'consent') {
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

                    {paramsValid && step === 'consent' && (
                        <ConsentCard
                            label={label}
                            delegateAddress={delegateAddress}
                            publicKey={publicKey}
                            relayer={relayer}
                            relayerIsDefault={sameRelayer(relayer, config.memwalServerUrl)}
                            wallet={currentAccount?.address ?? null}
                            bridgeVerified={bridgeVerified}
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
                            callbackDelivered={callbackDelivered}
                            port={port}
                        />
                    )}

                    {paramsValid && step === 'no-account' && (
                        <div className="setup-classic-intro">
                            <h2 className="setup-classic-title">Create a Walrus Memory account first</h2>
                            <p className="setup-classic-description">
                                This wallet doesn't have a Walrus Memory account yet. Run through the one-time setup, then come back here.
                            </p>
                            <div className="setup-classic-actions">
                                <Link
                                    to="/setup"
                                    className="lp-btn-yellow"
                                    onClick={() => trackEvent('cta_click', { cta: 'mcp_create_account', location: 'connect_mcp' })}
                                >
                                    Create account
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
                                        setStep('consent')
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
    delegateAddress,
    publicKey,
    relayer,
    relayerIsDefault,
    wallet,
    bridgeVerified,
    onConnect,
}: {
    label: string
    delegateAddress: string
    publicKey: string
    relayer: string
    relayerIsDefault: boolean
    wallet: string | null
    bridgeVerified: boolean | null
    onConnect: () => void
}) {
    // We only enable the on-chain action once a local bridge has confirmed it
    // issued this request (issue #368). `null` = still probing.
    const blocked = bridgeVerified !== true

    let buttonText: string
    if (bridgeVerified === null) buttonText = 'Checking this request…'
    else if (bridgeVerified === false) buttonText = 'Request could not be verified'
    else buttonText = wallet ? 'Approve in wallet' : 'Connect Sui wallet'

    return (
        <div className="setup-classic-intro">
            <h2 className="setup-classic-title">
                Authorize an MCP client to access your Walrus Memory
            </h2>
            <p className="setup-classic-description">
                Something is asking to register a <strong>delegate key</strong> on your Walrus Memory
                account. Read what this grants before you approve — the request below is not verified by
                Walrus Memory, only by you.
            </p>

            {/* Bridge-binding status. This is the anti-phishing signal: a request
                that did not originate from a bridge on this machine cannot pass. */}
            {bridgeVerified === false && (
                <div style={dangerBoxStyle}>
                    <strong>⚠ This request did not come from an MCP login on this computer.</strong>
                    <p style={{ margin: '6px 0 0' }}>
                        Walrus Memory could not reach a local Walrus Memory MCP login for this request, so
                        approving is disabled. If a link was sent to you by someone else,{' '}
                        <strong>close this tab</strong> — it may be trying to trick you into granting them
                        access. If you started this yourself, your MCP client may be out of date — update to
                        the latest and restart the login command.
                    </p>
                </div>
            )}
            {bridgeVerified === true && (
                <div style={okBoxStyle}>
                    ✓ Verified this request came from a Walrus Memory MCP login running on this computer.
                </div>
            )}

            <div className="card setup-classic-feature-card">
                <p style={cardLabelStyle}>What approving grants</p>
                <ul style={permListStyle}>
                    <li>✓ Read <strong>and decrypt</strong> every memory in this account — all namespaces</li>
                    <li>✓ Create, update, and overwrite memories</li>
                    <li>✓ Extract facts from text and re-index from Walrus storage</li>
                </ul>
                <p style={scaryNoteStyle}>
                    This gives a third party <strong>persistent read, decrypt, and write access to
                    everything in this account</strong> — through the relayer below — and it lasts until you
                    revoke the key from your dashboard. It is not limited to one session.
                </p>

                <div style={dividerStyle} />

                <p style={cardLabelStyle}>The client identifies itself as</p>
                <div style={untrustedLabelStyle}>{label}</div>
                <p style={untrustedHintStyle}>
                    This name is supplied by the requester and is <strong>not verified</strong>. Anyone can
                    claim any name.
                </p>

                <div style={dividerStyle} />

                <p style={cardLabelStyle}>Details</p>
                <div style={detailRowStyle}>
                    <span style={detailLabelStyle}>Relayer</span>
                    <span style={detailValueStyle}>{relayer}</span>
                    {!relayerIsDefault && (
                        <span style={relayerWarnStyle}>
                            ⚠ Non-default relayer — your memories would be served through this host. Only
                            proceed if you recognize it.
                        </span>
                    )}
                </div>
                <div style={detailRowStyle}>
                    <span style={detailLabelStyle}>Delegate address (full)</span>
                    <span style={detailValueStyle}>{delegateAddress}</span>
                </div>
                <div style={detailRowStyle}>
                    <span style={detailLabelStyle}>Delegate public key (full)</span>
                    <span style={detailValueStyle}>{publicKey}</span>
                </div>
                <div style={detailRowStyle}>
                    <span style={detailLabelStyle}>Connected wallet</span>
                    <span style={detailValueStyle}>
                        {wallet ? `${wallet.slice(0, 12)}…${wallet.slice(-6)}` : '(not connected yet)'}
                    </span>
                </div>
            </div>

            <div style={safetyNoteStyle}>
                Only continue if <strong>you</strong> just started this from your own machine. Approving hands
                the key above ongoing access to all your memories.
            </div>

            <div className="setup-classic-actions">
                <button
                    onClick={onConnect}
                    className="lp-btn-yellow"
                    disabled={blocked}
                    aria-disabled={blocked}
                    style={blocked ? disabledBtnStyle : undefined}
                >
                    {buttonText}
                </button>
            </div>
        </div>
    )
}

function SuccessCard({
    payload,
    callbackDelivered,
    port,
}: {
    payload: McpCallbackPayload
    callbackDelivered: boolean | null
    port: string
}) {
    return (
        <div className="setup-classic-intro">
            <h2 className="setup-classic-title">
                <span style={{ color: '#22c55e' }}>✓</span> MCP client connected
            </h2>
            {callbackDelivered === true && (
                <p className="setup-classic-description">
                    Credentials were handed off to your MCP client. You can close this tab safely.
                </p>
            )}
            {callbackDelivered === false && (
                <p className="setup-classic-description" style={errorTextStyle}>
                    The on-chain registration succeeded, but the local MCP login listener at{' '}
                    <code style={codeStyle}>http://127.0.0.1:{port}/callback</code> did not accept the callback. Restart the MCP login command and try again so credentials can be saved locally.
                </p>
            )}
            <div className="card setup-classic-feature-card">
                <div style={detailRowStyle}>
                    <span style={detailLabelStyle}>Account</span>
                    <span style={detailValueStyle}>{payload.accountId}</span>
                </div>
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

// Red alert box — shown when the request can't be tied to a local bridge.
const dangerBoxStyle: React.CSSProperties = {
    background: 'rgba(239, 68, 68, 0.12)',
    border: '1px solid #ef4444',
    borderRadius: 8,
    padding: '12px 14px',
    margin: '0 0 18px',
    fontSize: '0.88rem',
    color: '#ffb4b4',
}

// Green confirmation box — shown when the bridge handshake succeeded.
const okBoxStyle: React.CSSProperties = {
    background: 'rgba(34, 197, 94, 0.12)',
    border: '1px solid #22c55e',
    borderRadius: 8,
    padding: '10px 14px',
    margin: '0 0 18px',
    fontSize: '0.85rem',
    color: '#86efac',
}

// The blunt "what you're really granting" paragraph inside the card.
const scaryNoteStyle: React.CSSProperties = {
    margin: '14px 0 0',
    fontSize: '0.84rem',
    lineHeight: 1.5,
    color: '#f0a3a3',
}

// Attacker-controlled label — rendered as untrusted free text, never as a
// verified identity in the heading.
const untrustedLabelStyle: React.CSSProperties = {
    fontFamily: 'var(--font-mono)',
    fontSize: '0.9rem',
    color: '#faf8f5',
    background: '#1c1e20',
    border: '1px solid #2a2c2e',
    borderRadius: 6,
    padding: '8px 10px',
    wordBreak: 'break-all',
}

const untrustedHintStyle: React.CSSProperties = {
    margin: '6px 0 0',
    fontSize: '0.78rem',
    color: '#8f9294',
}

const relayerWarnStyle: React.CSSProperties = {
    marginTop: 4,
    fontSize: '0.78rem',
    color: '#f0a3a3',
    lineHeight: 1.45,
}

const safetyNoteStyle: React.CSSProperties = {
    margin: '18px 0 0',
    fontSize: '0.82rem',
    lineHeight: 1.5,
    color: '#c7b48a',
    textAlign: 'center',
}

const disabledBtnStyle: React.CSSProperties = {
    opacity: 0.45,
    cursor: 'not-allowed',
}
