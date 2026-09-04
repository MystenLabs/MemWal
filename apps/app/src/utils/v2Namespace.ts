/**
 * V2 namespace helpers for the dashboard/playground slice.
 */

import {
    cancelUninitializedNamespace,
    createNamespace,
    generateAndWrapNamespaceDek as sdkGenerateAndWrapNamespaceDek,
    grantAccess,
    initializeKey,
    namespaceSealKeyId as sdkNamespaceSealKeyId,
} from '@mysten-incubation/memwal/account'
import type { WalletSigner } from '@mysten-incubation/memwal/manual'
import { Ed25519PublicKey } from '@mysten/sui/keypairs/ed25519'
import { getJsonRpcFullnodeUrl, SuiJsonRpcClient } from '@mysten/sui/jsonRpc'
import { Transaction } from '@mysten/sui/transactions'
import {
    fromHex,
    isValidSuiAddress,
    normalizeSuiAddress,
    toHex,
} from '@mysten/sui/utils'
import { config } from '../config'
import { fetchAccountIdForOwner, fetchObjectJson, publicKeyToHex } from './suiClientCompat'

export const NAMESPACE_LABEL_MAX_LENGTH = 64
export const PERMISSION_READ = 1
export const PERMISSION_WRITE = 2
export const PERMISSION_SHARE = 4

const EVENT_PAGE_SIZE = 50
const MAX_OWNER_EVENT_PAGES = 100

const DEFAULT_SEAL_SERVERS: Record<'testnet' | 'mainnet', string[]> = {
    testnet: [
        '0x73d05d62c18d9374e3ea529e8e0ed6161da1a141a94d3f76ae3fe4e99356db75',
        '0xf5d14a81a982144ae441cd7d64b09027f116a468bd36e7eca494f750591623c8',
    ],
    mainnet: [
        '0x145540d931f182fef76467dd8074c9839aea126852d90d18e1556fcbbd1208b6',
        '0xe0eb52eba9261b96e895bbb4deca10dcd64fbc626a1133017adcd5131353fd10',
    ],
}

export type GrantBits = {
    canRead: boolean
    canWrite: boolean
    canShare: boolean
}

export type V2NamespaceRow = {
    id: string
    label: string
    active: boolean
    keyVersion: number
    keyInitialized: boolean
    destroyed: boolean
    owner: string
    accountId: string
}

export type WalletSignerLike = WalletSigner

export type SealServerConfig = {
    objectId: string
    weight: number
    aggregatorUrl?: string
    apiKeyName?: string
    apiKey?: string
}

type EventsClient = {
    queryEvents: (input: {
        query: { Sender: string }
        cursor?: unknown
        limit?: number
        order?: 'ascending' | 'descending'
    }) => Promise<{
        data: Array<{
            type?: string
            parsedJson?: Record<string, unknown> | null
            json?: Record<string, unknown> | null
        }>
        nextCursor?: unknown
        hasNextPage?: boolean
    }>
}

type InspectClient = {
    devInspectTransactionBlock: (input: {
        sender: string
        transactionBlock: Transaction
    }) => Promise<{
        results?: Array<{ returnValues?: Array<[number[] | Uint8Array, string]> }>
        error?: unknown
        effects?: { status?: { status?: string; error?: unknown } }
    }>
}

let jsonRpcClient: SuiJsonRpcClient | undefined

function v2JsonRpcUrl(): string {
    if (config.localE2eJsonRpc) return config.suiRpcUrl || 'http://127.0.0.1:9000'
    if (config.suiRpcUrl) return config.suiRpcUrl
    return getJsonRpcFullnodeUrl(config.suiNetwork)
}

/** Dedicated JSON-RPC client for queryEvents / devInspect (gRPC has neither). */
export function getV2JsonRpcClient(): SuiJsonRpcClient {
    if (!jsonRpcClient) {
        jsonRpcClient = new SuiJsonRpcClient({
            url: v2JsonRpcUrl(),
            network: config.suiClientNetwork,
        })
    }
    return jsonRpcClient
}

function sdkTxOpts(accountId: string, walletSigner: WalletSignerLike, suiClient: unknown) {
    return {
        packageId: config.v2PackageId,
        namespaceRegistryId: config.v2NamespaceRegistryId,
        accountRegistryId: config.v2RegistryId,
        accountId,
        walletSigner,
        suiClient,
        suiNetwork: config.suiNetwork,
    }
}

