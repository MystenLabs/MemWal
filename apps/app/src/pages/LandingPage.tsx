/**
 * Sign-in page (memwal.ai root). Two options:
 *
 * 1. Continue with Google (Enoki)
 * 2. Connect wallet (any Sui wallet)
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
import { useRef, useEffect, useCallback } from 'react'
import { useNavigate } from 'react-router-dom'
import { config } from '../config'
import { trackEvent } from '../utils/analytics'

type AuthMethod = 'enoki' | 'wallet' | null

const AUTH_METHOD_KEY = 'memwal_auth_method'
const MARKETING_ASSET_VERSION = 'walm61-20260529c'
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

const signinLogos = [
    { label: 'Allium', src: marketingAsset('/walrus-trust-allium.png'), w: 143 },
    { label: 'inflectiv', src: marketingAsset('/walrus-trust-inflectiv.svg'), w: 162 },
    { label: 'OpenGradient', src: marketingAsset('/walrus-trust-opengradient.svg'), w: 191 },
    { label: 'TALUS', src: marketingAsset('/walrus-trust-talus.svg'), w: 117 },
    { label: 'TATUM', src: marketingAsset('/walrus-trust-tatum.svg'), w: 128 },
    { label: 'CONSO', src: marketingAsset('/walrus-trust-conso.png'), w: 136 },
]

export default function LandingPage() {
    const currentAccount = useCurrentAccount()
    const { mutate: connect } = useConnectWallet()
    const wallets = useWallets()
    const enokiWallets = wallets.filter(isEnokiWallet)

    const walletsByProvider = enokiWallets.reduce(
        (map, wallet) => map.set(wallet.provider, wallet),
        new Map<AuthProvider, EnokiWallet>(),
    )
    const googleWallet = walletsByProvider.get('google')

    const navigate = useNavigate()
    const hasEnokiConfig = !!(config.enokiApiKey && config.googleClientId)

    const walletClickedRef = useRef(false)
    const signInTrackedRef = useRef(false)

    const updateAuthMethod = useCallback((method: AuthMethod) => {
        persistAuthMethod(method)
    }, [])

    useEffect(() => {
        if (currentAccount) {
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
    }, [currentAccount, updateAuthMethod, navigate])

    const handleEnokiConnect = () => {
        if (!googleWallet) return
        updateAuthMethod('enoki')
        trackEvent('sign_in_start', { auth_method: 'enoki', location: 'sign_in' })
        connect({ wallet: googleWallet })
    }

    const handleWalletClick = () => {
        walletClickedRef.current = true
        updateAuthMethod('wallet')
        trackEvent('sign_in_start', { auth_method: 'wallet', location: 'sign_in' })
    }

    return (
        <div className="wm-page">
        <div className="wm-signin wm-signin--page" role="main" aria-label="Sign in">
            <img className="wm-signin-aurora" src={marketingAsset('/walrus-signin-bg.png')} alt="" aria-hidden="true" />
            <div className="wm-signin-inner">
                <div className="wm-signin-card">
                    <img className="wm-signin-logo" src={marketingAsset('/walrus-memory-logo.svg')} alt="Walrus Memory" />
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
        </div>
    )
}
