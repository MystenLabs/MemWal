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

            <div className="hero">
                <div className="hero-badge">
                    privacy-preserving AI memory
                </div>

                <h1>
                    give your AI<br />
                    <span className="gradient">permanent memory</span>
                </h1>

                <p>
                    memwal stores your AI conversations on Walrus, encrypted with SEAL,
                    and searchable with embeddings. you own your data — always.
                </p>

                {/* Primary: Google zkLogin via Enoki */}
                {hasEnokiConfig && googleWallet ? (
                    <button
                        className="btn btn-google"
                        onClick={() => connect({ wallet: googleWallet })}
                    >
                        <svg width="20" height="20" viewBox="0 0 24 24">
                            <path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 0 1-2.2 3.32v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.1z" />
                            <path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" />
                            <path fill="#FBBC05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z" />
                            <path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" />
                        </svg>
                        sign in with Google
                    </button>
                ) : (
                    /* Fallback: standard dapp-kit ConnectButton for any Sui wallet */
                    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 12 }}>
                        <ConnectButton />
                    </div>
                )}

                <div className="hero-features">
                    <div className="hero-feature">
                        <div className="hero-feature-icon">encrypted</div>
                        <div className="hero-feature-desc">AES-256-GCM + SEAL</div>
                    </div>
                    <div className="hero-feature">
                        <div className="hero-feature-icon">decentralized</div>
                        <div className="hero-feature-desc">stored on Walrus</div>
                    </div>
                    <div className="hero-feature">
                        <div className="hero-feature-icon">semantic</div>
                        <div className="hero-feature-desc">embedding vectors</div>
                    </div>
                    <div className="hero-feature">
                        <div className="hero-feature-icon">owned</div>
                        <div className="hero-feature-desc">you own your data</div>
                    </div>
                </div>
            </div>
        </>
    )
}
