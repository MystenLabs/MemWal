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
 *   - User has no MemWalAccount yet → link to /setup.
 *   - Wallet rejects tx → retry button.
 *   - localhost callback unreachable → keep success on-chain anyway, ask user
 *     to manually copy creds (rare — only if the MCP listener died).
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
import memwalLogo from '../assets/memwal-logo.svg'

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
                if (
                    dynField?.data?.content &&
                    'fields' in dynField.data.content
                ) {
                    return (dynField.data.content.fields as any).value as string
                }
            }
        }
    } catch {
        return null
    }
    return null
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
    const label = params.get('label') ?? 'MemWal MCP'
    const relayer = params.get('relayer') ?? 'https://relayer.memwal.ai'
    /**
     * Cryptographic state token from the MCP bridge. Must be echoed verbatim
     * in the callback POST — the bridge constant-time compares it to defeat
     * cross-origin CSRF (audit C2). Empty string if absent (older bridge);
     * the bridge will then reject our callback with 400.
     */
    const state = params.get('state') ?? ''

    const [step, setStep] = useState<Step>('consent')
    const [errorMsg, setErrorMsg] = useState('')
    const [walletPickerOpen, setWalletPickerOpen] = useState(false)
    const [callbackPayload, setCallbackPayload] = useState<McpCallbackPayload | null>(null)
    const [callbackDelivered, setCallbackDelivered] = useState<boolean | null>(null)

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
        async (payload: McpCallbackPayload) => {
            try {
                const res = await fetch(`http://127.0.0.1:${port}/callback`, {
                    method: 'POST',
                    headers: { 'content-type': 'application/json' },
                    body: JSON.stringify(payload),
                })
                setCallbackDelivered(res.ok)
            } catch {
                setCallbackDelivered(false)
            }
        },
        [port],
    )

    const handleConnect = useCallback(async () => {
        if (!paramsValid) {
            setErrorMsg('Invalid query parameters from MCP client.')
            setStep('error')
            return
        }
        if (!currentAccount) {
            setWalletPickerOpen(true)
            return
        }

        setStep('signing')
        try {
            // Resolve the user's MemWalAccount.
            const accountId = await resolveAccountId(suiClient, currentAccount.address)
            if (!accountId) {
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
                        `This wallet (${currentAccount.address.slice(0, 10)}…${currentAccount.address.slice(-6)}) is not the owner of MemWalAccount ${accountId.slice(0, 10)}…${accountId.slice(-6)}. ` +
                        `Switch your wallet to the account that originally created this MemWal, OR run /setup to create a new MemWalAccount for the current wallet.`
                    )
                    setStep('error')
                    return
                }
                if (m.includes('abort code: 2') && m.includes('add_delegate_key')) {
                    setErrorMsg(
                        `This MemWalAccount already has the maximum number of delegate keys (20). Go to /dashboard and revoke an unused key, then try again.`
                    )
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
            await postCallback(payload)
            setStep('success')
        } catch (err) {
            setErrorMsg(err instanceof Error ? err.message : String(err))
            setStep('error')
        }
    }, [
        paramsValid,
        currentAccount,
        suiClient,
        signAndExecute,
        publicKey,
        delegateAddress,
        label,
        state,
        postCallback,
    ])

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
        <div style={pageStyle}>
            <nav className="lp-nav">
                <div className="lp-nav-inner">
                    <Link to="/" className="lp-nav-brand" style={mcpNavBrandStyle}>
                        <img src={memwalLogo} alt="MemWal" height="28" />
                        <span style={mcpNavTitleStyle}>Connect MCP client</span>
                    </Link>
                </div>
            </nav>

            <main style={mainStyle}>
                {!paramsValid && (
                    <section style={cardStyle}>
                        <h1 style={h1Style}>Invalid request</h1>
                        <p>
                            This page must be opened by the{' '}
                            <code>@mysten-incubation/memwal-mcp</code> package
                            during its login flow.
                        </p>
                        <p>
                            Got: <code>port={port || '(none)'}</code>{' '}
                            <code>publicKey={publicKey ? publicKey.slice(0, 12) + '…' : '(none)'}</code>
                        </p>
                    </section>
                )}

                {paramsValid && step === 'consent' && (
                    <ConsentCard
                        label={label}
                        delegateAddress={delegateAddress}
                        relayer={relayer}
                        wallet={currentAccount?.address ?? null}
                        onConnect={handleConnect}
                    />
                )}

                {paramsValid && step === 'signing' && (
                    <section style={cardStyle}>
                        <h1 style={h1Style}>Confirm in your wallet…</h1>
                        <p>
                            A wallet popup is registering this delegate key on
                            chain. Approve the transaction to continue.
                        </p>
                    </section>
                )}

                {paramsValid && step === 'callback' && (
                    <section style={cardStyle}>
                        <h1 style={h1Style}>Wrapping up…</h1>
                        <p>Sending credentials back to your MCP client.</p>
                    </section>
                )}

                {paramsValid && step === 'success' && callbackPayload && (
                    <SuccessCard
                        payload={callbackPayload}
                        callbackDelivered={callbackDelivered}
                        port={port}
                    />
                )}

                {paramsValid && step === 'no-account' && (
                    <section style={cardStyle}>
                        <h1 style={h1Style}>Create a MemWal account first</h1>
                        <p>
                            This wallet doesn't have a MemWalAccount yet. Run
                            through the one-time setup, then come back here.
                        </p>
                        <p>
                            <Link to="/setup" style={primaryButton}>
                                Create account
                            </Link>
                        </p>
                    </section>
                )}

                {paramsValid && step === 'error' && (
                    <section style={cardStyle}>
                        <h1 style={h1Style}>Something went wrong</h1>
                        <p style={{ color: '#dc2626' }}>{errorMsg}</p>
                        <p>
                            <button
                                style={primaryButton}
                                onClick={() => {
                                    setErrorMsg('')
                                    setStep('consent')
                                }}
                            >
                                Try again
                            </button>
                        </p>
                    </section>
                )}
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
    relayer,
    wallet,
    onConnect,
}: {
    label: string
    delegateAddress: string
    relayer: string
    wallet: string | null
    onConnect: () => void
}) {
    return (
        <section style={cardStyle}>
            <h1 style={h1Style}>
                <span style={{ fontWeight: 700 }}>{label}</span> wants access to
                your MemWal memory
            </h1>

            <h3 style={h3Style}>Permissions requested</h3>
            <ul style={ulStyle}>
                <li>✓ Read your memories (<code>memwal_recall</code>)</li>
                <li>✓ Save new memories (<code>memwal_remember</code>)</li>
                <li>✓ Extract facts from text (<code>memwal_analyze</code>)</li>
                <li>✓ Re-index from Walrus (<code>memwal_restore</code>)</li>
            </ul>

            <h3 style={h3Style}>Details</h3>
            <dl style={dlStyle}>
                <dt>Relayer</dt>
                <dd>
                    <code>{relayer}</code>
                </dd>
                <dt>Delegate address</dt>
                <dd>
                    <code>{delegateAddress.slice(0, 16)}…{delegateAddress.slice(-6)}</code>
                </dd>
                <dt>Connected wallet</dt>
                <dd>
                    {wallet ? (
                        <code>
                            {wallet.slice(0, 12)}…{wallet.slice(-6)}
                        </code>
                    ) : (
                        <span style={subtleStyle}>(not connected yet)</span>
                    )}
                </dd>
            </dl>

            <button onClick={onConnect} style={primaryButton}>
                {wallet ? 'Approve in wallet' : 'Connect Sui wallet'}
            </button>
        </section>
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
        <section style={cardStyle}>
            <h1 style={h1Style}>
                <span style={{ color: '#16a34a' }}>✓</span> MCP client connected
            </h1>
            {callbackDelivered === true && (
                <p style={subtleStyle}>
                    Credentials were handed off to your MCP client. You can close
                    this tab safely.
                </p>
            )}
            {callbackDelivered === false && (
                <p style={{ color: '#dc2626' }}>
                    The on-chain registration succeeded, but the local MCP login
                    listener at <code>http://127.0.0.1:{port}/callback</code>{' '}
                    did not accept the callback. Restart the MCP login command and
                    try again so credentials can be saved locally.
                </p>
            )}
            <dl style={dlStyle}>
                <dt>Account</dt>
                <dd>
                    <code>{payload.accountId}</code>
                </dd>
            </dl>
            <p>
                <Link to="/dashboard" style={primaryButton}>
                    Go to dashboard
                </Link>
            </p>
        </section>
    )
}

