/**
 * Keys — deep-link entry point for the delegate keys view (WALM-675).
 *
 * Console's "Connected agents" panel opens this page with:
 *
 *   /keys?owner=<linked-owner-address>
 *
 * Flow:
 *   1. If signed out, persist `owner` across the Enoki sign-in redirect the
 *      same way /connect/mcp and /connect/claude do (WALM-86) — Enoki's
 *      redirect_uri is pinned to the app root, so any query string here
 *      would otherwise be dropped. App.tsx's PostAuthRedirect restores it.
 *   2. Once signed in, compare the signed-in wallet to `owner` and warn on
 *      mismatch. `owner` is only ever used for this comparison — it never
 *      selects an account or authorizes anything.
 *   3. Render the existing Dashboard delegate-keys card (mint/rotate/revoke),
 *      auto-scrolled into view — unless there's a mismatch, so the warning
 *      banner stays in view instead of being scrolled past. Dashboard's own
 *      nav carries "Back to Console" (config.consoleUrl, never a URL param —
 *      the WALM-288 class of bug — see Dashboard.tsx), so /dashboard gets it
 *      too, matching the 23 Sep decision that /setup ends there.
 */
import { useEffect, useRef, useState } from 'react'
import {
    ConnectModal,
    useAutoConnectWallet,
    useCurrentAccount,
    useDisconnectWallet,
} from '@mysten/dapp-kit'
import { Link, useSearchParams } from 'react-router-dom'
import { TriangleAlert } from 'lucide-react'
import { useDelegateKey } from '../App'
import Dashboard from './Dashboard'
import { trackEvent } from '../utils/analytics'

const WALRUS_MEMORY_LOGO = '/walrus-memory-logo.svg'

/** sessionStorage key holding an in-flight /keys request, so `owner` survives
 *  the Google OAuth redirect. Shared with App.tsx (kept as a literal there
 *  to avoid a circular import — same convention as the mcp/claude keys). */
const KEYS_CONNECT_STORAGE_KEY = 'memwal_keys_connect'

export default function KeysPage() {
    const [searchParams] = useSearchParams()
    const owner = searchParams.get('owner')

    const currentAccount = useCurrentAccount()
    const autoConnectStatus = useAutoConnectWallet()
    const authPending = autoConnectStatus === 'idle'
    const { clearDelegateKeys } = useDelegateKey()
    const { mutateAsync: disconnect } = useDisconnectWallet()
    const [walletPickerOpen, setWalletPickerOpen] = useState(false)

    useEffect(() => {
        if (!owner) return
        sessionStorage.setItem(KEYS_CONNECT_STORAGE_KEY, JSON.stringify({ owner }))
    }, [owner])

    const mismatch = Boolean(
        owner && currentAccount && owner.toLowerCase() !== currentAccount.address.toLowerCase(),
    )
    const mismatchTrackedRef = useRef(false)
    useEffect(() => {
        if (!mismatch || mismatchTrackedRef.current) return
        mismatchTrackedRef.current = true
        trackEvent('owner_param_mismatch', { location: 'keys' })
    }, [mismatch])

    const handleSignOut = async () => {
        trackEvent('sign_out', { location: 'keys' })
        clearDelegateKeys()
        await disconnect()
    }

    if (authPending) {
        return (
            <div className="wm-route-pending" role="status" aria-label="Restoring wallet session">
                <img src={WALRUS_MEMORY_LOGO} alt="Walrus Memory" />
            </div>
        )
    }

    if (!currentAccount) {
        return (
            <div className="setup-classic">
                <nav className="nav setup-classic-nav">
                    <div className="nav-inner">
                        <Link to="/" className="nav-brand">
                            <img className="nav-brand-logo" src={WALRUS_MEMORY_LOGO} alt="Walrus Memory" />
                        </Link>
                    </div>
                </nav>

                <main className="container setup-classic-container">
                    <div className="setup-classic-panel">
                        <div className="setup-classic-intro">
                            <h2 className="setup-classic-title">Sign in to manage delegate keys</h2>
                            <p className="setup-classic-description">
                                Connect the Sui wallet linked to your Walrus Memory account to mint or revoke delegate keys.
                            </p>
                            <div className="setup-classic-actions">
                                <button type="button" className="lp-btn-yellow" onClick={() => setWalletPickerOpen(true)}>
                                    Connect Sui wallet
                                </button>
                            </div>
                        </div>
                    </div>
                </main>

                <ConnectModal trigger={<></>} open={walletPickerOpen} onOpenChange={setWalletPickerOpen} />
            </div>
        )
    }

    return (
        <>
            {mismatch && (
                <div className="keys-mismatch-alert" role="alert">
                    <TriangleAlert className="keys-mismatch-alert-icon" size={24} strokeWidth={2.3} aria-hidden="true" />
                    <div>
                        <p>
                            <strong>Signed in as a different account.</strong>
                        </p>
                        <p>
                            Console expects <code>{owner}</code>, but you're signed in as{' '}
                            <code>{currentAccount.address}</code>.{' '}
                            <button type="button" className="keys-mismatch-alert-signout" onClick={handleSignOut}>
                                Sign out
                            </button>{' '}
                            and sign in as the expected account to manage its keys.
                        </p>
                    </div>
                </div>
            )}

            <Dashboard autoScrollToKeys={!mismatch} />
        </>
    )
}
