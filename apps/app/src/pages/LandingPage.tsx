/**
 * Landing Page — Sign in with Google (Enoki zkLogin) or any Sui wallet
 */

import {
    ConnectButton,
    useConnectWallet,
    useCurrentAccount,
    useWallets,
} from '@mysten/dapp-kit'
import { isEnokiWallet, type EnokiWallet, type AuthProvider } from '@mysten/enoki'
import { ChevronDown, Github } from 'lucide-react'
import { useRef, useState, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { config } from '../config'
import memwalLogo from '../assets/memwal-logo.svg'

export default function LandingPage() {
    const currentAccount = useCurrentAccount()
    const { mutate: connect } = useConnectWallet()
    const wallets = useWallets()
    const enokiWallets = wallets.filter(isEnokiWallet)

    // Find Google wallet from registered Enoki wallets
    const walletsByProvider = enokiWallets.reduce(
        (map, wallet) => map.set(wallet.provider, wallet),
        new Map<AuthProvider, EnokiWallet>(),
    )
    const googleWallet = walletsByProvider.get('google')

    const navigate = useNavigate()
    const hasEnokiConfig = config.enokiApiKey && config.googleClientId
    const demoUrls = config.demoUrls
    const [demoOpen, setDemoOpen] = useState(false)
    const demoRef = useRef<HTMLDivElement>(null)

    useEffect(() => {
        const handleClickOutside = (e: MouseEvent) => {
            if (demoRef.current && !demoRef.current.contains(e.target as Node)) {
                setDemoOpen(false)
            }
        }
        document.addEventListener('mousedown', handleClickOutside)
        return () => document.removeEventListener('mousedown', handleClickOutside)
    }, [])

    const handleConnect = () => {
        if (currentAccount) {
            navigate('/dashboard')
        } else if (hasEnokiConfig && googleWallet) {
            connect({ wallet: googleWallet })
            navigate('/dashboard')
        }
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
                        {currentAccount ? (
                            <button className="lp-nav-cta" onClick={() => navigate('/dashboard')}>
                                Playground <span className="lp-arrow">↗</span>
                            </button>
                        ) : hasEnokiConfig && googleWallet ? (
                            <button className="lp-nav-cta" onClick={handleConnect}>
                                Playground <span className="lp-arrow">↗</span>
                            </button>
                        ) : (
                            <ConnectButton connectText="Playground ↗" />
                        )}
                    </div>
                </div>
            </nav>

            {/* ── Hero ── */}
            <section className="lp-hero">
                <div className="lp-hero-inner">
                    <div className="lp-hero-copy">
                        <h1>Privacy-Preserving<br />AI Memory</h1>
                        <p>
                            Store memories on Walrus, encrypt with SEAL, and recall with
                            semantic search. memwal gives agents long-term context while
                            users keep ownership.
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
