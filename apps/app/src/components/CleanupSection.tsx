/**
 * CleanupSection — permanent V1 memory deletion (WALM-264), rendered as a
 * Dashboard card (id="cleanup", the old-memories banner links here). Styled
 * to match the Delegate keys card (same Card shell + table classes).
 *
 * The user's ONLY action is signing: the card builds the
 * `system::delete_blob` PTB (batched), gets it Enoki-sponsored via
 * `POST /sponsor`, collects the wallet signature, then hands
 * `{ digest, signature, blobIds }` to `POST /api/delete-memories` — the
 * backend submits the transaction and deletes the matching DB rows in the
 * same call, so chain and DB never drift.
 *
 * Deletion is PERMANENT. A deleted memory is gone from Walrus, from the
 * relayer index, and can never be recovered or migrated. The confirm
 * dialog states this in plain words — per WALM-264 that messaging is the
 * one thing that must be right.
 */

import { useCallback, useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { useCurrentAccount, useSignTransaction, useSuiClient } from '@mysten/dapp-kit'
import { Transaction } from '@mysten/sui/transactions'
import { RefreshCw, Trash2 } from 'lucide-react'
import { config } from '../config'
import { useDelegateKey } from '../App'
import { apiCall } from '../utils/api'
import { Card } from './Card'
import { getWalrusClient, listOwnedWalrusBlobs, type OwnedWalrusBlob } from '../utils/walrusBlobs'
import { getAnalyticsErrorType, trackEvent } from '../utils/analytics'

/**
 * Sui PTB caps: 1024 commands / 2048 inputs / 128 KB. Each delete is one
 * command + one owned input, plus one final transferObjects — so ~1023 is
 * the hard ceiling; 950 leaves size + gas headroom.
 */
const DELETE_BATCH_SIZE = 950

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
    const [selected, setSelected] = useState<Set<string>>(new Set())
    const [scanned, setScanned] = useState(0)
    const [phase, setPhase] = useState<Phase>({ kind: 'loading' })
    const [error, setError] = useState('')
    const [confirming, setConfirming] = useState(false)

    const deletableBlobs = useMemo(() => blobs.filter((b) => b.deletable), [blobs])
    const permanentCount = blobs.length - deletableBlobs.length

    const loadBlobs = useCallback(async () => {
        if (!address) return
        setPhase({ kind: 'loading' })
        setError('')
        try {
            const owned = await listOwnedWalrusBlobs(suiClient, address, setScanned)

            // §5.2 — the relayer DB is the authoritative V1 memory list: only
            // offer blobs whose id is indexed there, so unrelated/V2 blobs the
            // wallet owns are never deletable from this UI. Requires the
            // delegate-key session (the endpoint is authenticated); without
            // one the list stays unscoped but the delete button is disabled
            // anyway.
            let scoped = owned
            if (delegateKey) {
                const res = await apiCall(
                    delegateKey,
                    config.memwalServerUrl,
                    '/api/memory-blob-ids',
                    {},
                    accountObjectId ?? undefined,
                )
                const known = new Set<string>(res.blobIds ?? [])
                scoped = owned.filter((b) => known.has(b.blobId))
            }

            setBlobs(scoped)
            setSelected(new Set(scoped.filter((b) => b.deletable).map((b) => b.objectId)))
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

    const toggle = useCallback((objectId: string) => {
        setSelected((prev) => {
            const next = new Set(prev)
            if (next.has(objectId)) next.delete(objectId)
            else next.add(objectId)
            return next
        })
    }, [])

    const executeDelete = useCallback(async () => {
        if (!address || !delegateKey) return
        setConfirming(false)
        setError('')

        const targets = deletableBlobs.filter((b) => selected.has(b.objectId))
        if (targets.length === 0) return

        trackEvent('memory_delete_start', { blobs: targets.length })

        const batches: OwnedWalrusBlob[][] = []
        for (let i = 0; i < targets.length; i += DELETE_BATCH_SIZE) {
            batches.push(targets.slice(i, i + DELETE_BATCH_SIZE))
        }

        let deletedBlobs = 0
        let deletedRows = 0
        try {
            const walrusClient = getWalrusClient(suiClient)
            for (let i = 0; i < batches.length; i++) {
                const batch = batches[i]
                setPhase({ kind: 'deleting', batch: i + 1, totalBatches: batches.length })

                // Build the delete PTB: each delete frees a Storage object,
                // returned to the user in one final transfer.
                const tx = new Transaction()
                tx.setSender(address)
                const reclaimed = batch.map((blob) =>
                    tx.add(walrusClient.deleteBlob({ blobObjectId: blob.objectId })),
                )
                tx.transferObjects(reclaimed, address)

                const kindBytes = await tx.build({ client: suiClient, onlyTransactionKind: true })

                // Sponsor (Enoki) — gas is covered; the user only signs.
                const sponsorRes = await fetch(`${config.memwalServerUrl}/sponsor`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        transactionBlockKindBytes: uint8ToBase64(kindBytes),
                        sender: address,
                    }),
                })
                if (!sponsorRes.ok) {
                    throw new Error(`Sponsor failed (${sponsorRes.status}): ${await sponsorRes.text()}`)
                }
                const sponsored = await sponsorRes.json()

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
                // Remove the finished batch so a mid-run failure resumes
                // with only what's left.
                const done = new Set(batch.map((b) => b.objectId))
                setBlobs((prev) => prev.filter((b) => !done.has(b.objectId)))
                setSelected((prev) => {
                    const next = new Set(prev)
                    for (const id of done) next.delete(id)
                    return next
                })
            }
            setPhase({ kind: 'done', deletedBlobs, deletedRows })
            trackEvent('memory_delete_complete', { blobs: deletedBlobs })
        } catch (err) {
            setError(err instanceof Error ? err.message : 'delete failed')
            setPhase({ kind: 'ready' })
            trackEvent('memory_delete_failed', { error_type: getAnalyticsErrorType(err) })
        }
    }, [address, delegateKey, accountObjectId, deletableBlobs, selected, suiClient, signTransaction])

    const selectedCount = selected.size
    const busy = phase.kind === 'deleting' || phase.kind === 'loading'
    const allSelected = deletableBlobs.length > 0 && selectedCount === deletableBlobs.length

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
                        onClick={() => void loadBlobs()}
                        disabled={busy}
                        aria-busy={phase.kind === 'loading'}
                    >
                        <RefreshCw size={16} /> Refresh
                    </button>
                    <button
                        className="btn btn-danger dashboard-cleanup-delete"
                        onClick={() => setConfirming(true)}
                        disabled={busy || selectedCount === 0 || !delegateKey}
                    >
                        <Trash2 size={16} /> Delete {selectedCount} forever
                    </button>
                </div>
            }
        >
            <div className="dashboard-cleanup-warning">
                Deleting is <strong>permanent</strong>: a deleted memory is erased from Walrus and
                from your memory index. It can never be recovered, and it will never be migrated
                anywhere. Only delete memories you are sure you no longer want.
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

            {phase.kind !== 'loading' && deletableBlobs.length === 0 ? (
                phase.kind !== 'done' && (
                    <div className="dashboard-empty-message">
                        <span>No deletable memories found for this wallet.</span>
                    </div>
                )
            ) : phase.kind !== 'loading' && (
                <>
                    <p className="dashboard-cleanup-status">
                        {deletableBlobs.length} deletable memor{deletableBlobs.length === 1 ? 'y' : 'ies'} found
                        {permanentCount > 0 ? ` (${permanentCount} non-deletable blobs not shown)` : ''}.
                        {' '}Deletion runs in batches of {DELETE_BATCH_SIZE} — one signature per batch.
                    </p>

                    <div className="dashboard-key-table-wrap">
                        <table className="dashboard-key-table">
                            <thead>
                                <tr>
                                    <th scope="col" className="dashboard-key-table-select">
                                        <label className="dashboard-key-checkbox" aria-label="Select all">
                                            <input
                                                type="checkbox"
                                                checked={allSelected}
                                                onChange={() =>
                                                    setSelected(
                                                        allSelected
                                                            ? new Set()
                                                            : new Set(deletableBlobs.map((b) => b.objectId)),
                                                    )
                                                }
                                                disabled={busy}
                                            />
                                            <span className="dashboard-key-checkbox-box" aria-hidden="true" />
                                        </label>
                                    </th>
                                    <th scope="col">Blob ID</th>
                                    <th scope="col">Object ID</th>
                                </tr>
                            </thead>
                            <tbody>
                                {deletableBlobs.map((blob) => {
                                    const isSelected = selected.has(blob.objectId)
                                    return (
                                        <tr
                                            key={blob.objectId}
                                            className={`dashboard-key-row${isSelected ? ' dashboard-key-row--selected' : ''}`}
                                        >
                                            <td data-label="Select" className="dashboard-key-cell-select">
                                                <label className="dashboard-key-checkbox" aria-label={`Select blob ${blob.blobId.slice(0, 8)}`}>
                                                    <input
                                                        type="checkbox"
                                                        checked={isSelected}
                                                        onChange={() => toggle(blob.objectId)}
                                                        disabled={busy}
                                                    />
                                                    <span className="dashboard-key-checkbox-box" aria-hidden="true" />
                                                </label>
                                            </td>
                                            <td data-label="Blob ID">
                                                <code className="dashboard-key-public" title={blob.blobId}>
                                                    {blob.blobId.slice(0, 10)}...{blob.blobId.slice(-6)}
                                                </code>
                                            </td>
                                            <td data-label="Object ID">
                                                <code className="dashboard-key-public" title={blob.objectId}>
                                                    {blob.objectId.slice(0, 8)}...{blob.objectId.slice(-6)}
                                                </code>
                                            </td>
                                        </tr>
                                    )
                                })}
                            </tbody>
                        </table>
                    </div>

                    {!delegateKey && (
                        <p className="dashboard-cleanup-status">
                            A delegate key session is required to delete — <Link to="/setup">set one up</Link> first.
                        </p>
                    )}
                </>
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
                                Permanently delete {selectedCount} memor{selectedCount === 1 ? 'y' : 'ies'}?
                            </h3>
                            <p id="cleanup-confirm-description">
                                This erases the selected memories from Walrus and from your memory index,
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

function uint8ToBase64(bytes: Uint8Array): string {
    let binary = ''
    for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i])
    return btoa(binary)
}
