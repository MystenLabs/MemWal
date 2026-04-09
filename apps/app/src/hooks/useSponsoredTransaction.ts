/**
 * useSponsoredTransaction — Enoki-sponsored transaction hook
 *
 * Drop-in replacement for useSignAndExecuteTransaction from @mysten/dapp-kit.
 * Routes transactions through Enoki sponsor via the sidecar server for gasless UX.
 *
 * Flow:
 *   1. Build Transaction as TransactionKind bytes
 *   2. POST to /sponsor → get { bytes, digest }
 *   3. Sign sponsored bytes with user wallet
 *   4. POST to /sponsor/execute → get { digest }
 *
 * Falls back to direct signAndExecute if sponsor fails.
 *
 * signingKey / signingPublicKey: optional override used by SetupWizard before
 * the delegate key is registered on-chain. /sponsor uses verify_signature_sponsor
 * which verifies Ed25519 signature but skips on-chain account resolution.
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

    const mutateAsync = async ({
        transaction,
        signingKey,
        signingPublicKey,
    }: {
        transaction: Transaction
        /** Key override for SetupWizard — local key before on-chain registration */
        signingKey?: string
        signingPublicKey?: string
    }): Promise<{ digest: string }> => {
        const sender = currentAccount?.address
        if (!sender) throw new Error('No wallet connected')

        try {
            const kindBytes = await transaction.build({
                client: suiClient as any,
                onlyTransactionKind: true,
            })
            const kindBase64 = uint8ArrayToBase64(kindBytes)

            if (!(signingKey ?? delegateKey) || !(signingPublicKey ?? delegatePublicKey)) {
                throw new Error('No delegate key available for signing sponsor request')
            }

            const sponsored = await apiCall(
                (signingKey ?? delegateKey)!,
                config.memwalServerUrl,
                '/sponsor',
                { transactionBlockKindBytes: kindBase64, sender },
                accountObjectId ?? undefined,
            )

            const sponsoredTx = Transaction.from(sponsored.bytes)
            const { signature } = await signTransaction({ transaction: sponsoredTx })

            const result = await apiCall(
                (signingKey ?? delegateKey)!,
                config.memwalServerUrl,
                '/sponsor/execute',
                { digest: sponsored.digest, signature },
                accountObjectId ?? undefined,
            )

            console.log(`[sponsored-tx] success, digest=${result.digest}`)
            return { digest: result.digest }
        } catch (err) {
            console.warn('[sponsored-tx] sponsor failed, falling back to direct signing:', err)
            const result = await directSignAndExecute({ transaction })
            return { digest: result.digest }
        }
    }

    return { mutateAsync }
}

function uint8ArrayToBase64(bytes: Uint8Array): string {
    let binary = ''
    for (let i = 0; i < bytes.length; i++) {
        binary += String.fromCharCode(bytes[i])
    }
    return btoa(binary)
}
