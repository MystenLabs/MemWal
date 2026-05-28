/**
 * Landing Page - two login options via "SDK Playground" popover:
 *
 * 1. Sign in with Google (Enoki)
 * 2. Connect Wallet (any Sui wallet)
 *
 * After login, redirects to /dashboard where SetupWizard handles
 * delegate key generation if needed.
 */

import {
    ConnectButton,
    useConnectWallet,
    useCurrentAccount,
    useWallets,
} from '@mysten/dapp-kit'
import { isEnokiWallet, type EnokiWallet, type AuthProvider } from '@mysten/enoki'
import {
    ArrowRight,
    ArrowUpRight,
    ChevronDown,
    Copy,
    Minus,
    Plus,
} from 'lucide-react'
import { useRef, useState, useEffect, useCallback } from 'react'
import { useNavigate } from 'react-router-dom'
import { useDelegateKey } from '../App'
import { config } from '../config'
import { trackEvent } from '../utils/analytics'

type AuthMethod = 'enoki' | 'wallet' | null

const AUTH_METHOD_KEY = 'memwal_auth_method'
const MARKETING_ASSET_VERSION = 'walm61-20260529b'
const marketingAsset = (path: string) => `${path}?v=${MARKETING_ASSET_VERSION}`

function persistAuthMethod(method: AuthMethod) {
    if (method) {
        sessionStorage.setItem(AUTH_METHOD_KEY, method)
    } else {
        sessionStorage.removeItem(AUTH_METHOD_KEY)
    }
}

function getPersistedAuthMethod(): AuthMethod {
    const val = sessionStorage.getItem(AUTH_METHOD_KEY)
    if (val === 'enoki' || val === 'wallet') return val
    return null
}

const builderLogos = [
    { label: 'Allium', src: marketingAsset('/walrus-logo-allium.png'), className: 'wm-logo-allium', nodeId: '2425:2711' },
    { label: 'inflectiv', src: marketingAsset('/walrus-logo-inflectiv.svg'), className: 'wm-logo-inflectiv', nodeId: '2425:2696' },
    { label: 'OpenGradient', src: marketingAsset('/walrus-logo-opengradient.svg'), className: 'wm-logo-opengradient', nodeId: '2425:2692' },
    { label: 'TALUS', src: marketingAsset('/walrus-logo-talus.svg'), className: 'wm-logo-talus', nodeId: '2425:2693' },
    { label: 'TATUM', src: marketingAsset('/walrus-logo-tatum.svg'), className: 'wm-logo-tatum', nodeId: '2575:73' },
    { label: 'CONSO', src: marketingAsset('/walrus-logo-conso.png'), className: 'wm-logo-conso', nodeId: '2575:78' },
]

const portableCards = [
    {
        nodeId: '2302:2635',
        iconSrc: marketingAsset('/walrus-card-portable.svg'),
        title: 'Portable by design',
        copy: 'Context doesn’t die when the session ends. Your agent picks up where it left off — in a different app, in a different runtime, weeks later.',
        codeLines: ['Your agents keep context', 'wherever they run'],
    },
    {
        nodeId: '2302:2648',
        iconSrc: marketingAsset('/walrus-card-control.svg'),
        title: 'Yours to control',
        copy: 'You decide how every memory is shared, accessed, and updated. Programmable permissions, explicit ownership, privacy on your terms.',
        codeLines: ['Explicit privacy and access', 'permissions'],
    },
    {
        nodeId: '2302:2661',
        iconSrc: marketingAsset('/walrus-card-coordination.svg'),
        title: 'Built for coordination',
        copy: 'In multi-step workflows, your agents share memory and stay coordinated on the same state. Memory integrity is independently verifiable.',
        codeLines: ['Multiple agents, one source', 'of truth'],
    },
]

const stackItems = [
    { title: 'Model providers', copy: 'Works with every major LLM out of the box.' },
    { title: 'Agent frameworks', copy: 'First-party plugins for OpenClaw and NemoClaw.' },
    { title: 'Protocols', copy: 'Native MCP support. No adapters needed.' },
    { title: 'SDKs', copy: 'Python, TypeScript, and JavaScript. Pick your language.' },
]

