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
                const res = await fetch(`http://localhost:${port}/callback`, {
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
            <header style={headerStyle}>
                <img src={memwalLogo} alt="MemWal" style={{ height: 32 }} />
                <span style={{ fontSize: 18, fontWeight: 600 }}>
                    Connect MCP client
                </span>
            </header>

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
                        relayer={relayer}
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
            <p style={subtleStyle}>
                Approve this request to register a delegate key on chain. The
                MCP client will then be able to read and write memories on your
                behalf, until you revoke it from the dashboard.
            </p>

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
    relayer,
}: {
    payload: McpCallbackPayload
    callbackDelivered: boolean | null
    port: string
    relayer: string
}) {
    return (
        <>
            <section style={cardStyle}>
                <h1 style={h1Style}>
                    <span style={{ color: '#16a34a' }}>✓</span> MCP client connected
                </h1>
                <p>Delegate key is now registered on chain.</p>
                {callbackDelivered === true && (
                    <p style={subtleStyle}>
                        Credentials handed off to your MCP client. You can close
                        this tab — it's safe.
                    </p>
                )}
                {callbackDelivered === false && (
                    <>
                        <p style={{ color: '#dc2626' }}>
                            The MCP listener at{' '}
                            <code>http://localhost:{port}/callback</code> didn't
                            respond. The on-chain registration succeeded but your
                            MCP client process may have died. Restart it and try
                            again — the delegate key is already valid.
                        </p>
                    </>
                )}
                <dl style={dlStyle}>
                    <dt>Account</dt>
                    <dd>
                        <code>{payload.accountId}</code>
                    </dd>
                    <dt>Tx digest</dt>
                    <dd>
                        <code>{payload.txDigest}</code>
                    </dd>
                </dl>
                <p>
                    <Link to="/dashboard" style={primaryButton}>
                        Go to dashboard
                    </Link>
                </p>
            </section>

            <ClientConfigPanel relayer={relayer} />
        </>
    )
}

/**
 * Maps a relayer URL to the matching CLI flag for `@memwal/mcp`. Keeps the
 * generated config snippets clean (e.g. `--dev` instead of pasting the full
 * URL) so the user can mentally separate the package name from the env.
 */
function relayerFlag(relayer: string): { args: string[]; envName: string } {
    const u = relayer.replace(/\/+$/, '')
    if (u === 'https://relayer.memwal.ai') return { args: [], envName: 'prod' }
    if (u === 'https://relayer.dev.memwal.ai')
        return { args: ['--dev'], envName: 'dev' }
    if (u === 'https://relayer.staging.memwal.ai')
        return { args: ['--staging'], envName: 'staging' }
    if (u === 'http://127.0.0.1:3005' || u === 'http://localhost:3005')
        return { args: ['--local'], envName: 'local' }
    return { args: ['--relayer', u], envName: 'custom' }
}

interface ClientPreset {
    id: string
    label: string
    configPath: string
    restartHint: string
    serverName: string
}

const CLIENT_PRESETS: ClientPreset[] = [
    {
        id: 'cursor',
        label: 'Cursor',
        configPath: '~/.cursor/mcp.json',
        restartHint: 'Cmd+Shift+P → "Developer: Reload Window"',
        serverName: 'memwal',
    },
    {
        id: 'claude-desktop',
        label: 'Claude Desktop',
        configPath:
            '~/Library/Application Support/Claude/claude_desktop_config.json',
        restartHint: 'Quit Claude Desktop, then reopen it.',
        serverName: 'memwal',
    },
    {
        id: 'claude-code',
        label: 'Claude Code',
        configPath: '<project>/.mcp.json',
        restartHint: 'Restart `claude` in the project directory.',
        serverName: 'memwal',
    },
    {
        id: 'antigravity',
        label: 'Antigravity',
        configPath: '~/.antigravity/mcp.json',
        restartHint: 'Reload Antigravity from the command palette.',
        serverName: 'memwal',
    },
]

