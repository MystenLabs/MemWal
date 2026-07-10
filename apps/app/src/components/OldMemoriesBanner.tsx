/**
 * OldMemoriesBanner (WALM-264 T3) — "You have N old memories — delete them".
 *
 * Shown once per connected wallet (dismissal persisted in localStorage)
 * when the wallet owns deletable V1 Walrus blobs. Links to the Dashboard cleanup section.
 * Mounted in AppContent; renders nothing while the feature flag is off,
 * on the dashboard (the section is already visible there), or before the count is known.
 */

import { useEffect, useState } from 'react'
import { Link, useLocation } from 'react-router-dom'
import { useCurrentAccount, useSuiClient } from '@mysten/dapp-kit'
import { config } from '../config'
import { listOwnedWalrusBlobs } from '../utils/walrusBlobs'

const DISMISS_KEY = 'memwal_cleanup_banner_dismissed'

export default function OldMemoriesBanner() {
    const currentAccount = useCurrentAccount()
    const suiClient = useSuiClient()
    const location = useLocation()
    const address = currentAccount?.address || ''

    const [count, setCount] = useState<number | null>(null)
    const [dismissed, setDismissed] = useState(
        () => localStorage.getItem(DISMISS_KEY) === 'true',
    )

    useEffect(() => {
        if (!config.enableMemoryDeletion || !address || dismissed) return
        let cancelled = false
        listOwnedWalrusBlobs(suiClient, address)
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

    if (
        !config.enableMemoryDeletion ||
        !address ||
        dismissed ||
        !count ||
        location.pathname === '/dashboard'
    ) {
        return null
    }

    return (
        <div className="dash-alert" role="status">
            <p>
                You have {count} old memor{count === 1 ? 'y' : 'ies'} stored on Walrus.{' '}
                <Link to="/dashboard#cleanup">Delete them</Link> if you no longer want them — deletion is
                permanent.
            </p>
            <button
                type="button"
                className="btn btn-secondary"
                onClick={() => {
                    localStorage.setItem(DISMISS_KEY, 'true')
                    setDismissed(true)
                }}
                aria-label="Dismiss"
            >
                Dismiss
            </button>
        </div>
    )
}
