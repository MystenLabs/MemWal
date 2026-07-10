/**
 * useSponsoredTransaction — Enoki-sponsored transaction hook
 *
 * Drop-in replacement for useSignAndExecuteTransaction from @mysten/dapp-kit.
 * Routes transactions through Enoki sponsor via the sidecar server for gasless UX.
 *
 * Flow:
 *   1. Build Transaction as TransactionKind bytes
 *   2. POST to sidecar /sponsor → get { bytes, digest }
 *   3. Sign sponsored bytes with user wallet
 *   4. POST to sidecar /sponsor/execute → get { digest }
 *
 * Falls back to direct signAndExecute if sponsor fails.
 */

import { useCurrentAccount, useSignTransaction, useSignAndExecuteTransaction, useSuiClient } from '@mysten/dapp-kit'
import { Transaction } from '@mysten/sui/transactions'
import { config } from '../config'
import { executeTransactionCompat } from '../utils/suiClientCompat'

export function useSponsoredTransaction() {
    const currentAccount = useCurrentAccount()
    const suiClient = useSuiClient()
    const { mutateAsync: signTransaction } = useSignTransaction()
    const { mutateAsync: directSignAndExecute } = useSignAndExecuteTransaction({
        execute: (args) => executeTransactionCompat(suiClient, args),
    })

    const mutateAsync = async ({ transaction }: { transaction: Transaction }): Promise<{ digest: string }> => {
        const sender = currentAccount?.address
        if (!sender) throw new Error('No wallet connected')

        // Track the already-built TransactionKind bytes so the catch block can
        // rebuild a FRESH Transaction (Transaction.fromKind) instead of reusing
        // `transaction` itself. `transaction.build({onlyTransactionKind:true})`
        // resolves/caches the plan with no sender attached (transaction-kind
        // bytes exclude sender by design); reusing that same already-built
        // object in directSignAndExecute below does not correctly re-resolve
        // against the real signer, which silently executed as ENotOwner in
        // testing (assert! account.owner == ctx.sender() in add_delegate_key)
        // instead of the connected wallet's actual address.
        let kindBytes: Uint8Array | undefined

        try {
            // 1. Build TransactionKind bytes (without gas data)
            kindBytes = await transaction.build({
                client: suiClient,
                onlyTransactionKind: true,
            })
            const kindBase64 = uint8ArrayToBase64(kindBytes)

            // 2. Sponsor via server (proxied to sidecar)
            const sponsorRes = await fetch(`${config.memwalServerUrl}/sponsor`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    transactionBlockKindBytes: kindBase64,
                    sender,
                }),
            })

            if (!sponsorRes.ok) {
                const errText = await sponsorRes.text()
                throw new Error(`Sponsor failed (${sponsorRes.status}): ${errText}`)
            }

            const sponsored = await sponsorRes.json()
            // sponsored = { bytes: base64, digest: string }

            // 3. Sign sponsored bytes with user wallet
            const sponsoredTx = Transaction.from(sponsored.bytes)
            const { signature } = await signTransaction({ transaction: sponsoredTx })

            // 4. Execute via server (proxied to sidecar)
            const execRes = await fetch(`${config.memwalServerUrl}/sponsor/execute`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    digest: sponsored.digest,
                    signature,
                }),
            })

            if (!execRes.ok) {
                const errText = await execRes.text()
                throw new Error(`Sponsored execute failed (${execRes.status}): ${errText}`)
            }

            const result = await execRes.json()
            console.log(`[sponsored-tx] success, digest=${result.digest}`)
            return { digest: result.digest }
        } catch (err) {
            // Fallback: try direct signing if sponsor fails.
            // Rebuild a fresh Transaction from the TransactionKind bytes (if we
            // got that far) instead of reusing the original `transaction` — it
            // was already built with onlyTransactionKind:true (no sender), and
            // reusing that resolved/cached plan here does not correctly
            // re-resolve ownership against the actual connected signer.
            console.warn('[sponsored-tx] sponsor failed, falling back to direct signing:', err)
            const fallbackTx = kindBytes ? Transaction.fromKind(kindBytes) : transaction
            const result = await directSignAndExecute({ transaction: fallbackTx })
            return { digest: result.digest }
        }
    }

    return { mutateAsync }
}

// Helper: Uint8Array → base64
function uint8ArrayToBase64(bytes: Uint8Array): string {
    let binary = ''
    for (let i = 0; i < bytes.length; i++) {
        binary += String.fromCharCode(bytes[i])
    }
    return btoa(binary)
}