function buildConfigSnippet(
    preset: ClientPreset,
    flagArgs: string[],
): string {
    const args = ['-y', '@memwal/mcp', ...flagArgs]
    const cfg = {
        mcpServers: {
            [preset.serverName]: {
                command: 'npx',
                args,
            },
        },
    }
    return JSON.stringify(cfg, null, 2)
}

function ClientConfigPanel({ relayer }: { relayer: string }) {
    const [activeId, setActiveId] = useState<string>(CLIENT_PRESETS[0].id)
    const [copied, setCopied] = useState<string | null>(null)
    const flag = useMemo(() => relayerFlag(relayer), [relayer])
    const active = CLIENT_PRESETS.find((c) => c.id === activeId)!
    const snippet = useMemo(
        () => buildConfigSnippet(active, flag.args),
        [active, flag.args],
    )

    const copyToClipboard = useCallback(async (text: string, key: string) => {
        try {
            await navigator.clipboard.writeText(text)
            setCopied(key)
            setTimeout(() => setCopied((c) => (c === key ? null : c)), 1800)
        } catch {
            /* clipboard blocked — user has to copy manually */
        }
    }, [])

    return (
        <section style={panelStyle}>
            <h2 style={panelTitle}>connect more ai clients</h2>
            <p style={panelSubtle}>
                Same delegate key works across every MCP client. Pick one,
                paste the snippet into its config file, restart it.
            </p>

            <div style={tabBarStyle}>
                {CLIENT_PRESETS.map((c) => (
                    <button
                        key={c.id}
                        onClick={() => setActiveId(c.id)}
                        style={c.id === activeId ? tabActiveStyle : tabStyle}
                    >
                        {c.label}
                    </button>
                ))}
            </div>

            <div style={configRowStyle}>
                <span style={configLabelStyle}>config file</span>
                <div style={configPathRowStyle}>
                    <code style={configPathStyle}>{active.configPath}</code>
                    <button
                        style={copyChipStyle}
                        onClick={() =>
                            copyToClipboard(
                                active.configPath,
                                `${active.id}-path`,
                            )
                        }
                    >
                        {copied === `${active.id}-path` ? '✓' : 'copy'}
                    </button>
                </div>
            </div>

            <span style={configLabelStyle}>snippet</span>
            <pre style={snippetStyle}>{snippet}</pre>

            <div style={actionRowStyle}>
                <button
                    style={copyBigStyle}
                    onClick={() => copyToClipboard(snippet, `${active.id}-json`)}
                >
                    {copied === `${active.id}-json`
                        ? '✓ copied'
                        : 'copy snippet'}
                </button>
                <p style={restartHintStyle}>
                    <strong>then:</strong> {active.restartHint}
                </p>
            </div>

            {flag.envName !== 'prod' && (
                <p style={envBadge}>
                    Targeting <code>{flag.envName}</code> environment. Drop the
                    flag once you're on production.
                </p>
            )}
        </section>
    )
}

// ---------- ClientConfigPanel styles (match SuccessCard / Dashboard) ----------

const panelStyle: React.CSSProperties = {
    // Same shell as cardStyle for visual consistency.
    background: '#fff',
    border: '2px solid #000',
    borderRadius: 12,
    padding: 28,
    boxShadow: '4px 4px 0 #000',
}

const panelTitle: React.CSSProperties = {
    margin: '0 0 8px',
    fontSize: 20,
    fontWeight: 800,
    textTransform: 'lowercase' as const,
    letterSpacing: -0.3,
}

const panelSubtle: React.CSSProperties = {
    margin: '6px 0 18px',
    fontSize: 14,
    lineHeight: 1.55,
    color: '#3a3a3a',
}

const tabBarStyle: React.CSSProperties = {
    display: 'flex',
    flexWrap: 'wrap',
    gap: 8,
    marginBottom: 20,
}

const tabStyle: React.CSSProperties = {
    padding: '8px 14px',
    background: '#fff',
    border: '2px solid #000',
    borderRadius: 999,
    fontSize: 13,
    fontWeight: 600,
    cursor: 'pointer',
    boxShadow: '2px 2px 0 #000',
}

