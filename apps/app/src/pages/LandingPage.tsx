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
import { config } from '../config'

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

    return (
        <>
            <div className="lp-bg">
                <div className="lp-sheet">
                    <section className="lp-hero">
                        <div className="lp-copy">
                            <div className="lp-kicker">privacy-preserving AI memory</div>
                            <h1>
                                give your AI permanent memory
                            </h1>
                            <p>
                                store memories on Walrus, encrypt with SEAL, and recall with semantic search.
                                memwal gives agents long-term context while users keep ownership.
                            </p>

                            {hasEnokiConfig && googleWallet ? (
<<<<<<< HEAD
                                <button
                                    className="btn lp-btn-main"
                                    onClick={() => connect({ wallet: googleWallet })}
                                >
                                    sign in with google
                                </button>
=======
                                <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-start', gap: 12 }}>
                                    <button
                                        className="btn lp-btn-main"
                                        onClick={() => connect({ wallet: googleWallet })}
                                    >
                                        sign in with google
                                    </button>
                                    <a
                                        href="https://docs-memwal-staging.up.railway.app/"
                                        target="_blank"
                                        rel="noopener noreferrer"
                                        style={{
                                            color: 'var(--text-secondary)',
                                            fontSize: '0.85rem',
                                            textDecoration: 'none',
                                        }}
                                    >
                                        documentation →
                                    </a>
                                </div>
>>>>>>> 3cfff32 (fix: update Dockerfile build order and point docs to getting-started)
                            ) : (
                                <div className="lp-connect-fallback">
                                    <ConnectButton />
                                </div>
                            )}
<<<<<<< HEAD
=======

                            {/* Docs link - always visible */}
                            <a
                                href="https://docs-memwal-staging.up.railway.app/"
                                target="_blank"
                                rel="noopener noreferrer"
                                style={{
                                    color: 'var(--text-secondary)',
                                    fontSize: '0.85rem',
                                    textDecoration: 'none',
                                    marginTop: 8,
                                }}
                            >
                                documentation →
                            </a>
>>>>>>> 3cfff32 (fix: update Dockerfile build order and point docs to getting-started)
                        </div>

                        <div className="lp-illustration" aria-hidden="true">
                            <div className="lp-mega" />
                            <div className="lp-orbit lp-orbit-a" />
                            <div className="lp-orbit lp-orbit-b" />
                            <div className="lp-dot" />
                            <div className="lp-star">✦</div>
                        </div>
                    </section>

                    <section className="lp-services">
                        <div className="lp-grid">
                            <article className="lp-service-card">
                                <h3>encrypted storage</h3>
                                <p>SEAL encryption, persisted to Walrus blobs.</p>
                            </article>
                            <article className="lp-service-card lp-service-card--lime">
                                <h3>semantic recall</h3>
                                <p>embedding search for relevant memories in milliseconds.</p>
                            </article>
                            <article className="lp-service-card lp-service-card--lime">
                                <h3>delegate keys</h3>
                                <p>low-risk keys for apps, revocable anytime onchain.</p>
                            </article>
                            <article className="lp-service-card">
                                <h3>AI middleware</h3>
                                <p>wrap models with memory context using one SDK.</p>
                            </article>
                        </div>
                    </section>

                    <footer className="lp-footer">
<<<<<<< HEAD
=======
                        <a
                            href="https://docs-memwal-staging.up.railway.app/"
                            target="_blank"
                            rel="noopener noreferrer"
                            className="lp-footer-docs"
                        >
                            documentation →
                        </a>
>>>>>>> 3cfff32 (fix: update Dockerfile build order and point docs to getting-started)
                        <span>© 2026 CommandOSS Labs</span>
                    </footer>

                </div>
            </div>
        </>
    )
}
