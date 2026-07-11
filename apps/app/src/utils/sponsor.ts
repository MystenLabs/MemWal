/**
 * Enoki sponsorship — the shared "first half" of the sponsored-tx flow:
 * TransactionKind bytes → POST /sponsor → sponsored full-tx bytes + digest.
 * Used by useSponsoredTransaction (which then executes via /sponsor/execute)
 * and by the delete-memories flow (which hands the signature to
 * /api/delete-memories instead — the backend owns submit + DB cleanup).
 */

import { config } from '../config'

export interface SponsoredTx {
    /** base64 full transaction bytes to sign */
    bytes: string
    /** digest the sidecar uses to execute the reservation */
    digest: string
}

export interface SponsorOptions {
    /**
     * Route through POST /sponsor-delete instead of /sponsor. That path has
     * no sponsor rate limit — a delete-all run sponsors one transaction per
     * batch and would trip the normal per-IP/per-sender caps mid-run — and
     * in exchange the sidecar only sponsors transactions it verifies to be
     * pure walrus `system::delete_blob` cleanups.
     */
    deleteFlow?: boolean
}

export async function sponsorTransactionKind(
    kindBytes: Uint8Array,
    sender: string,
    { deleteFlow }: SponsorOptions = {},
): Promise<SponsoredTx> {
    const endpoint = deleteFlow ? '/sponsor-delete' : '/sponsor'
    const res = await fetch(`${config.memwalServerUrl}${endpoint}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            transactionBlockKindBytes: uint8ToBase64(kindBytes),
            sender,
        }),
    })
    if (!res.ok) {
        throw new Error(`Sponsor failed (${res.status}): ${await res.text()}`)
    }
    return res.json()
}

function uint8ToBase64(bytes: Uint8Array): string {
    let binary = ''
    for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i])
    return btoa(binary)
}