export function sanitizeLabelInput(raw: string): string {
    return raw
        .replace(/[<>&"'/]/g, '')
        .replace(/\p{Cc}/gu, '')
}

export function normalizeLabelForSubmit(raw: string): string {
    return sanitizeLabelInput(raw).trim()
}

export function utf8ByteLength(value: string): number {
    return new TextEncoder().encode(value).length
}

export function validateNamespaceLabel(label: string): string | null {
    if (!label) return 'Namespace label cannot be empty'
    if (utf8ByteLength(label) > NAMESPACE_LABEL_MAX_LENGTH) {
        return 'Namespace label must be 64 bytes or fewer'
    }
    return null
}

/** WRITE and SHARE both imply READ — same as namespace::permission_bits. */
export function grantBitsFromCheckboxes(input: { read: boolean; write: boolean; share: boolean }): GrantBits {
    const canWrite = input.write
    const canShare = input.share
    return {
        canRead: input.read || canWrite || canShare,
        canWrite,
        canShare,
    }
}

export function validateGrantBits(bits: GrantBits): string | null {
    if (!bits.canRead && !bits.canWrite && !bits.canShare) {
        return 'Select at least Read or Write'
    }
    return null
}

export function permissionFlags(bits: number): GrantBits {
    return {
        canRead: (bits & PERMISSION_READ) === PERMISSION_READ,
        canWrite: (bits & PERMISSION_WRITE) === PERMISSION_WRITE,
        canShare: (bits & PERMISSION_SHARE) === PERMISSION_SHARE,
    }
}

export function bytesToHex(bytes: Uint8Array): string {
    return toHex(bytes)
}

export function namespaceSealKeyId(namespaceId: string, keyVersion: bigint): Uint8Array {
    return sdkNamespaceSealKeyId(namespaceId, keyVersion)
}

export function suiAddressFromEd25519PublicKeyHex(publicKeyHex: string): string {
    const hex = publicKeyHex.startsWith('0x') ? publicKeyHex.slice(2) : publicKeyHex
    if (!/^[0-9a-fA-F]{64}$/.test(hex)) {
        throw new Error('invalid delegate public key')
    }
    return new Ed25519PublicKey(fromHex(hex)).toSuiAddress()
}

export function asObjectId(value: unknown): string {
    if (typeof value === 'string' && value) {
        return value.startsWith('0x') ? value : `0x${value}`
    }
    if (value && typeof value === 'object') {
        const inner = (value as { id?: unknown }).id
        if (typeof inner === 'string' && inner) {
            return inner.startsWith('0x') ? inner : `0x${inner}`
        }
    }
    return ''
}

export function compactObjectId(id: string): string {
    const normalized = id.startsWith('0x') ? id : `0x${id}`
    if (normalized.length <= 18) return normalized
    return `${normalized.slice(0, 10)}...${normalized.slice(-6)}`
}

export function isCurrentAccountDelegate(principal: string, delegateAddresses: string[]): boolean {
    if (!isValidSuiAddress(principal)) return false
    const normalized = normalizeSuiAddress(principal)
    return delegateAddresses.some((address) => {
        try {
            return normalizeSuiAddress(address) === normalized
        } catch {
            return false
        }
    })
}

export function principalsToGrant(
    writerAddresses: readonly string[],
    delegateAddress: string | null,
    ownerAddress: string,
): string[] {
    const owner = isValidSuiAddress(ownerAddress) ? normalizeSuiAddress(ownerAddress) : ''
    const seen = new Set<string>()
    const out: string[] = []
    for (const raw of [...writerAddresses, delegateAddress]) {
        if (!raw || !isValidSuiAddress(raw)) continue
        const normalized = normalizeSuiAddress(raw)
        if (normalized === normalizeSuiAddress('0x0')) continue
        if (owner && normalized === owner) continue
        if (seen.has(normalized)) continue
        seen.add(normalized)
        out.push(normalized)
    }
    return out
}

export function sharePrincipalBlockedReason(principal: string, ownerAddress: string): string | null {
    if (!principal) return null
    if (/^0x0+$/i.test(principal.trim())) return 'The zero address cannot be granted access'
    if (!isValidSuiAddress(principal)) return 'Enter a valid Sui address'
    const normalized = normalizeSuiAddress(principal)
    if (isValidSuiAddress(ownerAddress) && normalized === normalizeSuiAddress(ownerAddress)) {
        return 'The owner already has implicit access'
    }
    return null
}

export function playgroundMemwalAccountId(opts: {
    namespace: string
    v2Namespaces: ReadonlyArray<{ label: string; active: boolean }>
    v2AccountId: string | null
    v1AccountId: string | null
}): string | null {
    const isV2 = opts.v2Namespaces.some((row) => row.active && row.label === opts.namespace)
    if (isV2) return opts.v2AccountId
    return opts.v1AccountId
}

export function playgroundNamespaceOptions(v2Labels: readonly string[], current: string): string[] {
    const out: string[] = []
    const seen = new Set<string>()
    for (const label of ['default', ...v2Labels, current]) {
        if (!label || seen.has(label)) continue
        seen.add(label)
        out.push(label)
    }
    return out
}

export function mergeNamespaceRows(fetched: V2NamespaceRow[], local: V2NamespaceRow[]): V2NamespaceRow[] {
    const fetchedIds = new Set(fetched.map((row) => row.id))
    const extras = local.filter((row) => !fetchedIds.has(row.id) && !row.destroyed)
    return [...fetched, ...extras]
}

export function v2SealServerConfigs(): SealServerConfig[] {
    if (config.sealServerConfigs.length > 0) {
        return config.sealServerConfigs.map((server) => ({ ...server }))
    }
    const ids = config.sealKeyServers.length > 0
        ? [...config.sealKeyServers]
        : DEFAULT_SEAL_SERVERS[config.suiNetwork]
    return ids.map((objectId) => ({ objectId, weight: 1 }))
}

export function v2SealThreshold(): number {
    if (config.sealThreshold >= 1) return config.sealThreshold
    const totalWeight = v2SealServerConfigs().reduce((sum, server) => sum + (server.weight || 1), 0)
    return totalWeight > 0 ? Math.min(2, totalWeight) : 2
}

export function v2ConfigReady(): boolean {
    return Boolean(config.v2PackageId && config.v2RegistryId && config.v2NamespaceRegistryId)
}

export async function fetchV2AccountId(suiClient: unknown, owner: string): Promise<string | null> {
    if (!config.v2RegistryId || !owner) return null
    return fetchAccountIdForOwner(suiClient, config.v2RegistryId, owner)
}

export async function fetchV2DelegateAddresses(suiClient: unknown, accountId: string): Promise<string[]> {
    const json = await fetchObjectJson(suiClient, accountId) as {
        delegate_keys?: { public_key?: unknown; sui_address?: string }[]
    } | null
    const addresses: string[] = []
    for (const key of json?.delegate_keys ?? []) {
        if (key.sui_address && isValidSuiAddress(key.sui_address)) {
            addresses.push(normalizeSuiAddress(key.sui_address))
            continue
        }
        const hex = publicKeyToHex(key.public_key)
        if (!hex) continue
        try {
            addresses.push(normalizeSuiAddress(suiAddressFromEd25519PublicKeyHex(hex)))
        } catch {
            // skip malformed on-chain keys
        }
    }
    return addresses
}

export async function readV2NamespaceRow(
    suiClient: unknown,
    id: string,
    ownerFallback: string,
): Promise<V2NamespaceRow | null> {
    const fields = await fetchObjectJson(suiClient, id)
    if (!fields) return null
    if (Boolean(fields.destroyed)) return null
    return {
        id,
        label: typeof fields.label === 'string' ? fields.label : '',
        active: Boolean(fields.active),
        keyVersion: Number(fields.current_key_version ?? 0),
        keyInitialized: Boolean(fields.key_initialized),
        destroyed: false,
        owner: typeof fields.owner === 'string' ? fields.owner : ownerFallback,
        accountId: asObjectId(fields.account_id),
    }
}

function eventIsNamespaceCreated(type: string): boolean {
    if (!/::namespace::NamespaceCreated$/.test(type)) return false
    if (!config.v2PackageId) return true
    const pkg = type.split('::')[0] ?? ''
    try {
        return normalizeSuiAddress(pkg) === normalizeSuiAddress(config.v2PackageId)
    } catch {
        return type.startsWith(config.v2PackageId)
    }
}

export async function listOwnedV2Namespaces(_suiClient: unknown, owner: string): Promise<V2NamespaceRow[]> {
    if (!config.v2PackageId || !owner) return []
    const rpc = getV2JsonRpcClient() as unknown as EventsClient
    const ownerNormalized = normalizeSuiAddress(owner)
    const ids: string[] = []
    const seen = new Set<string>()
    let cursor: unknown
    for (let page = 0; page < MAX_OWNER_EVENT_PAGES; page++) {
        const response = await rpc.queryEvents({
            query: { Sender: ownerNormalized },
            limit: EVENT_PAGE_SIZE,
            order: 'descending',
            cursor,
        })
        for (const event of response.data) {
            if (!eventIsNamespaceCreated(String(event.type ?? ''))) continue
            const parsed = event.parsedJson ?? event.json ?? {}
            const eventOwner = typeof parsed.owner === 'string' ? parsed.owner : owner
            if (normalizeSuiAddress(eventOwner) !== ownerNormalized) continue
            const id = asObjectId(parsed.namespace_id)
            if (!id || seen.has(id)) continue
            seen.add(id)
            ids.push(id)
        }
        if (!response.hasNextPage) break
        cursor = response.nextCursor
        if (cursor == null) break
    }

    const rows: Array<V2NamespaceRow | null> = await Promise.all(
        ids.map((id) => readV2NamespaceRow(rpc, id, owner)),
    )
    return rows.filter((row): row is V2NamespaceRow => row != null)
}

function decodeReturnU8(result: Awaited<ReturnType<InspectClient['devInspectTransactionBlock']>>): number {
    const bytes = result.results?.[0]?.returnValues?.[0]?.[0]
    if (!bytes) throw new Error('permissions view returned no value')
    return Number(bytes[0] ?? 0)
}

export async function lookupNamespacePermissions(
    _suiClient: unknown,
    namespaceId: string,
    principal: string,
    sender: string,
): Promise<GrantBits> {
    if (!isValidSuiAddress(principal)) throw new Error('Enter a valid Sui address')
    const client = getV2JsonRpcClient() as unknown as InspectClient
    const tx = new Transaction()
    tx.moveCall({
        target: `${config.v2PackageId}::namespace::permissions`,
        arguments: [
            tx.object(namespaceId),
            tx.pure('address', normalizeSuiAddress(principal)),
        ],
    })
    const inspected = await client.devInspectTransactionBlock({
        sender: sender || principal,
        transactionBlock: tx,
    })
    const status = inspected.effects?.status?.status
    if (inspected.error || (status && status !== 'success')) {
        const detail = inspected.error ?? inspected.effects?.status?.error
        throw new Error(typeof detail === 'string' ? detail : 'permissions lookup failed')
    }
    return permissionFlags(decodeReturnU8(inspected))
}

export async function generateAndWrapNamespaceDek(opts: {
    suiClient: unknown
    namespaceId: string
    keyVersion?: bigint
}): Promise<Uint8Array> {
    const { wrappedDek } = await sdkGenerateAndWrapNamespaceDek({
        packageId: config.v2PackageId,
        namespaceId: opts.namespaceId,
        keyVersion: opts.keyVersion ?? 0n,
        threshold: v2SealThreshold(),
        sealServerConfigs: v2SealServerConfigs(),
        suiClient: opts.suiClient,
        suiNetwork: config.suiNetwork,
    })
    return wrappedDek
}

export async function createV2Namespace(opts: {
    suiClient: unknown
    walletSigner: WalletSignerLike
    accountId: string
    label: string
}): Promise<{ namespaceId: string; digest: string }> {
    return createNamespace({
        ...sdkTxOpts(opts.accountId, opts.walletSigner, opts.suiClient),
        label: opts.label,
    })
}

export async function initializeV2NamespaceKey(opts: {
    suiClient: unknown
    walletSigner: WalletSignerLike
    accountId: string
    namespaceId: string
    wrappedDek: Uint8Array
}): Promise<{ digest: string }> {
    return initializeKey({
        ...sdkTxOpts(opts.accountId, opts.walletSigner, opts.suiClient),
        namespaceId: opts.namespaceId,
        wrappedDek: opts.wrappedDek,
    })
}

export async function grantV2NamespaceAccess(opts: {
    suiClient: unknown
    walletSigner: WalletSignerLike
    accountId: string
    namespaceId: string
    principal: string
    bits: GrantBits
}): Promise<{ digest: string }> {
    const bits = grantBitsFromCheckboxes({
        read: opts.bits.canRead,
        write: opts.bits.canWrite,
        share: opts.bits.canShare,
    })
    const invalid = validateGrantBits(bits)
    if (invalid) throw new Error(invalid)
    if (!isValidSuiAddress(opts.principal)) throw new Error('Enter a valid Sui address')
    const blocked = sharePrincipalBlockedReason(opts.principal, opts.walletSigner.address)
    if (blocked) throw new Error(blocked)

    return grantAccess({
        ...sdkTxOpts(opts.accountId, opts.walletSigner, opts.suiClient),
        namespaceId: opts.namespaceId,
        principal: normalizeSuiAddress(opts.principal),
        canRead: bits.canRead,
        canWrite: bits.canWrite,
        canShare: bits.canShare,
    })
}

export async function cancelV2UninitializedNamespace(opts: {
    suiClient: unknown
    walletSigner: WalletSignerLike
    accountId: string
    namespaceId: string
}): Promise<{ digest: string }> {
    return cancelUninitializedNamespace({
        ...sdkTxOpts(opts.accountId, opts.walletSigner, opts.suiClient),
        namespaceId: opts.namespaceId,
    })
}