const builderCards = [
    {
        nodeId: '2425:2230',
        iconNodeId: '2425:2232',
        titleNodeId: '2425:2231',
        copyNodeId: '2425:2239',
        title: 'Multi-agent workflows',
        copy: 'Agents share context across tasks, tools, and time. What one agent learns can becomes available to the entire workflow.',
    },
    {
        nodeId: '2425:2240',
        iconNodeId: '2425:2242',
        titleNodeId: '2425:2241',
        copyNodeId: '2425:2249',
        title: 'Customer support agents',
        copy: 'Picks up where the last conversation ended. Knows what was tried, what failed, and what the customer actually needs.',
    },
    {
        nodeId: '2425:2250',
        iconNodeId: '2425:2252',
        titleNodeId: '2425:2251',
        copyNodeId: '2425:2259',
        title: 'Notes and research apps',
        copy: 'A second brain that compounds over time. Capture ideas continuously and retrieve them naturally weeks later.',
    },
    {
        nodeId: '2425:2260',
        iconNodeId: '2425:2262',
        titleNodeId: '2425:2261',
        copyNodeId: '2425:2269',
        title: 'Personal assistants',
        copy: 'Remembers tone, preferences, routines, and relationships. Stop starting from scratch every session.',
    },
]

const rememberFlow = [
    {
        title: 'Authenticate',
        copy: 'Your SDK sends a signed request so the relayer can verify ownership and access.',
    },
    {
        title: 'Process',
        copy: 'The relayer analyzes and encodes your memory using embedding models optimized for retrieval.',
    },
    {
        title: 'Encrypt & store',
        copy: 'Your memory is encrypted, stored on Walrus, and indexed for fast semantic search.',
    },
]

const recallFlow = [
    {
        title: 'Authenticate',
        copy: 'Your SDK sends a signed query request so the relayer can verify access permissions.',
    },
    {
        title: 'Search',
        copy: 'The relayer interprets the query, retrieves the most relevant memories, and fetches them from Walrus.',
    },
    {
        title: 'Decrypt & inject',
        copy: 'The memory is decrypted and injected into the model context for downstream reasoning.',
    },
]

const faqs = [
    {
        q: 'What is Walrus Memory?',
        a: 'A portable memory layer for AI agents: remember durable context, recall it by meaning, and keep ownership tied to a user account.',
    },
    {
        q: 'How is Walrus Memory different from Redis, Postgres, or a vector DB?',
        a: 'Those are app-local databases. Walrus Memory is designed as portable memory that can move across agent surfaces while preserving account-level control.',
    },
    {
        q: 'What does “portable” actually mean here?',
        a: 'Memory isn’t tied to a single runtime, app, or provider. Agents can read and write the same memory across sessions, environments, and frameworks. Switching stacks or moving agents between apps doesn’t reset their state.',
    },
]

const footerColumns = [
    {
        heading: 'DISCOVER',
        links: [
            { label: 'About', href: '#discover' },
            { label: 'Memory layer', href: '#memory-layer' },
            { label: 'Developers', href: '#build' },
            { label: 'Newsroom', href: '#ecosystem', external: true },
            { label: 'Roadmap', href: '#production' },
        ],
    },
    {
        heading: 'BUILD',
        links: [
            { label: 'Read the Docs', href: 'docs', external: true },
            { label: 'Ecosystem', href: '#ecosystem' },
            { label: 'Grants & RFPs', href: '#ecosystem' },
            { label: 'GitHub', href: 'https://github.com/MystenLabs/memwal', external: true },
        ],
    },
    {
        heading: 'USE CASES',
        links: [
            { label: 'Agents', href: '#ecosystem' },
            { label: 'Data Markets', href: '#ecosystem' },
            { label: 'DeFi', href: '#ecosystem' },
            { label: 'Research', href: '#ecosystem' },
        ],
    },
    {
        heading: 'ABOUT',
        links: [
            { label: 'Events', href: '#ecosystem' },
            { label: 'Media Kit', href: '#ecosystem' },
            { label: 'Bug Bounty Program', href: '#ecosystem' },
            { label: 'Release Schedule', href: '#production' },
        ],
    },
]

const socialLinks = [
    { label: 'Discord', href: '#', src: marketingAsset('/walrus-social-discord.svg') },
    { label: 'Telegram', href: '#', src: marketingAsset('/walrus-social-telegram.svg') },
    { label: 'X', href: '#', src: marketingAsset('/walrus-social-x.svg') },
    { label: 'LinkedIn', href: '#', src: marketingAsset('/walrus-social-linkedin.svg') },
    { label: 'YouTube', href: '#', src: marketingAsset('/walrus-social-youtube.svg') },
]

const signinLogos = [
    { label: 'Allium', src: marketingAsset('/walrus-trust-allium.png'), w: 143 },
    { label: 'inflectiv', src: marketingAsset('/walrus-trust-inflectiv.svg'), w: 162 },
    { label: 'OpenGradient', src: marketingAsset('/walrus-trust-opengradient.svg'), w: 191 },
    { label: 'TALUS', src: marketingAsset('/walrus-trust-talus.svg'), w: 117 },
    { label: 'TATUM', src: marketingAsset('/walrus-trust-tatum.svg'), w: 128 },
    { label: 'CONSO', src: marketingAsset('/walrus-logo-conso.png'), w: 146 },
]

