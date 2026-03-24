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
import { Github } from 'lucide-react'
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

    const hasEnokiConfig = config.enokiApiKey && config.googleClientId

    // If somehow already connected, this page shouldn't show
    if (currentAccount) return null

    const handleConnect = () => {
        if (hasEnokiConfig && googleWallet) {
            connect({ wallet: googleWallet })
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
                        {hasEnokiConfig && googleWallet ? (
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