// ---------- styles (match Dashboard's neo-brutalism .card pattern) ----------

const mcpNavBrandStyle: React.CSSProperties = {
    gap: 12,
}

const mcpNavTitleStyle: React.CSSProperties = {
    fontSize: '1rem',
    fontWeight: 700,
    color: '#000',
    lineHeight: 1,
    transform: 'translateY(8px)',
}

const pageStyle: React.CSSProperties = {
    minHeight: '100vh',
    background: '#FAF8F5', // same as --color-tusk used by .card / body
    color: '#1a1a1a',
}

const mainStyle: React.CSSProperties = {
    maxWidth: 640,
    margin: '40px auto',
    padding: '0 24px',
    display: 'flex',
    flexDirection: 'column',
    gap: 24,
}

const cardStyle: React.CSSProperties = {
    background: '#fff',
    border: '2px solid #000',
    borderRadius: 12,
    padding: 28,
    boxShadow: '4px 4px 0 #000',
}

const h1Style: React.CSSProperties = {
    fontSize: 22,
    fontWeight: 800,
    margin: '0 0 12px',
    letterSpacing: -0.3,
}

const h3Style: React.CSSProperties = {
    fontSize: 12,
    fontWeight: 700,
    textTransform: 'uppercase' as const,
    letterSpacing: 0.6,
    color: '#525252',
    marginTop: 20,
    marginBottom: 8,
}

const ulStyle: React.CSSProperties = {
    listStyle: 'none',
    padding: 0,
    margin: '0 0 8px',
    lineHeight: 1.9,
    fontSize: 14,
}

const dlStyle: React.CSSProperties = {
    fontSize: 13,
    lineHeight: 1.6,
    margin: '0 0 20px',
    wordBreak: 'break-all' as const,
}

const subtleStyle: React.CSSProperties = {
    color: '#525252',
    fontSize: 14,
}

const primaryButton: React.CSSProperties = {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    padding: '12px 26px',
    background: '#E8FF75',
    color: '#000',
    borderRadius: 12,
    border: '2px solid #000',
    fontSize: '0.94rem',
    fontWeight: 700,
    cursor: 'pointer',
    textDecoration: 'none',
    boxShadow: '3px 3px 0 #000',
}