const HERO_QUICKSTART_CODE = [
    '// Step 1 — Install the SDK (run in the terminal)',
    '// npm install @mysten-incubation/memwal',
    '',
    '// Step 2: Save as walrus_memory_quickstart.mjs and run:',
    '// node walrus_memory_quickstart.mjs',
    'import { MemWal } from "@mysten-incubation/memwal"',
    '',
    'const memwal = MemWal.create({',
    '  key: process.env.MEMWAL_PRIVATE_KEY ?? "<YOUR_PRIVATE_KEY>",',
    '  accountId: process.env.MEMWAL_ACCOUNT_ID ?? "<YOUR_ACCOUNT_ID>",',
    '  serverUrl: process.env.MEMWAL_SERVER_URL ?? "https://relayer.memwal.ai",',
    '})',
    '',
    '// Remember something',
    'const job = await memwal.remember("I\'m allergic to peanuts")',
    'await memwal.waitForRememberJob(job.job_id)',
    '',
    '// Search memories',
    'const result = await memwal.recall("food allergies")',
    'console.log(result.results[0].text)',
].join('\n')

export default function LandingPage() {
    const currentAccount = useCurrentAccount()
    const { mutate: connect } = useConnectWallet()
    const wallets = useWallets()
    const enokiWallets = wallets.filter(isEnokiWallet)
    const { delegateKey } = useDelegateKey()

    const walletsByProvider = enokiWallets.reduce(
        (map, wallet) => map.set(wallet.provider, wallet),
        new Map<AuthProvider, EnokiWallet>(),
    )
    const googleWallet = walletsByProvider.get('google')

    const navigate = useNavigate()
    const hasEnokiConfig = !!(config.enokiApiKey && config.googleClientId)
    const demoUrls = config.demoUrls

    const [demoOpen, setDemoOpen] = useState(false)
    const demoRef = useRef<HTMLDivElement>(null)
    const [loginOpen, setLoginOpen] = useState(false)
    const loginRef = useRef<HTMLDivElement>(null)
    const [openFaqIndex, setOpenFaqIndex] = useState(2)

    const walletClickedRef = useRef(false)
    const signInTrackedRef = useRef(false)

    useEffect(() => {
        const handleClickOutside = (e: MouseEvent) => {
            if (demoRef.current && !demoRef.current.contains(e.target as Node)) {
                setDemoOpen(false)
            }
            if (loginRef.current && !loginRef.current.contains(e.target as Node) && !walletClickedRef.current) {
                setLoginOpen(false)
            }
        }
        document.addEventListener('mousedown', handleClickOutside)
        return () => document.removeEventListener('mousedown', handleClickOutside)
    }, [])

    useEffect(() => {
        const scrollToHashTarget = () => {
            const targetId = window.location.hash.slice(1)
            if (!targetId) return

            window.requestAnimationFrame(() => {
                document.getElementById(targetId)?.scrollIntoView({ block: 'start' })
            })
        }

        scrollToHashTarget()
        window.addEventListener('hashchange', scrollToHashTarget)
        return () => window.removeEventListener('hashchange', scrollToHashTarget)
    }, [])

    const updateAuthMethod = useCallback((method: AuthMethod) => {
        persistAuthMethod(method)
    }, [])

    useEffect(() => {
        if (currentAccount && !delegateKey) {
            let authMethod = getPersistedAuthMethod()
            if (!authMethod && walletClickedRef.current) {
                authMethod = 'wallet'
                walletClickedRef.current = false
                updateAuthMethod('wallet')
            }
            if (authMethod && !signInTrackedRef.current) {
                trackEvent('sign_in_complete', { auth_method: authMethod })
                signInTrackedRef.current = true
            }
            navigate('/dashboard')
        }
    }, [currentAccount, delegateKey, updateAuthMethod, navigate])

    const handleEnokiConnect = () => {
        if (!googleWallet) return
        updateAuthMethod('enoki')
        trackEvent('sign_in_start', { auth_method: 'enoki', location: 'landing_nav' })
        setLoginOpen(false)
        connect({ wallet: googleWallet })
    }

    const handleWalletClick = () => {
        walletClickedRef.current = true
        updateAuthMethod('wallet')
        trackEvent('sign_in_start', { auth_method: 'wallet', location: 'landing_nav' })
    }

    const openPlayground = (location: string) => {
        trackEvent('cta_click', {
            cta: 'sdk_playground',
            location,
            state: currentAccount && delegateKey ? 'authenticated' : 'signed_out',
        })
        if (currentAccount && delegateKey) {
            navigate('/dashboard')
            return
        }
        setLoginOpen(true)
        window.scrollTo({ top: 0, behavior: 'smooth' })
    }

    const copyQuickstart = () => {
        void navigator.clipboard?.writeText(HERO_QUICKSTART_CODE)
        trackEvent('code_copy', { location: 'landing_hero_quickstart' })
    }

    return (
        <div className="wm-page">
            <nav className="wm-nav">
                <a href="/" className="wm-logo" aria-label="Walrus Memory home">
                    <span>walrus</span>
                    <span>memory</span>
                </a>

                <div className="wm-nav-links">
                    <a href="#discover">Discover <ChevronDown size={14} /></a>
                    <a href="#build">Build <ChevronDown size={14} /></a>
                    {demoUrls.length > 0 ? (
                        <div className="lp-demo-dropdown wm-demo-dropdown" ref={demoRef}>
                            <button
                                className="wm-nav-link-button"
                                onClick={() => {
                                    trackEvent('cta_click', { cta: 'demo_menu', location: 'landing_nav' })
                                    setDemoOpen(o => !o)
                                }}
                            >
                                Ecosystem <ChevronDown size={14} className={`lp-demo-chevron${demoOpen ? ' open' : ''}`} />
                            </button>
                            {demoOpen && (
                                <div className="lp-demo-menu wm-menu">
                                    {demoUrls.map(({ label, url }) => (
                                        <a
                                            key={url}
                                            href={url}
                                            target="_blank"
                                            rel="noopener noreferrer"
                                            className="lp-demo-item"
                                            onClick={() => {
                                                trackEvent('demo_link_click', { label, location: 'landing_nav' })
                                                setDemoOpen(false)
                                            }}
                                        >
                                            {label} <ArrowUpRight size={14} />
                                        </a>
                                    ))}
                                </div>
                            )}
                        </div>
                    ) : (
                        <a href="#ecosystem">Ecosystem <ChevronDown size={14} /></a>
                    )}
                </div>

                <div className="lp-demo-dropdown lp-login-dropdown wm-login" ref={loginRef}>
                    {config.docsUrl ? (
                        <a
                            className="wm-docs-button"
                            href={config.docsUrl}
                            target="_blank"
                            rel="noopener noreferrer"
                            onClick={() => trackEvent('outbound_link_click', { link: 'docs', location: 'landing_nav' })}
                        >
                            Read the docs <ArrowRight size={14} />
                        </a>
                    ) : (
                        <button className="wm-docs-button" onClick={() => openPlayground('landing_nav')}>
                            Start building <ArrowRight size={14} />
                        </button>
                    )}
                    {loginOpen && (
                        <div className="wm-signin" role="dialog" aria-modal="true" aria-label="Sign in">
                            <div className="wm-signin-backdrop" onClick={() => setLoginOpen(false)} aria-hidden="true" />
                            <img className="wm-signin-aurora" src={marketingAsset('/walrus-signin-bg.png')} alt="" aria-hidden="true" />
                            <button className="wm-signin-close" onClick={() => setLoginOpen(false)} aria-label="Close sign in">
                                <Plus size={22} />
                            </button>
                            <div className="wm-signin-inner">
                                <div className="wm-signin-card">
                                    <img className="wm-signin-logo" src={marketingAsset('/walrus-signin-logo.svg')} alt="Walrus Memory" />
                                    <p className="wm-signin-sub">Sign in to start building with portable memory across apps and workflows.</p>
                                    {hasEnokiConfig && googleWallet && (
                                        <button className="wm-signin-google" onClick={handleEnokiConnect}>
                                            <svg width="20" height="20" viewBox="0 0 24 24" aria-hidden="true">
                                                <path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 0 1-2.2 3.32v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.1z" fill="#4285F4" />
                                                <path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" fill="#34A853" />
                                                <path d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z" fill="#FBBC05" />
                                                <path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" fill="#EA4335" />
                                            </svg>
                                            Continue with Google
                                        </button>
                                    )}
                                    <div onClick={handleWalletClick} className="wm-signin-wallet">
                                        <ConnectButton connectText="Connect wallet" />
                                    </div>
                                    <p className="wm-signin-tos">
                                        By continuing, you agree to our <a href={config.docsUrl || '#'} target="_blank" rel="noopener noreferrer">Terms of Service</a> and <a href={config.docsUrl || '#'} target="_blank" rel="noopener noreferrer">Privacy Policy</a>
                                    </p>
                                </div>
                                <div className="wm-signin-trusted" aria-hidden="true">
                                    <h2>Trusted by teams<br />building <span>reliable</span><br />AI systems</h2>
                                    <div className="wm-signin-logos">
                                        {signinLogos.map((logo) => (
                                            <img key={logo.label} src={logo.src} alt={logo.label} style={{ width: `${logo.w}px` }} />
                                        ))}
                                    </div>
                                </div>
                            </div>
                        </div>
                    )}
                </div>
            </nav>

            <main>
                <section className="wm-hero" id="discover">
                    <div className="wm-hero-bg" aria-hidden="true">
                        <img
                            src={marketingAsset('/walrus-memory-aurora-snake.png')}
                            alt=""
                            className="wm-hero-bg-layer wm-hero-bg-layer--snake"
                            data-node-id="2425:2274"
                        />
                        <img
                            src={marketingAsset('/walrus-memory-aurora-r-layer.png')}
                            alt=""
                            className="wm-hero-bg-layer wm-hero-bg-layer--r"
                            data-node-id="2425:2275"
                        />
                    </div>
                    <div className="wm-hero-copy">
                        <h1>
                            <span className="wm-hero-title-line" data-node-id="2425:2564">Take your agent’s</span>
                            <span className="wm-hero-title-line">
                                <span className="wm-hero-title-memory" data-node-id="2425:2567">memory</span>{' '}
                                <span className="wm-hero-title-anywhere" data-node-id="2425:2568">anywhere</span>
                            </span>
                        </h1>
                        <p data-node-id="2425:2570">
                            Walrus Memory is a portable memory layer that makes AI agents reliable across apps and sessions.{' '}
                            <strong>Persistent, verifiable, and fully under your control.</strong>
                        </p>
                        <button className="wm-start-button" onClick={() => openPlayground('landing_hero')}>
                            Start building <ArrowRight size={16} />
                        </button>
                    </div>

                    <div className="wm-code-panel" data-node-id="2425:3223" aria-label="Walrus Memory SDK quickstart">
                        <div className="wm-code-dots" data-node-id="2361:1139" aria-hidden="true">
                            <span />
                            <span />
                            <span />
                        </div>
                        <div className="wm-code-tabs" aria-label="Package manager">
                            <span className="wm-code-tab wm-code-tab--active" data-node-id="2425:3230">npm</span>
                            <span className="wm-code-tab" data-node-id="2425:3231">pnpm</span>
                            <span className="wm-code-tab" data-node-id="2425:3232">yarn</span>
                        </div>
                        <button className="wm-code-copy" type="button" onClick={copyQuickstart} aria-label="Copy SDK quickstart" data-node-id="2361:1112">
                            <Copy size={20} aria-hidden="true" />
                        </button>
                        <ol className="wm-code-lines" data-node-id="2425:3233" data-line-numbers-node-id="2425:3234">
                            <li><code><span className="wm-code-comment">// Step 1 — Install the SDK (run in the terminal)</span></code></li>
                            <li><code><span className="wm-code-comment">// npm install @mysten-incubation/memwal</span></code></li>
                            <li><code>&nbsp;</code></li>
                            <li><code><span className="wm-code-comment">// Step 2: Save as walrus_memory_quickstart.mjs and run:</span></code></li>
                            <li><code><span className="wm-code-comment">// node walrus_memory_quickstart.mjs</span></code></li>
                            <li><code><span className="wm-code-keyword">import</span> {'{'} <span className="wm-code-fn">MemWal</span> {'}'} <span className="wm-code-keyword">from</span> <span className="wm-code-string">"@mysten-incubation/memwal"</span></code></li>
                            <li><code>&nbsp;</code></li>
                            <li><code><span className="wm-code-keyword">const</span> memwal = <span className="wm-code-fn">MemWal.create</span>({'{'}</code></li>
                            <li><code>  <span className="wm-code-keyword">key:</span> process.env.MEMWAL_PRIVATE_KEY ?? <span className="wm-code-string">"&lt;YOUR_PRIVATE_KEY&gt;"</span>,</code></li>
                            <li><code>  <span className="wm-code-keyword">accountId:</span> process.env.MEMWAL_ACCOUNT_ID ?? <span className="wm-code-string">"&lt;YOUR_ACCOUNT_ID&gt;"</span>,</code></li>
                            <li><code>  <span className="wm-code-keyword">serverUrl:</span> process.env.MEMWAL_SERVER_URL ?? <span className="wm-code-string wm-code-link">"https://relayer.memwal.ai"</span>,</code></li>
                            <li><code>{'})'}</code></li>
                            <li><code>&nbsp;</code></li>
                            <li><code><span className="wm-code-comment">// Remember something</span></code></li>
                            <li><code><span className="wm-code-keyword">const</span> job = <span className="wm-code-keyword">await</span> memwal.<span className="wm-code-fn">remember</span>(<span className="wm-code-string">"I'm allergic to peanuts"</span>)</code></li>
                            <li><code><span className="wm-code-keyword">await</span> memwal.<span className="wm-code-fn">waitForRememberJob</span>(job.job_id)</code></li>
                            <li><code>&nbsp;</code></li>
                            <li><code><span className="wm-code-comment">// Search memories</span></code></li>
                            <li><code><span className="wm-code-keyword">const</span> result = <span className="wm-code-keyword">await</span> memwal.<span className="wm-code-fn">recall</span>(<span className="wm-code-string">"food allergies"</span>)</code></li>
                            <li><code><span className="wm-code-string">console</span>.<span className="wm-code-fn">log</span>(result.results[<span className="wm-code-fn">0</span>].text)</code></li>
                        </ol>
                    </div>
                </section>

                <div className="wm-spine wm-spine--pre-builders" aria-hidden="true">
                    <span />
                    <i className="wm-spine-gem" />
                </div>

                <section className="wm-builders" aria-label="Builder logos">
                    <h2><span data-node-id="2425:2565">Builders shipping with</span><span data-node-id="2425:2566">Walrus Memory</span></h2>
                    <div className="wm-logo-row">
                        {builderLogos.map((logo) => (
                            <img
                                key={logo.label}
                                src={logo.src}
                                alt={logo.label}
                                className={logo.className}
                                data-node-id={logo.nodeId}
                                loading="lazy"
                            />
                        ))}
                    </div>
                    <div className="wm-builders-quote-card">
                        <p data-node-id="2425:2673">
                            “As AI systems become more autonomous and long-running, memory infrastructure needs stronger
                            guarantees around verifiability, portability, and reliability. We see Walrus Memory as part of a
                            broader shift toward open and interoperable AI systems.”
                        </p>
                        <div className="wm-builder-person">
                            <span data-node-id="2425:2671">Mike Hanono</span>
                            <small>CO-FOUNDER AND CEO AT TALUS</small>
                        </div>
                    </div>
                    <div className="wm-builder-lines" aria-hidden="true">
                        <span data-node-id="2425:2674" />
                        <span data-node-id="2425:2675" />
                        <span data-node-id="2425:2676" />
                    </div>
                </section>

                <div className="wm-spine wm-spine--lead" aria-hidden="true">
                    <i className="wm-spine-gem" />
                </div>

                <section className="wm-reset" id="memory-layer">
                    <h2 data-node-id="2425:2855">Without memory,<br />agents hit reset</h2>
                    <div className="wm-reset-visual">
                        <img src={marketingAsset('/walrus-memory-reset-aurora.png')} alt="" className="wm-reset-aurora" data-node-id="2425:2685" aria-hidden="true" />
                        <img src={marketingAsset('/walrus-memory-reset-mascot.png')} alt="" className="wm-reset-mascot" data-node-id="2425:2853" aria-hidden="true" />
                    </div>
                    <div className="wm-command-pill" data-node-id="2425:2849">
                        <span>A workflow spans two agents, and neither knows what th</span>
                        <i aria-hidden="true" />
                    </div>
                    <p data-node-id="2425:2687">
                        When state isn’t shared, agents make conflicting decisions. When memory is stale
                        or unverifiable, <strong>the output isn’t reliable</strong> enough for production.
                        <br /><br />
                        And when something breaks,
                        there’s no way to trace what your agent acted on: the right data, or something from three
                        sessions ago. <strong>No audit trail. No ownership.</strong>
                    </p>
                </section>

                <div className="wm-spine wm-spine--reset" aria-hidden="true">
                    <span />
                    <i className="wm-spine-gem" />
                </div>

                <section className="wm-portable" id="portable">
                    <h2 data-node-id="2302:2610">A <span>portable</span> memory layer<br />for AI <em>agents</em></h2>
                    <div className="wm-card-grid">
                        {portableCards.map((card) => (
                            <article className="wm-dark-card" key={card.title} data-node-id={card.nodeId}>
                                <img className="wm-card-icon" src={card.iconSrc} alt="" aria-hidden="true" />
                                <h3>{card.title}</h3>
                                <p>{card.copy}</p>
                                <code>
                                    <span className="wm-code-mark" aria-hidden="true" />
                                    <span className="wm-code-text">
                                        {card.codeLines.map((line) => (
                                            <span key={line}>{line}</span>
                                        ))}
                                    </span>
                                </code>
                            </article>
                        ))}
                    </div>
                    <button className="wm-small-cta" data-node-id="2269:4584" onClick={() => openPlayground('portable_section')}>Get started <ArrowRight size={14} /></button>
                </section>

                <section className="wm-stack" id="build" data-node-id="2266:3695">
                    <div>
                        <h2 data-node-id="2269:5066">Plugs into the<br />stack you<br />already have</h2>
                        <p data-node-id="2269:5068">
                            Walrus Memory ships with native support for the platforms and
                            protocols teams are already building on.
                        </p>
                        <a
                            href={config.docsUrl || 'https://github.com/MystenLabs/memwal'}
                            target="_blank"
                            rel="noopener noreferrer"
                            onClick={() => trackEvent('outbound_link_click', { link: config.docsUrl ? 'docs' : 'github', location: 'stack_section' })}
                        >
                            <span data-node-id="2290:30">Explore docs</span> <ArrowRight size={14} />
                        </a>
                    </div>
                    <div className="wm-stack-list" data-node-id="2351:190">
                        {stackItems.map((item) => (
                            <div className="wm-stack-item" key={item.title}>
                                <span aria-hidden="true" />
                                <div>
                                    <h3>{item.title}</h3>
                                    <p>{item.copy}</p>
                                </div>
                            </div>
                        ))}
                    </div>
                    <div className="wm-aurora wm-aurora--stack" data-node-id="2302:808" aria-hidden="true">
                        <span className="wm-aurora-streaks" data-node-id="2302:809" />
                    </div>
                </section>

                <section className="wm-light-band" id="ecosystem">
                    <div className="wm-light-band-bg" data-node-id="2425:2270" aria-hidden="true" />
                    <div className="wm-light-heading">
                        <h2><span data-node-id="2425:2857">What builders are creating</span><span data-node-id="2425:2861">with</span> <span data-node-id="2425:2858">Walrus Memory</span></h2>
                        <p data-node-id="2425:2859">
                            A portable agent memory layer doesn’t just improve your stack. It changes
                            how your product behaves — and what users come to rely on.
                            <br /><strong>The moat is the memory, not the model.</strong>
                        </p>
                    </div>
                    <div className="wm-builder-grid">
                        {builderCards.map((card) => (
                            <article key={card.title} data-node-id={card.nodeId}>
                                <span className="wm-builder-icon" data-node-id={card.iconNodeId} aria-hidden="true" />
                                <h3 data-node-id={card.titleNodeId}>{card.title}</h3>
                                <p data-node-id={card.copyNodeId}>{card.copy}</p>
                            </article>
                        ))}
                    </div>
                    <button className="wm-small-cta" data-node-id="2425:2744" onClick={() => openPlayground('builders_section')}>Start building <ArrowRight size={14} /></button>
                    <span className="wm-light-band-line" data-node-id="2425:3045" aria-hidden="true" />
                </section>

                <section className="wm-production" id="production">
                    <h2 data-node-id="2302:2611">Memory that holds up<br />in production</h2>
                    <p data-node-id="2302:2682">
                        Context travels with the workflow: programmable permissions, verifiable state,
                        no lock-in. Built on{' '}
                        <a href="https://walrus.xyz/" target="_blank" rel="noopener noreferrer">Walrus</a><strong>, the Verifiable Data Platform</strong>.
                    </p>
                    <div className="wm-production-aurora" data-node-id="2425:2227" aria-hidden="true" />
                    <div className="wm-production-transition" data-node-id="2425:2229" aria-hidden="true" />
                    <div className="wm-production-grid">
                        <div className="wm-flow-column">
                            <button data-node-id="2302:2608">Remember</button>
                            {rememberFlow.map((item) => (
                                <div key={item.title}>
                                    <h3>{item.title}</h3>
                                    <p>{item.copy}</p>
                                </div>
                            ))}
                        </div>
                        <div className="wm-production-mascot">
                            <img src={marketingAsset('/walrus-memory-monogram.png')} alt="Walrus Memory mascot holding a card" data-node-id="2425:2740" />
                        </div>
                        <div className="wm-flow-column">
                            <button data-node-id="2302:2609">Recall</button>
                            {recallFlow.map((item) => (
                                <div key={item.title}>
                                    <h3>{item.title}</h3>
                                    <p>{item.copy}</p>
                                </div>
                            ))}
                        </div>
                    </div>
                </section>

                <section className="wm-bottom-cta">
                    <div className="wm-bottom-dark-base" data-node-id="2425:2228" aria-hidden="true" />
                    <div className="wm-bottom-dark-gradient" data-node-id="2425:2569" aria-hidden="true" />
                    <div className="wm-bottom-rounded-gradient" data-node-id="2425:2713" aria-hidden="true" />
                    <div className="wm-aurora wm-aurora--cta" aria-hidden="true" />
                    <h2><span data-node-id="2425:2276">Build agents that</span><br /><span>remember</span></h2>
                    <div className="wm-spine wm-spine--compact" aria-hidden="true">
                        <span />
                        <i className="wm-spine-gem" />
                        <span />
                    </div>
                    <div className="wm-bottom-copy">
                        <strong>Wire memory into your agent.</strong>
                        <span>Ship without rebuilding context every session.</span>
                    </div>
                    <button className="wm-start-button" onClick={() => openPlayground('bottom_cta')}>
                        Start building <ArrowRight size={16} />
                    </button>
                    <div className="wm-cta-links">
                        <a
                            href={config.docsUrl || 'https://github.com/MystenLabs/memwal'}
                            target="_blank"
                            rel="noopener noreferrer"
                            onClick={() => trackEvent('outbound_link_click', { link: config.docsUrl ? 'docs' : 'github', location: 'bottom_cta' })}
                        >
                            Explore Docs
                        </a>
                        <a
                            href="https://github.com/MystenLabs/memwal"
                            target="_blank"
                            rel="noopener noreferrer"
                            onClick={() => trackEvent('outbound_link_click', { link: 'github', location: 'bottom_cta' })}
                        >
                            Go to GitHub
                        </a>
                        <a
                            href="#ecosystem"
                            onClick={() => trackEvent('outbound_link_click', { link: 'discord', location: 'bottom_cta' })}
                        >
                            Join Discord
                        </a>
                    </div>
                </section>

                <section className="wm-faq">
                    <h2>FAQs</h2>
                    <div>
                        {faqs.map((faq, index) => {
                            const isOpen = openFaqIndex === index
                            return (
                            <article className={isOpen ? 'wm-faq-item wm-faq-item--open' : 'wm-faq-item'} key={faq.q}>
                                <button
                                    className="wm-faq-question"
                                    type="button"
                                    aria-expanded={isOpen}
                                    onClick={() => setOpenFaqIndex(isOpen ? -1 : index)}
                                >
                                    <span>{faq.q}</span>
                                    {isOpen ? <Minus size={28} /> : <Plus size={28} />}
                                </button>
                                {isOpen && <p>{faq.a}</p>}
                            </article>
                            )
                        })}
                    </div>
                </section>
            </main>

            <footer className="wm-footer">
                <div className="wm-footer-top">
                    <div className="wm-footer-grid">
                        {footerColumns.map((col) => (
                            <div key={col.heading}>
                                <span>{col.heading}</span>
                                {col.links.map((link) => {
                                    const isDocs = link.href === 'docs'
                                    const href = isDocs ? (config.docsUrl || 'https://github.com/MystenLabs/memwal') : link.href
                                    const isExternal = link.external || href.startsWith('http')
                                    return (
                                        <a
                                            key={link.label}
                                            href={href}
                                            target={isExternal ? '_blank' : undefined}
                                            rel={isExternal ? 'noopener noreferrer' : undefined}
                                            onClick={() => trackEvent('outbound_link_click', {
                                                link: link.label.toLowerCase().replace(/\s+/g, '_'),
                                                location: 'footer',
                                            })}
                                        >
                                            {link.label}{isExternal && <ArrowUpRight size={12} />}
                                        </a>
                                    )
                                })}
                            </div>
                        ))}
                    </div>
                    <div className="wm-footer-side">
                        <button className="wm-docs-button wm-footer-cta" onClick={() => openPlayground('footer')}>
                            Get Started <ArrowRight size={14} />
                        </button>
                        <div className="wm-socials">
                            {socialLinks.map((s) => (
                                <a
                                    key={s.label}
                                    href={s.href}
                                    aria-label={s.label}
                                    target={s.href.startsWith('http') ? '_blank' : undefined}
                                    rel={s.href.startsWith('http') ? 'noopener noreferrer' : undefined}
                                >
                                    <img src={s.src} alt="" aria-hidden="true" />
                                </a>
                            ))}
                        </div>
                    </div>
                </div>
                <div className="wm-footer-bottom">
                    <div className="wm-footer-meta">
                        <span className="wm-footer-lang">English <ArrowRight size={12} /></span>
                        <span className="wm-footer-copyright">©2026 Copyright Walrus Foundation. All rights reserved.</span>
                    </div>
                    <div className="wm-footer-word">walrus</div>
                    <img src={marketingAsset('/walrus-memory-closeup.png')} alt="" aria-hidden="true" />
                </div>
            </footer>
        </div>
    )
}
