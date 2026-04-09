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
import { useDelegateKey } from '../App'
import { apiCall } from '../utils/api'

export function useSponsoredTransaction() {
    const currentAccount = useCurrentAccount()
    const suiClient = useSuiClient()
    const { mutateAsync: signTransaction } = useSignTransaction()
    const { mutateAsync: directSignAndExecute } = useSignAndExecuteTransaction()
    const { delegateKey, delegatePublicKey, accountObjectId } = useDelegateKey()

    const mutateAsync = async ({ transaction }: { transaction: Transaction }): Promise<{ digest: string }> => {
        const sender = currentAccount?.address
        if (!sender) throw new Error('No wallet connected')

        try {
            // 1. Build TransactionKind bytes (without gas data)
            const kindBytes = await transaction.build({
                client: suiClient as any,
                onlyTransactionKind: true,
            })
            const kindBase64 = uint8ArrayToBase64(kindBytes)

            if (!delegateKey || !delegatePublicKey) {
                throw new Error('No delegate key available for signing sponsor request')
            }

            // 2. Sponsor via server — signed with delegate key (required by verify_signature middleware)
            const sponsored = await apiCall(
                delegateKey,
                config.memwalServerUrl,
                '/sponsor',
                { transactionBlockKindBytes: kindBase64, sender },
                accountObjectId ?? undefined,
            )
            // sponsored = { bytes: base64, digest: string }

            // 3. Sign sponsored bytes with user wallet
            const sponsoredTx = Transaction.from(sponsored.bytes)
            const { signature } = await signTransaction({ transaction: sponsoredTx })

            // 4. Execute via server — signed with delegate key
            const result = await apiCall(
                delegateKey,
                config.memwalServerUrl,
                '/sponsor/execute',
                { digest: sponsored.digest, signature },
                accountObjectId ?? undefined,
            )

            console.log(`[sponsored-tx] success, digest=${result.digest}`)
            return { digest: result.digest }
        } catch (err) {
            // Fallback: try direct signing if sponsor fails
            console.warn('[sponsored-tx] sponsor failed, falling back to direct signing:', err)
            const result = await directSignAndExecute({ transaction })
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