const tabActiveStyle: React.CSSProperties = {
    ...tabStyle,
    background: '#CAB1FF',
}

// Two-row layout so long paths (Claude Desktop ~80 chars) can wrap freely
// without crowding the copy chip. Was a flex row → text got truncated.
const configRowStyle: React.CSSProperties = {
    display: 'flex',
    flexDirection: 'column',
    gap: 6,
    marginBottom: 16,
}

const configLabelStyle: React.CSSProperties = {
    fontSize: 11,
    textTransform: 'uppercase' as const,
    letterSpacing: 0.6,
    color: '#525252',
    fontWeight: 700,
}

const configPathRowStyle: React.CSSProperties = {
    display: 'flex',
    alignItems: 'stretch',
    gap: 8,
}

const configPathStyle: React.CSSProperties = {
    flex: 1,
    fontFamily: 'JetBrains Mono, Fira Code, monospace',
    fontSize: 12.5,
    lineHeight: 1.5,
    background: 'rgba(202, 177, 255, 0.30)',
    padding: '8px 12px',
    borderRadius: 8,
    border: '2px solid #000',
    wordBreak: 'break-all' as const,
    overflowWrap: 'anywhere' as const,
    whiteSpace: 'normal' as const,
    display: 'flex',
    alignItems: 'center',
}

const copyChipStyle: React.CSSProperties = {
    padding: '6px 14px',
    fontSize: 12,
    fontWeight: 700,
    background: '#fff',
    border: '2px solid #000',
    borderRadius: 8,
    cursor: 'pointer',
    boxShadow: '2px 2px 0 #000',
    flexShrink: 0,
    alignSelf: 'center',
}

const snippetStyle: React.CSSProperties = {
    background: '#0f0f0f',
    color: '#f7f7f5',
    border: '2px solid #000',
    borderRadius: 10,
    padding: 16,
    fontFamily: 'JetBrains Mono, Fira Code, monospace',
    fontSize: 12.5,
    lineHeight: 1.55,
    overflow: 'auto',
    margin: '0 0 14px',
    boxShadow: '3px 3px 0 #000',
    whiteSpace: 'pre-wrap' as const,
    wordBreak: 'break-all' as const,
}

const actionRowStyle: React.CSSProperties = {
    display: 'flex',
    alignItems: 'center',
    gap: 12,
    flexWrap: 'wrap',
    marginBottom: 14,
}

const copyBigStyle: React.CSSProperties = {
    padding: '10px 22px',
    background: '#F0FFA0',
    border: '2px solid #000',
    borderRadius: 999,
    fontSize: 14,
    fontWeight: 700,
    cursor: 'pointer',
    boxShadow: '3px 3px 0 #000',
}

const restartHintStyle: React.CSSProperties = {
    fontSize: 13,
    color: '#525252',
    margin: 0,
}

const envBadge: React.CSSProperties = {
    margin: '12px 0 0',
    fontSize: 12,
    color: '#7c2d12',
    background: '#fef3c7',
    padding: '8px 12px',
    border: '2px solid #000',
    borderRadius: 8,
    display: 'inline-block',
    fontWeight: 600,
}

// ---------- styles (match Dashboard's neo-brutalism .card pattern) ----------

const pageStyle: React.CSSProperties = {
    minHeight: '100vh',
    background: '#FAF8F5', // same as --color-tusk used by .card / body
    color: '#1a1a1a',
}

const headerStyle: React.CSSProperties = {
    display: 'flex',
    alignItems: 'center',
    gap: 12,
    padding: '16px 24px',
    borderBottom: '2px solid #000',
    background: '#fff',
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
    display: 'inline-block',
    padding: '12px 24px',
    background: '#000',
    color: '#fff',
    borderRadius: 999,
    border: '2px solid #000',
    fontSize: 14,
    fontWeight: 700,
    cursor: 'pointer',
    textDecoration: 'none',
    boxShadow: '3px 3px 0 #000',
}
