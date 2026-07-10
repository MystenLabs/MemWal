/**
 * OldMemoriesBanner (WALM-264 T3) — "You have N old memories — delete them".
 *
 * Rendered at the top of the Dashboard shell (below the navbar, above the
 * page header) so it's the first thing a user sees; links down to the
 * cleanup section on the same page. Shown once per browser (dismissal
 * persisted in localStorage) when the wallet owns deletable V1 Walrus
 * blobs; renders nothing while the feature flag is off or before the
 * count is known.
 */

import { useEffect, useState } from 'react'
import { useCurrentAccount, useSuiClient } from '@mysten/dapp-kit'
import { TriangleAlert } from 'lucide-react'
import { config } from '../config'
import { listOwnedWalrusBlobs } from '../utils/walrusBlobs'

const DISMISS_KEY = 'memwal_cleanup_banner_dismissed'

export default function OldMemoriesBanner() {
    const currentAccount = useCurrentAccount()
    const suiClient = useSuiClient()
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

    if (!config.enableMemoryDeletion || !address || dismissed || !count) {
        return null
    }

    return (
        <div className="dash-alert dash-alert--cleanup" role="status">
            <TriangleAlert className="dash-alert-icon" size={24} strokeWidth={2.3} aria-hidden="true" />
            <p>
                You have {count} old memor{count === 1 ? 'y' : 'ies'} stored on Walrus.{' '}
                <a
                    href="#cleanup"
                    onClick={(event) => {
                        event.preventDefault()
                        document.getElementById('cleanup')?.scrollIntoView({ behavior: 'smooth' })
                    }}
                >
                    Delete them
                </a>{' '}
                if you no longer want them — deletion is permanent.
            </p>
            <button
                type="button"
                className="btn btn-secondary btn-sm dash-alert-dismiss"
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
