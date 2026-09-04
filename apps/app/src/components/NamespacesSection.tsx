import { useCallback, useEffect, useMemo, useState } from 'react'
import {
    useCurrentAccount,
    useSignPersonalMessage,
    useSuiClient,
} from '@mysten/dapp-kit'
import { Copy, Plus, RefreshCw } from 'lucide-react'
import { isValidSuiAddress, normalizeSuiAddress } from '@mysten/sui/utils'
import { useDelegateKey } from '../App'
import { Card } from './Card'
import { config } from '../config'
import { useSponsoredTransaction } from '../hooks/useSponsoredTransaction'
import { useV2Namespaces } from '../hooks/useV2Namespaces'
import {
    cancelV2UninitializedNamespace,
    compactObjectId,
    createV2Namespace,
    generateAndWrapNamespaceDek,
    grantBitsFromCheckboxes,
    grantV2NamespaceAccess,
    initializeV2NamespaceKey,
    isCurrentAccountDelegate,
    lookupNamespacePermissions,
    NAMESPACE_LABEL_MAX_LENGTH,
    normalizeLabelForSubmit,
    principalsToGrant,
    readV2NamespaceRow,
    sanitizeLabelInput,
    sharePrincipalBlockedReason,
    suiAddressFromEd25519PublicKeyHex,
    validateGrantBits,
    validateNamespaceLabel,
    v2ConfigReady,
    type GrantBits,
    type WalletSignerLike,
} from '../utils/v2Namespace'

type SessionGrant = GrantBits & { principal: string; namespaceId: string }

