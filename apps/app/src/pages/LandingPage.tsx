/**
 * Landing Page — Two login options via "SDK Playground" popover:
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
import { ChevronDown, Github } from 'lucide-react'
import { useRef, useState, useEffect, useCallback } from 'react'
import { useNavigate } from 'react-router-dom'
import { useDelegateKey } from '../App'
import { config } from '../config'
import memwalLogo from '../assets/memwal-logo.svg'

type AuthMethod = 'enoki' | 'wallet' | null

const AUTH_METHOD_KEY = 'memwal_auth_method'

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

    // ── Dropdown states ──
    const [demoOpen, setDemoOpen] = useState(false)
    const demoRef = useRef<HTMLDivElement>(null)
    const [loginOpen, setLoginOpen] = useState(false)
    const loginRef = useRef<HTMLDivElement>(null)

    // ── Track wallet click for ConnectButton flow ──
    const walletClickedRef = useRef(false)

    // ── Close dropdowns on outside click ──
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

    // ── Redirect to dashboard when connected ──
    useEffect(() => {
        if (currentAccount) {
            navigate('/dashboard')
        }
    }, [currentAccount, navigate])

    // ── Detect wallet connection via ConnectButton ──
    const updateAuthMethod = useCallback((method: AuthMethod) => {
        persistAuthMethod(method)
    }, [])

    useEffect(() => {
        if (currentAccount && !delegateKey) {
            const persisted = getPersistedAuthMethod()
            if (!persisted && walletClickedRef.current) {
                walletClickedRef.current = false
                setLoginOpen(false)
                updateAuthMethod('wallet')
            }
        }
    }, [currentAccount, delegateKey, updateAuthMethod])

    // ── Button handlers ──
    const handleEnokiConnect = () => {
        if (!googleWallet) return
        updateAuthMethod('enoki')
        setLoginOpen(false)
        connect({ wallet: googleWallet })
    }

    const handleWalletClick = () => {
        walletClickedRef.current = true
        updateAuthMethod('wallet')
    }

    return (
        <div className="lp-page">
            {/* ── Nav ── */}
            <nav className="lp-nav">
                <div className="lp-nav-inner">
                    <a href="/" className="lp-nav-brand">
                        <img src={memwalLogo} alt="MemWal" height="28" />
                    </a>

                    <div className="lp-nav-links">
                        {/* Demo dropdown */}
                        {demoUrls.length > 0 && (
                            <div className="lp-demo-dropdown" ref={demoRef}>
                                <button
                                    className="lp-demo-trigger"
                                    onClick={() => setDemoOpen(o => !o)}
                                >
                                    Demo <ChevronDown size={14} className={`lp-demo-chevron${demoOpen ? ' open' : ''}`} />
                                </button>
                                {demoOpen && (
                                    <div className="lp-demo-menu">
                                        {demoUrls.map(({ label, url }) => (
                                            <a
                                                key={url}
                                                href={url}
                                                target="_blank"
                                                rel="noopener noreferrer"
                                                className="lp-demo-item"
                                                onClick={() => setDemoOpen(false)}
                                            >
                                                {label} <span className="lp-arrow">↗</span>
                                            </a>
                                        ))}
                                    </div>
                                )}
                            </div>
                        )}

                        {/* SDK Playground — direct link if logged in, popover with login options if not */}
                        {currentAccount && delegateKey ? (
                            <button className="lp-nav-cta" onClick={() => navigate('/dashboard')}>
                                SDK Playground <span className="lp-arrow">↗</span>
                            </button>
                        ) : (
                            <div className="lp-demo-dropdown" ref={loginRef}>
                                <button
                                    className="lp-nav-cta"
                                    onClick={() => setLoginOpen(o => !o)}
                                >
                                    SDK Playground <span className="lp-arrow">↗</span>
                                </button>
                                {loginOpen && (
                                    <div className="lp-demo-menu" style={{ minWidth: 240, padding: 12, display: 'flex', flexDirection: 'column', gap: 8 }}>
                                        {hasEnokiConfig && googleWallet && (
                                            <button
                                                onClick={handleEnokiConnect}
                                                style={{
                                                    display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 10,
                                                    width: '100%', padding: '10px 16px',
                                                    background: '#E8FF75', color: '#000', border: '2px solid #000',
                                                    borderRadius: 10, fontSize: '0.88rem', fontWeight: 700,
                                                    fontFamily: 'var(--font-sans)', cursor: 'pointer',
                                                    boxShadow: '3px 3px 0 #000',
                                                    transition: 'transform 0.15s, box-shadow 0.15s',
                                                }}
                                                onMouseEnter={e => { e.currentTarget.style.transform = 'translate(-1px,-1px)'; e.currentTarget.style.boxShadow = '4px 4px 0 #000' }}
                                                onMouseLeave={e => { e.currentTarget.style.transform = 'none'; e.currentTarget.style.boxShadow = '3px 3px 0 #000' }}
                                            >
                                                <svg width="16" height="16" viewBox="0 0 24 24">
                                                    <path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 0 1-2.2 3.32v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.1z" fill="#4285F4" />
                                                    <path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" fill="#34A853" />
                                                    <path d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z" fill="#FBBC05" />
                                                    <path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" fill="#EA4335" />
                                                </svg>
                                                Sign in with Google
                                            </button>
                                        )}

                                        <div
                                            onClick={handleWalletClick}
                                            className="lp-login-wallet-btn"
                                        >
                                            <ConnectButton connectText="Connect Wallet" />
                                        </div>
                                    </div>
                                )}
                            </div>
                        )}
                    </div>
                </div>
            </nav>

            {/* ── Hero ── */}
            <section className="lp-hero">
                <div className="lp-hero-inner">
                    <div className="lp-hero-copy">
                        <h1>Long-Term Memory<br />for AI Agents</h1>
                        <p>
                            MemWal introduces a long-term, verifiable memory layer on
                            Walrus, allowing agents to remember, share, and reuse
                            information reliably.
                        </p>

                        <div className="lp-hero-actions">
                            {config.docsUrl && (
                                <a
                                    href={config.docsUrl}
                                    target="_blank"
                                    rel="noopener noreferrer"
                                    className="lp-btn-yellow"
                                >
                                    Documentation <span className="lp-arrow">↗</span>
                                </a>
                            )}
                            <a
                                href="https://github.com/MystenLabs/memwal"
                                target="_blank"
                                rel="noopener noreferrer"
                                className="lp-btn-outline"
                            >
                                <Github size={18} /> GitHub <span className="lp-arrow">↗</span>
                            </a>
                        </div>
                    </div>

                    <div className="lp-hero-art">
                        <img
                            src="/memwal-grid-bg.png"
                            alt=""
                            className="lp-hero-grid"
                            aria-hidden="true"
                        />
                        <img
                            src="/memwal-mascot.png"
                            alt="MemWal mascot"
                            className="lp-hero-mascot"
                        />
                    </div>
                </div>
            </section>
        </div>
    )
}
