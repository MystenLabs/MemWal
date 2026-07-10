/**
 * CleanupSection — permanent V1 memory deletion (WALM-264). Dashboard card
 * (id="cleanup"; the old-memories banner links here).
 *
 * One button deletes ALL deletable blobs — no per-blob picking. Blobs are
 * deleted in PTB batches of 950 (Sui's 1024-command cap minus headroom),
 * one wallet signature per batch. The user only signs: the app builds each
 * PTB, sponsors it via POST /sponsor (Enoki), then hands
 * {digest, signature, blobIds} to POST /api/delete-memories — the backend
 * submits on-chain and deletes the matching DB rows in the same call, so
 * chain and index never drift.
 *
 * Deletion is permanent: never recoverable, never migrated. The warning
 * and confirm dialog say so in plain words — per WALM-264 that messaging
 * is the one thing that must be right.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { useCurrentAccount, useSignTransaction, useSuiClient } from '@mysten/dapp-kit'
import { Transaction } from '@mysten/sui/transactions'
import { RefreshCw, Trash2 } from 'lucide-react'
import { config } from '../config'
import { useDelegateKey } from '../App'
import { apiCall } from '../utils/api'
import { sponsorTransactionKind } from '../utils/sponsor'
import { Card } from './Card'
import {
    getWalrusClient,
    invalidateWalrusBlobScan,
    listScopedDeletableBlobs,
    type OwnedWalrusBlob,
} from '../utils/walrusBlobs'
import { getAnalyticsErrorType, trackEvent } from '../utils/analytics'

/**
 * The binding limit is NOT Sui's 1024-command PTB cap but the relayer's
 * /sponsor gates: 7000 bytes of TransactionKind (sponsor.rs) under a 10 KiB
 * JSON body (main.rs). Each delete costs ~135 bytes of kind BCS, so ~50 is
 * the ceiling — 40 leaves headroom. (To test the multi-batch flow with a
 * small wallet, temporarily set this to 1.)
 */
const DELETE_BATCH_SIZE = 40

type Phase =
    | { kind: 'loading' }
    | { kind: 'ready' }
    | { kind: 'deleting'; batch: number; totalBatches: number }
    | { kind: 'done'; deletedBlobs: number; deletedRows: number }

