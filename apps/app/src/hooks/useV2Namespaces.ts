import { useCallback, useEffect, useState } from 'react'
import { useSuiClient } from '@mysten/dapp-kit'
import { config } from '../config'
import {
    fetchV2AccountId,
    fetchV2DelegateAddresses,
    listOwnedV2Namespaces,
    v2ConfigReady,
    type V2NamespaceRow,
} from '../utils/v2Namespace'

export function useV2Namespaces(ownerAddress: string) {
    const suiClient = useSuiClient()
    const enabled = config.v2NamespacesEnabled && v2ConfigReady()
    const [namespaces, setNamespaces] = useState<V2NamespaceRow[]>([])
    const [v2AccountId, setV2AccountId] = useState<string | null>(null)
    const [delegateAddresses, setDelegateAddresses] = useState<string[]>([])
    const [loading, setLoading] = useState(false)
    const [error, setError] = useState('')

    const refresh = useCallback(async () => {
        if (!enabled || !ownerAddress) {
            setNamespaces([])
            setV2AccountId(null)
            setDelegateAddresses([])
            setError('')
            setLoading(false)
            return
        }
        setLoading(true)
        setError('')
        try {
            const accountId = await fetchV2AccountId(suiClient, ownerAddress)
            setV2AccountId(accountId)
            const [rows, delegates] = await Promise.all([
                listOwnedV2Namespaces(suiClient, ownerAddress),
                accountId ? fetchV2DelegateAddresses(suiClient, accountId) : Promise.resolve([]),
            ])
            setNamespaces(rows)
            setDelegateAddresses(delegates)
        } catch (err) {
            setNamespaces([])
            setError(err instanceof Error ? err.message : String(err))
        } finally {
            setLoading(false)
        }
    }, [enabled, ownerAddress, suiClient])

    useEffect(() => {
        void refresh()
    }, [refresh])

    return { namespaces, v2AccountId, delegateAddresses, loading, error, refresh }
}
