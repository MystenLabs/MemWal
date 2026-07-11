/**
 * OldMemoriesBanner (WALM-264 T3) — "You have N old memories — delete them".
 *
 * Currently NOT mounted anywhere — rollout deferred by product until further
 * notice. To re-enable, mount twice with exactly one instance visible at a
 * time:
 *  - AppContent (per the T3 spec: once, inside `.app`) — every page EXCEPT
 *    the dashboard: `{pathname.replace(/\/+$/, '') !== '/dashboard' && <OldMemoriesBanner />}`;
 *  - Dashboard's shell — below the navbar, above the "Welcome" header
 *    (`.dash-alert--cleanup` order), linking down to the cleanup section.
 *
 * The count is the relayer-scoped deletable set (shared cached scan with
 * CleanupSection — no duplicate chain walk), so it never inflates with V2
 * or unrelated blobs. No delegate-key session needed (plan T1). Dismissal
 * persists per wallet in localStorage. "Delete them" navigates to
 * /dashboard#cleanup (CleanupSection scrolls to the hash on mount) or
 * smooth-scrolls when already on the dashboard.
 */

import { useEffect, useState } from 'react'
import { Link, useLocation } from 'react-router-dom'
import { useCurrentAccount, useSuiClient } from '@mysten/dapp-kit'
import { TriangleAlert } from 'lucide-react'
import { config } from '../config'
import { listScopedDeletableBlobs } from '../utils/walrusBlobs'

const DISMISS_KEY_PREFIX = 'memwal_cleanup_banner_dismissed'

function isDismissed(address: string): boolean {
    return (
        localStorage.getItem(`${DISMISS_KEY_PREFIX}:${address}`) === 'true' ||
        // Legacy global key from the first release of the banner.
        localStorage.getItem(DISMISS_KEY_PREFIX) === 'true'
    )
}

export default function OldMemoriesBanner() {
    const currentAccount = useCurrentAccount()
    const suiClient = useSuiClient()
    const location = useLocation()
    const address = currentAccount?.address || ''

    const [count, setCount] = useState<number | null>(null)
    const [dismissed, setDismissed] = useState(() => (address ? isDismissed(address) : false))

    useEffect(() => {
        setDismissed(address ? isDismissed(address) : false)
    }, [address])

    useEffect(() => {
        if (!config.enableMemoryDeletion || !address || dismissed) return
        let cancelled = false
        listScopedDeletableBlobs(suiClient, address)
            .then((blobs) => {
                if (!cancelled) setCount(blobs.filter((b) => b.deletable).length)
            })
            .catch(() => {
                // Banner is best-effort — a failed count just means no banner.
            })
        return () => {
            cancelled = true
        }
    }, [address, suiClient, dismissed])

    if (!config.enableMemoryDeletion || !address || dismissed || !count) {
        return null
    }

    return (
        <div className="dash-alert dash-alert--cleanup" role="status">
            <TriangleAlert className="dash-alert-icon" size={24} strokeWidth={2.3} aria-hidden="true" />
            <p>
                You have {count} old memor{count === 1 ? 'y' : 'ies'} stored on Walrus.{' '}
                <Link
                    to="/dashboard#cleanup"
                    onClick={(event) => {
                        if (location.pathname.replace(/\/+$/, '') === '/dashboard') {
                            event.preventDefault()
                            document.getElementById('cleanup')?.scrollIntoView({ behavior: 'smooth' })
                        }
                    }}
                >
                    Delete them
                </Link>{' '}
                if you no longer want them — deletion is permanent.
            </p>
            <button
                type="button"
                className="btn btn-secondary btn-sm dash-alert-dismiss"
                onClick={() => {
                    localStorage.setItem(`${DISMISS_KEY_PREFIX}:${address}`, 'true')
                    setDismissed(true)
                }}
                aria-label="Dismiss"
            >
                Dismiss
            </button>
        </div>
    )
}