export default function NamespacesSection({ previewMode = false }: { previewMode?: boolean }) {
    const currentAccount = useCurrentAccount()
    const suiClient = useSuiClient()
    const { mutateAsync: signAndExecuteTx } = useSponsoredTransaction()
    const { mutateAsync: signPersonalMsg } = useSignPersonalMessage()
    const { delegatePublicKey } = useDelegateKey()
    const owner = previewMode ? '' : (currentAccount?.address || '')
    const {
        namespaces,
        v2AccountId,
        delegateAddresses,
        loading,
        error,
        refresh,
        upsertNamespace,
        removeNamespace,
    } = useV2Namespaces(owner)

    const [showCreate, setShowCreate] = useState(false)
    const [newLabel, setNewLabel] = useState('memories')
    const [creating, setCreating] = useState(false)
    const [createPhase, setCreatePhase] = useState('')
    const [createError, setCreateError] = useState('')
    const [selectedId, setSelectedId] = useState<string | null>(null)
    const [sharePrincipal, setSharePrincipal] = useState('')
    const [shareRead, setShareRead] = useState(true)
    const [shareWrite, setShareWrite] = useState(false)
    const [shareShare, setShareShare] = useState(false)
    const [sharing, setSharing] = useState(false)
    const [shareError, setShareError] = useState('')
    const [lookupPrincipal, setLookupPrincipal] = useState('')
    const [lookupResult, setLookupResult] = useState<GrantBits | null>(null)
    const [lookupError, setLookupError] = useState('')
    const [lookingUp, setLookingUp] = useState(false)
    const [finishing, setFinishing] = useState(false)
    const [cancelling, setCancelling] = useState(false)
    const [sessionGrants, setSessionGrants] = useState<SessionGrant[]>([])
    const [copied, setCopied] = useState<string | null>(null)

    const walletSigner = useMemo<WalletSignerLike | null>(() => {
        if (!currentAccount) return null
        return {
            address: currentAccount.address,
            signAndExecuteTransaction: ({ transaction }) => signAndExecuteTx({ transaction }),
            signPersonalMessage: ({ message }) => signPersonalMsg({ message }),
        }
    }, [currentAccount, signAndExecuteTx, signPersonalMsg])

    const selected = namespaces.find((row) => row.id === selectedId) ?? namespaces[0] ?? null
    const shareAllowed = isCurrentAccountDelegate(sharePrincipal, delegateAddresses)
    const shareBlocked = sharePrincipalBlockedReason(sharePrincipal, owner)
    const shareBits = grantBitsFromCheckboxes({
        read: shareRead,
        write: shareWrite,
        share: shareShare && shareAllowed,
    })
    const lifecycleBusy = creating || finishing || cancelling

    useEffect(() => {
        if (!selectedId && namespaces[0]) setSelectedId(namespaces[0].id)
        if (selectedId && !namespaces.some((row) => row.id === selectedId) && namespaces[0]) {
            setSelectedId(namespaces[0].id)
        }
    }, [namespaces, selectedId])

    const copyId = useCallback(async (id: string) => {
        await navigator.clipboard.writeText(id)
        setCopied(id)
        window.setTimeout(() => setCopied(null), 2000)
    }, [])

    const grantWritersAndDelegate = useCallback(async (
        namespaceId: string,
        setPhase: (next: string) => void,
    ) => {
        if (!walletSigner || !v2AccountId || !owner) return
        let delegateAddress: string | null = null
        if (delegatePublicKey) {
            try {
                delegateAddress = suiAddressFromEd25519PublicKeyHex(delegatePublicKey)
            } catch {
                delegateAddress = null
            }
        }
        const principals = principalsToGrant(config.v2WriterAddresses, delegateAddress, owner)
        for (const [index, principal] of principals.entries()) {
            setPhase(`Granting read/write (${index + 1}/${principals.length})`)
            const bits: GrantBits = { canRead: true, canWrite: true, canShare: false }
            await grantV2NamespaceAccess({
                suiClient,
                walletSigner,
                accountId: v2AccountId,
                namespaceId,
                principal,
                bits,
            })
            setSessionGrants((prev) => [...prev, { principal, namespaceId, ...bits }])
        }
    }, [walletSigner, v2AccountId, owner, delegatePublicKey, suiClient])

    const initializeAndGrant = useCallback(async (
        namespaceId: string,
        setPhase: (next: string) => void,
    ) => {
        if (!walletSigner || !v2AccountId) return
        setPhase('Wrapping namespace key')
        const wrappedDek = await generateAndWrapNamespaceDek({
            suiClient,
            namespaceId,
        })
        setPhase('Initializing key')
        await initializeV2NamespaceKey({
            suiClient,
            walletSigner,
            accountId: v2AccountId,
            namespaceId,
            wrappedDek,
        })
        await grantWritersAndDelegate(namespaceId, setPhase)
        const live = await readV2NamespaceRow(suiClient, namespaceId, owner)
        if (live) {
            upsertNamespace(live)
            return
        }
        upsertNamespace({
            id: namespaceId,
            label: '',
            active: true,
            keyVersion: 0,
            keyInitialized: true,
            destroyed: false,
            owner,
            accountId: v2AccountId,
        })
    }, [
        walletSigner,
        v2AccountId,
        suiClient,
        grantWritersAndDelegate,
        owner,
        upsertNamespace,
    ])

    const handleCreate = useCallback(async () => {
        if (!walletSigner || !owner) return
        if (!v2ConfigReady()) {
            setCreateError('V2 package IDs are not configured')
            return
        }
        if (!v2AccountId) {
            setCreateError('No V2 Walrus Memory account found for this wallet')
            return
        }
        const label = normalizeLabelForSubmit(newLabel)
        const invalid = validateNamespaceLabel(label)
        if (invalid) {
            setCreateError(invalid)
            return
        }

        setCreating(true)
        setCreateError('')
        let phase = ''
        const setPhase = (next: string) => {
            phase = next
            setCreatePhase(next)
        }
        try {
            setPhase('Creating namespace')
            const created = await createV2Namespace({
                suiClient,
                walletSigner,
                accountId: v2AccountId,
                label,
            })
            const createdRow = await readV2NamespaceRow(suiClient, created.namespaceId, owner)
            upsertNamespace(createdRow ?? {
                id: created.namespaceId,
                label,
                active: false,
                keyVersion: 0,
                keyInitialized: false,
                destroyed: false,
                owner,
                accountId: v2AccountId,
            })
            setSelectedId(created.namespaceId)

            await initializeAndGrant(created.namespaceId, setPhase)

            setShowCreate(false)
            setNewLabel('memories')
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err)
            setCreateError(phase ? `${phase} failed: ${message}` : message)
        } finally {
            setCreatePhase('')
            setCreating(false)
            await refresh()
        }
    }, [
        walletSigner,
        owner,
        v2AccountId,
        newLabel,
        suiClient,
        upsertNamespace,
        initializeAndGrant,
        refresh,
    ])

    const handleFinishInitialize = useCallback(async () => {
        if (!walletSigner || !selected || selected.keyInitialized || !v2AccountId) return
        setFinishing(true)
        setCreateError('')
        let phase = ''
        const setPhase = (next: string) => {
            phase = next
            setCreatePhase(next)
        }
        try {
            await initializeAndGrant(selected.id, setPhase)
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err)
            setCreateError(phase ? `${phase} failed: ${message}` : message)
        } finally {
            setCreatePhase('')
            setFinishing(false)
            await refresh()
        }
    }, [walletSigner, selected, v2AccountId, initializeAndGrant, refresh])

    const handleCancelReservation = useCallback(async () => {
        if (!walletSigner || !selected || selected.keyInitialized || !v2AccountId) return
        setCancelling(true)
        setCreateError('')
        setCreatePhase('Cancelling reservation')
        try {
            await cancelV2UninitializedNamespace({
                suiClient,
                walletSigner,
                accountId: v2AccountId,
                namespaceId: selected.id,
            })
            removeNamespace(selected.id)
            setSelectedId(null)
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err)
            setCreateError(`Cancelling reservation failed: ${message}`)
        } finally {
            setCreatePhase('')
            setCancelling(false)
            await refresh()
        }
    }, [walletSigner, selected, v2AccountId, suiClient, removeNamespace, refresh])

    const handleShare = useCallback(async () => {
        if (!walletSigner || !selected || !v2AccountId) return
        const blocked = sharePrincipalBlockedReason(sharePrincipal, owner)
        if (blocked) {
            setShareError(blocked)
            return
        }
        if (!isValidSuiAddress(sharePrincipal)) {
            setShareError('Enter a valid Sui address')
            return
        }
        const bits = shareBits
        const invalid = validateGrantBits(bits)
        if (invalid) {
            setShareError(invalid)
            return
        }
        if (bits.canShare && !shareAllowed) {
            setShareError('Share is limited to current account delegates.')
            return
        }
        setSharing(true)
        setShareError('')
        try {
            await grantV2NamespaceAccess({
                suiClient,
                walletSigner,
                accountId: v2AccountId,
                namespaceId: selected.id,
                principal: sharePrincipal,
                bits,
            })
            setSessionGrants((prev) => [
                ...prev,
                { principal: normalizeSuiAddress(sharePrincipal), namespaceId: selected.id, ...bits },
            ])
            setSharePrincipal('')
            setShareWrite(false)
            setShareShare(false)
            setShareRead(true)
        } catch (err) {
            setShareError(err instanceof Error ? err.message : String(err))
        } finally {
            setSharing(false)
        }
    }, [walletSigner, selected, v2AccountId, sharePrincipal, shareBits, shareAllowed, suiClient])

    const handleLookup = useCallback(async () => {
        if (!selected || !owner) return
        if (!isValidSuiAddress(lookupPrincipal)) {
            setLookupError('Enter a valid Sui address')
            setLookupResult(null)
            return
        }
        setLookingUp(true)
        setLookupError('')
        setLookupResult(null)
        try {
            const bits = await lookupNamespacePermissions(
                suiClient,
                selected.id,
                lookupPrincipal,
                owner,
            )
            setLookupResult(bits)
        } catch (err) {
            setLookupError(err instanceof Error ? err.message : String(err))
        } finally {
            setLookingUp(false)
        }
    }, [selected, owner, lookupPrincipal, suiClient])

    if (!config.v2NamespacesEnabled) return null

    const listBusy = loading && namespaces.length === 0
    const selectedSessionGrants = sessionGrants.filter((grant) => grant.namespaceId === selected?.id)

    return (
        <Card
            className="dashboard-keys-card"
            title="Namespaces"
            subtitle="V2 namespaces owned by this wallet. Relayer remember/recall use the label."
            action={
                <div className="card-header-actions">
                    <button
                        className="btn btn-secondary btn-sm dashboard-keys-refresh"
                        onClick={() => void refresh()}
                        disabled={loading || previewMode}
                        aria-busy={loading}
                    >
                        <RefreshCw size={12} /> Refresh
                    </button>
                    <button
                        className="lp-nav-cta dashboard-keys-add"
                        onClick={() => {
                            setCreateError('')
                            setShowCreate(true)
                        }}
                        disabled={showCreate || lifecycleBusy || previewMode || !v2AccountId}
                    >
                        Create <Plus size={18} strokeWidth={2.5} aria-hidden="true" />
                    </button>
                </div>
            }
        >
            {(error || createError) && (
                <div style={{
                    background: 'rgba(248,113,113,0.08)',
                    border: '1px solid rgba(248,113,113,0.2)',
                    borderRadius: 'var(--radius-md)',
                    padding: '10px 14px',
                    marginBottom: 12,
                    color: 'var(--danger)',
                    fontSize: '0.82rem',
                }}>
                    {createError || error}
                </div>
            )}
            {createPhase && (
                <p className="dashboard-add-key-note">{createPhase}…</p>
            )}

            {showCreate && (
                <div className="dashboard-add-key-form">
                    <div className="dashboard-add-key-field">
                        <label className="dashboard-add-key-label">Namespace label</label>
                        <input
                            className="dashboard-add-key-input"
                            type="text"
                            value={newLabel}
                            maxLength={NAMESPACE_LABEL_MAX_LENGTH}
                            onChange={(event) => setNewLabel(sanitizeLabelInput(event.target.value))}
                            placeholder="memories"
                        />
                    </div>
                    <p className="dashboard-add-key-note">
                        Create, Seal-wrap a 32-byte namespace key, then grant read/write to operator writers and this session&apos;s delegate. Each step is a separate sponsored transaction.
                    </p>
                    <div className="dashboard-add-key-actions">
                        <button
                            className="btn btn-secondary btn-sm dashboard-add-key-cancel"
                            onClick={() => setShowCreate(false)}
                            disabled={lifecycleBusy}
                        >
                            Cancel
                        </button>
                        <button
                            className="btn btn-primary btn-sm dashboard-add-key-create"
                            onClick={() => void handleCreate()}
                            disabled={lifecycleBusy || !v2AccountId || !walletSigner}
                            aria-busy={creating}
                        >
                            {creating ? 'Creating...' : 'Create'}
                        </button>
                    </div>
                </div>
            )}

            {listBusy ? (
                <div className="dashboard-empty-message dashboard-empty-message--account">
                    Loading namespaces...
                </div>
            ) : !v2ConfigReady() ? (
                <div className="dashboard-empty-message dashboard-empty-message--account">
                    V2 package IDs are not configured.
                </div>
            ) : !v2AccountId && !loading ? (
                <div className="dashboard-empty-message dashboard-empty-message--account">
                    No V2 Walrus Memory account found for this wallet. Namespaces require a MemWal account on the V2 package.
                </div>
            ) : namespaces.length === 0 ? (
                <div className="dashboard-empty-message dashboard-empty-message--account">
                    No namespaces yet. Create one to isolate V2 memories under a Seal-wrapped key.
                </div>
            ) : (
                <div className={`dashboard-key-table-wrap${loading ? ' dashboard-key-list--busy' : ''}`}>
                    <table className="dashboard-key-table">
                        <thead>
                            <tr>
                                <th scope="col">Label</th>
                                <th scope="col">Object ID</th>
                                <th scope="col">Active</th>
                                <th scope="col">Key version</th>
                                <th scope="col" className="dashboard-key-table-actions">Actions</th>
                            </tr>
                        </thead>
                        <tbody>
                            {namespaces.map((row) => {
                                const isSelected = selected?.id === row.id
                                return (
                                    <tr
                                        key={row.id}
                                        className={`dashboard-key-row${isSelected ? ' dashboard-key-row--selected' : ''}`}
                                        onClick={() => setSelectedId(row.id)}
                                    >
                                        <td data-label="Label">
                                            <div className="dashboard-key-name">
                                                <span>{row.label || 'Untitled'}</span>
                                            </div>
                                        </td>
                                        <td data-label="Object ID">
                                            <code className="dashboard-key-public" title={row.id}>
                                                {compactObjectId(row.id)}
                                            </code>
                                        </td>
                                        <td data-label="Active">
                                            {row.active ? 'active' : row.keyInitialized ? 'inactive' : 'uninitialized'}
                                        </td>
                                        <td data-label="Key version">{row.keyVersion}</td>
                                        <td data-label="Actions" className="dashboard-key-row-actions">
                                            <button
                                                className={`btn btn-secondary btn-sm dashboard-key-icon-action${copied === row.id ? ' dashboard-key-icon-action--copied' : ''}`}
                                                onClick={(event) => {
                                                    event.stopPropagation()
                                                    void copyId(row.id)
                                                }}
                                                aria-label={copied === row.id ? 'Object id copied' : 'Copy object id'}
                                                title={copied === row.id ? 'Copied' : 'Copy object id'}
                                            >
                                                <Copy size={14} />
                                            </button>
                                        </td>
                                    </tr>
                                )
                            })}
                        </tbody>
                    </table>
                </div>
            )}

            {selected && (
                <div className="dashboard-add-key-form" style={{ marginTop: 20 }}>
                    {!selected.keyInitialized && (
                        <>
                            <p className="dashboard-add-key-note">
                                This namespace is reserved but not initialized. Finish wrapping the key, or cancel the reservation to reuse the label.
                            </p>
                            <div className="dashboard-add-key-actions">
                                <button
                                    className="btn btn-secondary btn-sm dashboard-add-key-cancel"
                                    onClick={() => void handleCancelReservation()}
                                    disabled={lifecycleBusy || !walletSigner}
                                    aria-busy={cancelling}
                                >
                                    {cancelling ? 'Cancelling...' : 'Cancel reservation'}
                                </button>
                                <button
                                    className="btn btn-primary btn-sm dashboard-add-key-create"
                                    onClick={() => void handleFinishInitialize()}
                                    disabled={lifecycleBusy || !walletSigner}
                                    aria-busy={finishing}
                                >
                                    {finishing ? 'Initializing...' : 'Finish initialize'}
                                </button>
                            </div>
                        </>
                    )}
                    <div className="dashboard-add-key-field">
                        <label className="dashboard-add-key-label">Share {selected.label || compactObjectId(selected.id)}</label>
                        <input
                            className="dashboard-add-key-input"
                            type="text"
                            value={sharePrincipal}
                            onChange={(event) => setSharePrincipal(event.target.value.trim())}
                            placeholder="0x… wallet address"
                        />
                    </div>
                    <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap' }}>
                        <label>
                            <input
                                type="checkbox"
                                checked={shareBits.canRead}
                                onChange={(event) => {
                                    const next = event.target.checked
                                    setShareRead(next)
                                    if (!next) {
                                        setShareWrite(false)
                                        setShareShare(false)
                                    }
                                }}
                            />{' '}
                            Read
                        </label>
                        <label>
                            <input
                                type="checkbox"
                                checked={shareWrite}
                                onChange={(event) => {
                                    const next = event.target.checked
                                    setShareWrite(next)
                                    if (next) setShareRead(true)
                                }}
                            />{' '}
                            Write
                        </label>
                        <label>
                            <input
                                type="checkbox"
                                checked={shareShare && shareAllowed}
                                disabled={!shareAllowed}
                                onChange={(event) => {
                                    const next = event.target.checked
                                    setShareShare(next)
                                    if (next) setShareRead(true)
                                }}
                            />{' '}
                            Share
                        </label>
                    </div>
                    <p className="dashboard-add-key-note">Share is limited to current account delegates.</p>
                    {shareBlocked && (
                        <p className="dashboard-add-key-note">{shareBlocked}</p>
                    )}
                    {shareError && (
                        <p className="dashboard-add-key-note" style={{ color: 'var(--danger)' }}>{shareError}</p>
                    )}
                    <div className="dashboard-add-key-actions">
                        <button
                            className="btn btn-primary btn-sm dashboard-add-key-create"
                            onClick={() => void handleShare()}
                            disabled={sharing || lifecycleBusy || !selected.active || !walletSigner || Boolean(shareBlocked)}
                            aria-busy={sharing}
                        >
                            {sharing ? 'Granting...' : 'Grant access'}
                        </button>
                    </div>

                    <div className="dashboard-add-key-field">
                        <label className="dashboard-add-key-label">Look up permissions</label>
                        <input
                            className="dashboard-add-key-input"
                            type="text"
                            value={lookupPrincipal}
                            onChange={(event) => setLookupPrincipal(event.target.value.trim())}
                            placeholder="0x… wallet address"
                        />
                    </div>
                    <p className="dashboard-add-key-note">
                        ACL is not enumerable on chain; look up an address.
                    </p>
                    {lookupError && (
                        <p className="dashboard-add-key-note" style={{ color: 'var(--danger)' }}>{lookupError}</p>
                    )}
                    {lookupResult && (
                        <p className="dashboard-add-key-note">
                            can read: {lookupResult.canRead ? 'yes' : 'no'} · can write: {lookupResult.canWrite ? 'yes' : 'no'} · can share: {lookupResult.canShare ? 'yes' : 'no'}
                        </p>
                    )}
                    <div className="dashboard-add-key-actions">
                        <button
                            className="btn btn-secondary btn-sm dashboard-add-key-cancel"
                            onClick={() => void handleLookup()}
                            disabled={lookingUp}
                            aria-busy={lookingUp}
                        >
                            {lookingUp ? 'Looking up...' : 'Look up'}
                        </button>
                    </div>

                    {selectedSessionGrants.length > 0 && (
                        <div className="dashboard-add-key-field">
                            <label className="dashboard-add-key-label">Granted this session</label>
                            <ul style={{ margin: 0, paddingLeft: 18, color: '#faf8f5', fontSize: 14 }}>
                                {selectedSessionGrants.map((grant) => (
                                    <li key={`${grant.namespaceId}:${grant.principal}`}>
                                        <code className="dashboard-key-public" title={grant.principal}>
                                            {compactObjectId(grant.principal)}
                                        </code>
                                        {' '}
                                        {grant.canRead ? 'read' : ''}
                                        {grant.canWrite ? ' write' : ''}
                                        {grant.canShare ? ' share' : ''}
                                    </li>
                                ))}
                            </ul>
                        </div>
                    )}
                </div>
            )}
        </Card>
    )
}
