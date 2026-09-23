import { useLayoutEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { Copy } from 'lucide-react'
import { config } from '../config'
import { trackEvent } from '../utils/analytics'

export type ConnectPath = 'agent' | 'app'
export type ConnectClientId = 'claude-code' | 'codex' | 'antigravity' | 'cursor'

type ConnectClient = {
    id: ConnectClientId
    label: string
    askName: string
    command: string
    slash?: string
}

const CLIENTS: ConnectClient[] = [
    {
        id: 'claude-code',
        label: 'Claude Code',
        askName: 'Claude',
        command: [
            'claude plugin marketplace add https://github.com/MystenLabs/MemWal.git',
            'claude plugin install memwal@memwal-plugins -s user',
            'claude plugin list',
        ].join('\n'),
        slash: [
            '/plugin marketplace add https://github.com/MystenLabs/MemWal.git',
            '/plugin install memwal@memwal-plugins',
        ].join('\n'),
    },
    {
        id: 'codex',
        label: 'Codex',
        askName: 'Codex',
        command: [
            'codex plugin marketplace add MystenLabs/MemWal',
            'codex plugin add memwal@memwal-plugins',
            'codex plugin list',
        ].join('\n'),
    },
    {
        id: 'antigravity',
        label: 'Antigravity',
        askName: 'Antigravity',
        command: 'npx degit MystenLabs/MemWal/packages/mcp/plugin ~/.gemini/config/plugins/memwal',
    },
    {
        id: 'cursor',
        label: 'Cursor',
        askName: 'Cursor',
        command: 'npx -y degit MystenLabs/MemWal/packages/mcp/plugin ~/.cursor/plugins/local/memwal',
    },
]

const CLIENT_ICON: Record<Exclude<ConnectClientId, 'cursor'>, string> = {
    'claude-code': '/sept2026/claude.png',
    codex: '/sept2026/codex.png',
    antigravity: '/sept2026/antigravity.png',
}

const SDK_INSTALLS = {
    js: 'npm install @mysten-incubation/memwal',
    python: 'pip install memwal',
} as const

type SdkKind = keyof typeof SDK_INSTALLS
const CONSOLE_HREF = 'https://console.wal.app'

function CursorMark() {
    return (
        <svg viewBox="0 0 10 12" aria-hidden="true">
            <path
                fill="currentColor"
                d="M9.8 2.84 5.24.07a.47.47 0 0 0-.48 0L.2 2.84A.48.48 0 0 0 0 3.2v5.6c0 .15.08.29.2.36l4.56 2.78c.15.09.33.09.48 0l4.56-2.78c.12-.07.2-.21.2-.36V3.2a.48.48 0 0 0-.2-.36Zm-.29.59L5.11 11.46a.12.12 0 0 1-.11-.03V6.17a.3.3 0 0 0-.14-.26L.53 3.29a.1.1 0 0 1 .03-.12h8.81a.16.16 0 0 1 .14.26Z"
            />
        </svg>
    )
}

function ClientIcon({ id }: { id: ConnectClientId }) {
    if (id === 'cursor') return <CursorMark />
    return <img src={CLIENT_ICON[id]} alt="" />
}

const SDK_ICON = {
    js: '/sept2026/javascript.png',
    python: '/sept2026/python.svg',
} as const

export function SdkTabIcon({ kind }: { kind: 'js' | 'python' }) {
    return (
        <span className="connect-wm-tab-mark" aria-hidden="true">
            <img src={SDK_ICON[kind]} alt="" />
        </span>
    )
}

type ConnectWalrusMemoryProps = {
    path: ConnectPath
    onPathChange: (path: ConnectPath) => void
    hasDelegateKey: boolean
    consoleAvailable?: boolean
    onSdkKindChange?: (kind: SdkKind) => void
    onImportExistingKey?: (privateKey: string) => Promise<void> | void
    importingExistingKey?: boolean
    importExistingKeyError?: string
    importExistingKeyUnavailable?: boolean
}

function CodeBlock({ text, label, copied, onCopy }: {
    text: string
    label: string
    copied: string | null
    onCopy: (text: string, label: string) => void
}) {
    return (
        <div className="connect-wm-code">
            <pre><code>{text}</code></pre>
            <button
                type="button"
                className="connect-wm-copy"
                aria-label={copied === label ? 'Copied' : `Copy ${label}`}
                onClick={() => onCopy(text, label)}
            >
                <Copy size={16} aria-hidden="true" />
            </button>
        </div>
    )
}

export default function ConnectWalrusMemory({
    path,
    onPathChange,
    hasDelegateKey,
    consoleAvailable = config.walrusConsoleEnabled,
    onSdkKindChange,
    onImportExistingKey,
    importingExistingKey = false,
    importExistingKeyError = '',
    importExistingKeyUnavailable = false,
}: ConnectWalrusMemoryProps) {
    const [clientId, setClientId] = useState<ConnectClientId>('claude-code')
    const [copied, setCopied] = useState<string | null>(null)
    const [existingKey, setExistingKey] = useState('')
    const [sdkKind, setSdkKind] = useState<SdkKind>('js')
    const guideRef = useRef<HTMLDivElement>(null)

    useLayoutEffect(() => {
        const guide = guideRef.current
        if (!guide) return
        const measure = () => {
            const tab = guide.querySelector<HTMLElement>('.connect-wm-tab--active')
            if (!tab) return
            guide.style.setProperty('--connect-line-x', `${tab.offsetLeft + tab.offsetWidth / 2}px`)
        }
        measure()
        if (typeof ResizeObserver === 'undefined') return
        const observer = new ResizeObserver(measure)
        observer.observe(guide)
        return () => observer.disconnect()
    }, [clientId, path, sdkKind])
    const client = CLIENTS.find((item) => item.id === clientId) ?? CLIENTS[0]

    const copy = async (text: string, item: string) => {
        await navigator.clipboard.writeText(text)
        setCopied(item)
        trackEvent('copy_action', { item, location: 'dashboard_connect' })
        window.setTimeout(() => setCopied((current) => (current === item ? null : current)), 2000)
    }

    return (
        <section className="connect-wm" aria-labelledby="connect-wm-title">
            <header className="connect-wm-hero">
                <h2 id="connect-wm-title">Connect Walrus Memory</h2>
                <p>Give your agent or app portable memory in a few steps.</p>
            </header>

            <div className="connect-wm-paths" role="group" aria-label="What you are connecting">
                <button
                    type="button"
                    className={`connect-wm-path${path === 'agent' ? ' connect-wm-path--active' : ''}`}
                    aria-pressed={path === 'agent'}
                    onClick={() => {
                        trackEvent('cta_click', { cta: 'connect_agent', location: 'dashboard_connect' })
                        onPathChange('agent')
                    }}
                >
                    <span className="connect-wm-path-title">Connect an agent</span>
                    <span className="connect-wm-path-copy">Add Walrus Memory to Claude Code, Codex, Antigravity, and Cursor.</span>
                    <span className="connect-wm-stack" aria-hidden="true">
                        {CLIENTS.map((item) => (
                            <span key={item.id} className="connect-wm-mark"><ClientIcon id={item.id} /></span>
                        ))}
                    </span>
                </button>
                <button
                    type="button"
                    className={`connect-wm-path${path === 'app' ? ' connect-wm-path--active' : ''}`}
                    aria-pressed={path === 'app'}
                    onClick={() => {
                        trackEvent('cta_click', { cta: 'connect_app', location: 'dashboard_connect' })
                        onPathChange('app')
                    }}
                >
                    <span className="connect-wm-path-title">Connect an app</span>
                    <span className="connect-wm-path-copy">Add Walrus Memory to your application with our SDK.</span>
                </button>
            </div>

            {path === 'agent' ? (
                <div className="connect-wm-guide" ref={guideRef}>
                    <div className="connect-wm-tabbar" role="tablist" aria-label="Agent">
                        {CLIENTS.map((item) => (
                            <button
                                key={item.id}
                                type="button"
                                role="tab"
                                id={`connect-tab-${item.id}`}
                                aria-selected={item.id === client.id}
                                aria-controls="connect-wm-panel"
                                className={`connect-wm-tab${item.id === client.id ? ' connect-wm-tab--active' : ''}`}
                                onClick={() => {
                                    trackEvent('cta_click', { cta: `connect_client_${item.id}`, location: 'dashboard_connect' })
                                    setClientId(item.id)
                                }}
                            >
                                <span className="connect-wm-tab-mark" aria-hidden="true"><ClientIcon id={item.id} /></span>
                                {item.label}
                            </button>
                        ))}
                    </div>

                    <div className="connect-wm-client">
                        <span className="connect-wm-client-badge" aria-hidden="true"><ClientIcon id={client.id} /></span>
                        <h3>{client.label}</h3>
                    </div>

                    <div id="connect-wm-panel" role="tabpanel" aria-labelledby={`connect-tab-${client.id}`}>
                        <ol className="connect-wm-timeline">
                            <li>
                                <span className="connect-wm-num">01</span>
                                <div>
                                    <h3>Install the plugin</h3>
                                    <p>Add Walrus Memory to {client.label}:</p>
                                    <CodeBlock text={client.command} label={`${client.label} install`} copied={copied} onCopy={copy} />
                                    {client.slash && (
                                        <>
                                            <p className="connect-wm-or">Or, inside {client.label}:</p>
                                            <CodeBlock text={client.slash} label={`${client.label} slash`} copied={copied} onCopy={copy} />
                                        </>
                                    )}
                                    {client.id === 'cursor' && (
                                        <p className="connect-wm-or">Cursor has no plugin marketplace. If ~/.cursor/mcp.json already lists memwal, remove that entry so the server is not registered twice.</p>
                                    )}
                                    {client.id === 'codex' && (
                                        <p className="connect-wm-or">Then run /hooks and trust the MemWal hooks. Codex does not run them until you do.</p>
                                    )}
                                </div>
                            </li>
                            <li>
                                <span className="connect-wm-num">02</span>
                                <div>
                                    <h3>Restart and sign in</h3>
                                    <p>Restart {client.label}, then run <code>memwal_login</code> when prompted to connect your Walrus Memory account.</p>
                                </div>
                            </li>
                            <li>
                                <span className="connect-wm-num">03</span>
                                <div>
                                    <h3>Confirm it works</h3>
                                    <p>Ask {client.askName} to remember something, then start a new session and recall it.</p>
                                </div>
                            </li>
                        </ol>
                    </div>

                    {consoleAvailable && (
                        <a className="connect-wm-console" href={CONSOLE_HREF} target="_blank" rel="noopener noreferrer">
                            View your memory in Walrus Console
                            <span aria-hidden="true">→</span>
                        </a>
                    )}
                </div>
            ) : (
                <div className="connect-wm-guide" ref={guideRef}>
                    <div className="connect-wm-tabbar" role="tablist" aria-label="SDK language">
                        {(['js', 'python'] as const).map((kind) => (
                            <button
                                key={kind}
                                type="button"
                                role="tab"
                                aria-selected={sdkKind === kind}
                                className={`connect-wm-tab${sdkKind === kind ? ' connect-wm-tab--active' : ''}`}
                                onClick={() => {
                                    trackEvent('sdk_install_tab_selected', { sdk: kind, location: 'dashboard_connect' })
                                    setSdkKind(kind)
                                    onSdkKindChange?.(kind)
                                }}
                            >
                                <SdkTabIcon kind={kind} />
                                {kind === 'js' ? 'JS' : 'Python'}
                            </button>
                        ))}
                    </div>
                    <ol className="connect-wm-timeline connect-wm-timeline--solo">
                        <li>
                            <span className="connect-wm-num">01</span>
                            <div>
                                <h3>Install the SDK</h3>
                                <p>Add Walrus Memory to your application:</p>
                                <CodeBlock text={SDK_INSTALLS[sdkKind]} label={`${sdkKind} install`} copied={copied} onCopy={copy} />
                            </div>
                        </li>
                        <li>
                            <span className="connect-wm-num">02</span>
                            <div>
                                <h3>Create a delegate key</h3>
                                <p>
                                    {hasDelegateKey
                                        ? 'This browser already has a delegate key. Copy it from SDK credentials below.'
                                        : 'Create a delegate key below and save the private key. An agent install does not need this key.'}
                                </p>
                                <a className="connect-wm-inline" href="#delegate-keys">Delegate keys</a>
                                <form
                                    className="connect-wm-import"
                                    onSubmit={(event) => {
                                        event.preventDefault()
                                        void onImportExistingKey?.(existingKey)
                                    }}
                                >
                                    <label htmlFor="existing-delegate-key">Already have a delegate key?</label>
                                    <textarea
                                        id="existing-delegate-key"
                                        value={existingKey}
                                        onChange={(event) => setExistingKey(event.target.value)}
                                        placeholder="Paste an existing delegate key"
                                        aria-label="existing delegate key"
                                        spellCheck={false}
                                        rows={2}
                                    />
                                    {importExistingKeyError && (
                                        <p className="connect-wm-import-error" role="alert">{importExistingKeyError}</p>
                                    )}
                                    <button
                                        type="submit"
                                        className="connect-wm-console"
                                        disabled={importingExistingKey || importExistingKeyUnavailable || !existingKey.trim() || !onImportExistingKey}
                                    >
                                        {importingExistingKey ? 'Checking key...' : importExistingKeyUnavailable ? 'Checking account...' : 'Use this key'}
                                    </button>
                                </form>
                            </div>
                        </li>
                        <li>
                            <span className="connect-wm-num">03</span>
                            <div>
                                <h3>Paste the quickstart</h3>
                                <p>Copy the setup snippet into your app.</p>
                                <a className="connect-wm-inline" href="#sdk-quickstart">SDK quickstart</a>
                            </div>
                        </li>
                        <li>
                            <span className="connect-wm-num">04</span>
                            <div>
                                <h3>Open the playground</h3>
                                <p>Try remember and recall in this browser. The playground uses the delegate key saved here.</p>
                                <Link className="connect-wm-console" to="/playground">Open playground</Link>
                            </div>
                        </li>
                    </ol>
                </div>
            )}

            {consoleAvailable && (
                <section className="connect-wm-memories" aria-labelledby="connect-wm-memories-title">
                    <div className="connect-wm-memories-copy">
                        <h3 id="connect-wm-memories-title">View your <br />memories</h3>
                        <p>See your agent memories alongside your files in Walrus Console.</p>
                        <a href={CONSOLE_HREF} target="_blank" rel="noopener noreferrer">Open Walrus Console</a>
                    </div>
                </section>
            )}
        </section>
    )
}
