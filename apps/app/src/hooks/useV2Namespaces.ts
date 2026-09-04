import { useCallback, useEffect, useRef, useState } from 'react'
import { useSuiClient } from '@mysten/dapp-kit'
import { config } from '../config'
import {
    fetchV2AccountId,
    fetchV2DelegateAddresses,
    listOwnedV2Namespaces,
    mergeNamespaceRows,
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
    const requestGeneration = useRef(0)

    const upsertNamespace = useCallback((row: V2NamespaceRow) => {
        setNamespaces((prev) => [row, ...prev.filter((existing) => existing.id !== row.id)])
    }, [])

    const removeNamespace = useCallback((id: string) => {
        setNamespaces((prev) => prev.filter((row) => row.id !== id))
    }, [])

    const refresh = useCallback(async () => {
        if (!enabled || !ownerAddress) {
            setNamespaces([])
            setV2AccountId(null)
            setDelegateAddresses([])
            setError('')
            setLoading(false)
            return
        }
        const request = ++requestGeneration.current
        setLoading(true)
        setError('')
        try {
            const accountId = await fetchV2AccountId(suiClient, ownerAddress)
            const [rows, delegates] = await Promise.all([
                listOwnedV2Namespaces(suiClient, ownerAddress),
                accountId ? fetchV2DelegateAddresses(suiClient, accountId) : Promise.resolve([]),
            ])
            if (request !== requestGeneration.current) return
            setV2AccountId(accountId)
            setNamespaces((prev) => mergeNamespaceRows(rows, prev))
            setDelegateAddresses(delegates)
        } catch (err) {
            if (request !== requestGeneration.current) return
            setError(err instanceof Error ? err.message : String(err))
        } finally {
            if (request === requestGeneration.current) setLoading(false)
        }
    }, [enabled, ownerAddress, suiClient])

    useEffect(() => {
        setNamespaces([])
        setV2AccountId(null)
        setDelegateAddresses([])
        setError('')
    }, [ownerAddress])

    useEffect(() => {
        void refresh()
    }, [refresh])

    return {
        namespaces,
        v2AccountId,
        delegateAddresses,
        loading,
        error,
        refresh,
        upsertNamespace,
        removeNamespace,
    }
}
