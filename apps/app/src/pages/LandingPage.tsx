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
                                <div className="lp-cta-row">
                                    <button
                                        className="btn lp-btn-main"
                                        onClick={() => connect({ wallet: googleWallet })}
                                    >
                                        playground
                                    </button>
                                    <button
                                        className="btn lp-btn-main"
                                        onClick={() => window.open(config.docsUrl, '_blank', 'noopener,noreferrer')}
                                    >
                                        view docs
                                    </button>
                                </div>
                            ) : (
                                <div className="lp-cta-row">
                                    <ConnectButton connectText="playground" />
                                    <button
                                        className="btn lp-btn-main"
                                        onClick={() => window.open(config.docsUrl, '_blank', 'noopener,noreferrer')}
                                    >
                                        view docs
                                    </button>
                                </div>
                            )}

                        </div>

                        <div className="lp-illustration" aria-hidden="true" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                            <svg width="180" height="144" viewBox="0 0 374 300" fill="none" xmlns="http://www.w3.org/2000/svg" style={{ opacity: 0.9 }}>
                                <path d="M49.8667 100H0V300H49.8667V100Z" fill="black" />
                                <path d="M112.2 0H49.8667V100H112.2V0Z" fill="black" />
                                <path d="M187 100H112.2V300H187V100Z" fill="black" />
                                <path d="M274.267 0H187V100H274.267V0Z" fill="black" />
                                <path d="M374 100H274.267V300H374V100Z" fill="black" />
                            </svg>
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


                </div>
            </div>
        </>
    )
}