export default function CleanupSection() {
    const currentAccount = useCurrentAccount()
    const suiClient = useSuiClient()
    const { mutateAsync: signTransaction } = useSignTransaction()
    const { delegateKey, accountObjectId } = useDelegateKey()

    const address = currentAccount?.address || ''

    const [blobs, setBlobs] = useState<OwnedWalrusBlob[]>([])
    const [scanned, setScanned] = useState(0)
    const [phase, setPhase] = useState<Phase>({ kind: 'loading' })
    const [error, setError] = useState('')
    const [confirming, setConfirming] = useState(false)

    const deletableBlobs = useMemo(() => blobs.filter((b) => b.deletable), [blobs])
    const permanentCount = blobs.length - deletableBlobs.length

    const loadBlobs = useCallback(async (force = false) => {
        if (!address) return
        setPhase({ kind: 'loading' })
        setScanned(0)
        setError('')
        try {
            // Scoped to the relayer DB's authoritative V1 memory list, so
            // unrelated/V2 blobs the wallet owns are never deleted from
            // here. Without a delegate-key session the list stays unscoped
            // and the UI shows the setup prompt instead of a count.
            const { blobs: scoped } = await listScopedDeletableBlobs(suiClient, address, {
                delegateKey,
                accountObjectId,
                onProgress: setScanned,
                force,
            })
            setBlobs(scoped)
            setPhase({ kind: 'ready' })
        } catch (err) {
            setError(err instanceof Error ? err.message : 'failed to list blobs')
            setPhase({ kind: 'ready' })
        }
    }, [address, suiClient, delegateKey, accountObjectId])

    useEffect(() => {
        void loadBlobs()
    }, [loadBlobs])

    // The old-memories banner links to /dashboard#cleanup — react-router
    // doesn't scroll to hashes, so do it once the section exists.
    useEffect(() => {
        if (window.location.hash === '#cleanup') {
            document.getElementById('cleanup')?.scrollIntoView({ behavior: 'smooth' })
        }
    }, [])

    const deleteInFlight = useRef(false)

    const executeDelete = useCallback(async () => {
        if (!address || !delegateKey || deletableBlobs.length === 0) return
        // Double-click guard: a second concurrent run would sponsor the same
        // objects twice and paint a spurious error over a successful delete.
        if (deleteInFlight.current) return
        deleteInFlight.current = true
        setConfirming(false)
        setError('')

        trackEvent('memory_delete_start', { blobs: deletableBlobs.length })

        const batches: OwnedWalrusBlob[][] = []
        for (let i = 0; i < deletableBlobs.length; i += DELETE_BATCH_SIZE) {
            batches.push(deletableBlobs.slice(i, i + DELETE_BATCH_SIZE))
        }

        let deletedBlobs = 0
        let deletedRows = 0
        try {
            const walrusClient = getWalrusClient(suiClient)
            for (let i = 0; i < batches.length; i++) {
                const batch = batches[i]
                setPhase({ kind: 'deleting', batch: i + 1, totalBatches: batches.length })

                // Each delete frees a Storage object; return them all to the
                // user in one final transfer.
                const tx = new Transaction()
                tx.setSender(address)
                const reclaimed = batch.map((blob) =>
                    tx.add(walrusClient.deleteBlob({ blobObjectId: blob.objectId })),
                )
                tx.transferObjects(reclaimed, address)

                const kindBytes = await tx.build({ client: suiClient, onlyTransactionKind: true })

                // Sponsor (Enoki) — gas is covered; the user only signs.
                const sponsored = await sponsorTransactionKind(kindBytes, address)

                const { signature } = await signTransaction({
                    transaction: Transaction.from(sponsored.bytes),
                })

                // The backend submits and deletes the DB rows together.
                const result = await apiCall(
                    delegateKey,
                    config.memwalServerUrl,
                    '/api/delete-memories',
                    {
                        digest: sponsored.digest,
                        signature,
                        blobIds: batch.map((b) => b.blobId),
                    },
                    accountObjectId ?? undefined,
                )

                deletedBlobs += batch.length
                deletedRows += result.deletedRows ?? 0
                // Drop the finished batch so a mid-run failure resumes with
                // only what's left.
                const done = new Set(batch.map((b) => b.objectId))
                setBlobs((prev) => prev.filter((b) => !done.has(b.objectId)))
            }
            setPhase({ kind: 'done', deletedBlobs, deletedRows })
            trackEvent('memory_delete_complete', { blobs: deletedBlobs })
            invalidateWalrusBlobScan(address)
        } catch (err) {
            // A failure can land AFTER the on-chain delete succeeded (e.g.
            // the row-delete call dropped) — re-scan so retry only sees
            // blobs that still exist, instead of rebuilding a PTB over
            // deleted objects and failing forever. Error is set after the
            // reload (loadBlobs clears it on start).
            trackEvent('memory_delete_failed', { error_type: getAnalyticsErrorType(err) })
            invalidateWalrusBlobScan(address)
            await loadBlobs(true)
            setError(
                `${err instanceof Error ? err.message : 'delete failed'} — the list was refreshed; retrying deletes only what remains.`,
            )
        } finally {
            deleteInFlight.current = false
        }
    }, [address, delegateKey, accountObjectId, deletableBlobs, suiClient, signTransaction, loadBlobs])

    const count = deletableBlobs.length
    const busy = phase.kind === 'deleting' || phase.kind === 'loading'

    return (
        <Card
            id="cleanup"
            className="dashboard-cleanup-card"
            title="Delete old memories"
            subtitle="Old memory blobs stored on Walrus by this wallet"
            action={
                <div className="card-header-actions">
                    <button
                        className="btn btn-secondary dashboard-keys-refresh"
                        onClick={() => void loadBlobs(true)}
                        disabled={busy}
                        aria-busy={phase.kind === 'loading'}
                    >
                        <RefreshCw size={16} /> Refresh
                    </button>
                    <button
                        className="btn btn-danger dashboard-cleanup-delete"
                        onClick={() => setConfirming(true)}
                        disabled={busy || count === 0 || !delegateKey}
                    >
                        <Trash2 size={16} /> Delete all{count > 0 ? ` ${count}` : ''} forever
                    </button>
                </div>
            }
        >
            <div className="dashboard-cleanup-warning">
                Deleting is <strong>permanent</strong>: a deleted memory is erased from Walrus and
                from your memory index. It can never be recovered, and it will never be migrated
                anywhere. Only delete your old memories if you are sure you no longer want them.
            </div>

            {error && (
                <div className="dashboard-cleanup-error" role="alert">
                    {error}
                </div>
            )}

            {phase.kind === 'loading' && (
                <p className="dashboard-cleanup-status">
                    Scanning your wallet for memory blobs...{scanned > 0 ? ` ${scanned} found` : ''}
                </p>
            )}

            {phase.kind === 'deleting' && (
                <p className="dashboard-cleanup-status" aria-live="polite">
                    Deleting batch {phase.batch} of {phase.totalBatches}... check your wallet for a
                    signature request.
                </p>
            )}

            {phase.kind === 'done' && (
                <p className="dashboard-cleanup-status" aria-live="polite">
                    Deleted {phase.deletedBlobs} memor{phase.deletedBlobs === 1 ? 'y' : 'ies'} on-chain
                    ({phase.deletedRows} index rows removed). This cannot be undone.
                </p>
            )}

            {phase.kind === 'ready' && (
                !delegateKey ? (
                    // Without the session the list can't be scoped to real
                    // memories, so a count here would be wrong — prompt for
                    // setup instead.
                    <p className="dashboard-cleanup-status">
                        A delegate key session is required to delete — <Link to="/setup">set one up</Link> first.
                    </p>
                ) : count === 0 ? (
                    <div className="dashboard-empty-message">
                        <span>No deletable memories found for this wallet.</span>
                    </div>
                ) : (
                    <p className="dashboard-cleanup-status">
                        You have <strong>{count}</strong> old memor{count === 1 ? 'y' : 'ies'} that can
                        be deleted
                        {permanentCount > 0 ? ` (${permanentCount} non-deletable blobs are not included)` : ''}.
                        {count > DELETE_BATCH_SIZE
                            ? ` Deletion runs in batches of ${DELETE_BATCH_SIZE} — you will sign ${Math.ceil(count / DELETE_BATCH_SIZE)} times.`
                            : count === 1
                                ? ' Deleting it takes one signature.'
                                : ' Deleting them all takes one signature.'}
                    </p>
                )
            )}

            {confirming && (
                <div
                    className="dashboard-confirm-backdrop"
                    onMouseDown={(event) => {
                        if (event.target === event.currentTarget) setConfirming(false)
                    }}
                >
                    <section
                        className="dashboard-confirm-dialog"
                        role="dialog"
                        aria-modal="true"
                        aria-labelledby="cleanup-confirm-title"
                        aria-describedby="cleanup-confirm-description"
                    >
                        <div className="dashboard-confirm-copy">
                            <h3 id="cleanup-confirm-title">
                                Permanently delete all {count} old memor{count === 1 ? 'y' : 'ies'}?
                            </h3>
                            <p id="cleanup-confirm-description">
                                This erases your old memories from Walrus and from your memory index,
                                forever. They cannot be recovered, restored, or migrated afterwards — by
                                anyone. There is no undo.
                            </p>
                        </div>
                        <div className="dashboard-confirm-actions">
                            <button
                                type="button"
                                className="btn btn-secondary dashboard-confirm-cancel"
                                onClick={() => setConfirming(false)}
                                autoFocus
                            >
                                Cancel
                            </button>
                            <button
                                type="button"
                                className="btn btn-danger dashboard-confirm-remove"
                                onClick={() => void executeDelete()}
                            >
                                Delete forever
                            </button>
                        </div>
                    </section>
                </div>
            )}
        </Card>
    )
}
