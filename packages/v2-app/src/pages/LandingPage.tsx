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
            <nav className="nav">
                <div className="nav-inner">
                    <div className="nav-brand">
                        <span>memwal</span>
                    </div>
                </div>
            </nav>

            <div className="lp-bg">
                <div className="lp-sheet">
                    <section className="lp-hero">
                        <div className="lp-copy">
                            <div className="lp-kicker">privacy-preserving AI memory</div>
                            <h1>
                                Give your AI permanent memory
                            </h1>
                            <p>
                                Store memories on Walrus, encrypt with SEAL, and recall with semantic search.
                                MemWal gives agents long-term context while users keep ownership.
                            </p>

                            {hasEnokiConfig && googleWallet ? (
                                <button
                                    className="btn lp-btn-main"
                                    onClick={() => connect({ wallet: googleWallet })}
                                >
                                    sign in with Google
                                </button>
                            ) : (
                                <div className="lp-connect-fallback">
                                    <ConnectButton />
                                </div>
                            )}
                        </div>

                        <div className="lp-illustration" aria-hidden="true">
                            <div className="lp-mega" />
                            <div className="lp-orbit lp-orbit-a" />
                            <div className="lp-orbit lp-orbit-b" />
                            <div className="lp-dot" />
                            <div className="lp-star">✦</div>
                        </div>
                    </section>

                    <div className="lp-trust">
                        <span>walrus</span>
                        <span>seal</span>
                        <span>sui</span>
                        <span>enoki</span>
                        <span>memwal sdk</span>
                    </div>

                    <section className="lp-services">
                        <div className="lp-grid">
                            <article className="lp-service-card">
                                <h3>Encrypted storage</h3>
                                <p>SEAL encryption, persisted to Walrus blobs.</p>
                            </article>
                            <article className="lp-service-card lp-service-card--lime">
                                <h3>Semantic recall</h3>
                                <p>Embedding search for relevant memories in milliseconds.</p>
                            </article>
                            <article className="lp-service-card lp-service-card--lime">
                                <h3>Delegate keys</h3>
                                <p>Low-risk keys for apps, revocable anytime onchain.</p>
                            </article>
                            <article className="lp-service-card">
                                <h3>AI middleware</h3>
                                <p>Wrap models with memory context using one SDK.</p>
                            </article>
                        </div>
                    </section>

                </div>
            </div>
        </>
    )
}
