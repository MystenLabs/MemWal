/**
 * V2 namespace helpers for the dashboard/playground slice.
 */

import {
    createNamespace,
    generateAndWrapNamespaceDek as sdkGenerateAndWrapNamespaceDek,
    grantAccess,
    initializeKey,
    namespaceSealKeyId as sdkNamespaceSealKeyId,
} from '@mysten-incubation/memwal/account'
import type { WalletSigner } from '@mysten-incubation/memwal/manual'
import { Ed25519PublicKey } from '@mysten/sui/keypairs/ed25519'
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

const MAX_EVENT_PAGES = 8
const EVENT_PAGE_SIZE = 50

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

type EventsClient = {
    queryEvents: (input: {
        query: { MoveEventType: string }
        cursor?: unknown
        limit?: number
        order?: 'ascending' | 'descending'
    }) => Promise<{
        data: Array<{ parsedJson?: Record<string, unknown> | null; json?: Record<string, unknown> | null }>
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

export function validateNamespaceLabel(label: string): string | null {
    if (!label) return 'Namespace label cannot be empty'
    if (label.length > NAMESPACE_LABEL_MAX_LENGTH) {
        return 'Namespace label must be 64 characters or fewer'
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

export function v2SealServerConfigs(): Array<{ objectId: string; weight: number }> {
    const ids = config.sealKeyServers.length > 0
        ? [...config.sealKeyServers]
        : DEFAULT_SEAL_SERVERS[config.suiNetwork]
    return ids.map((objectId) => ({ objectId, weight: 1 }))
}

export function v2SealThreshold(): number {
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

export async function listOwnedV2Namespaces(suiClient: unknown, owner: string): Promise<V2NamespaceRow[]> {
    if (!config.v2PackageId || !owner) return []
    const client = suiClient as Partial<EventsClient>
    if (typeof client.queryEvents !== 'function') {
        throw new Error('This Sui client cannot query events; namespace listing needs JSON-RPC')
    }
    const ownerNormalized = normalizeSuiAddress(owner)
    const ids: string[] = []
    const seen = new Set<string>()
    let cursor: unknown
    for (let page = 0; page < MAX_EVENT_PAGES; page++) {
        const response = await client.queryEvents({
            query: { MoveEventType: `${config.v2PackageId}::namespace::NamespaceCreated` },
            limit: EVENT_PAGE_SIZE,
            order: 'descending',
            cursor,
        })
        for (const event of response.data) {
            const parsed = event.parsedJson ?? event.json ?? {}
            const eventOwner = typeof parsed.owner === 'string' ? parsed.owner : ''
            if (!eventOwner || normalizeSuiAddress(eventOwner) !== ownerNormalized) continue
            const id = asObjectId(parsed.namespace_id)
            if (!id || seen.has(id)) continue
            seen.add(id)
            ids.push(id)
        }
        if (!response.hasNextPage) break
        cursor = response.nextCursor
        if (cursor == null) break
    }

    const rows: Array<V2NamespaceRow | null> = await Promise.all(ids.map(async (id) => {
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
            owner: typeof fields.owner === 'string' ? fields.owner : owner,
            accountId: asObjectId(fields.account_id),
        }
    }))
    return rows.filter((row): row is V2NamespaceRow => row != null)
}

function decodeReturnU8(result: Awaited<ReturnType<InspectClient['devInspectTransactionBlock']>>): number {
    const bytes = result.results?.[0]?.returnValues?.[0]?.[0]
    if (!bytes) throw new Error('permissions view returned no value')
    return Number(bytes[0] ?? 0)
}

export async function lookupNamespacePermissions(
    suiClient: unknown,
    namespaceId: string,
    principal: string,
    sender: string,
): Promise<GrantBits> {
    if (!isValidSuiAddress(principal)) throw new Error('Enter a valid Sui address')
    const client = suiClient as Partial<InspectClient>
    if (typeof client.devInspectTransactionBlock !== 'function') {
        throw new Error('This Sui client cannot inspect view calls')
    }
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

    return grantAccess({
        ...sdkTxOpts(opts.accountId, opts.walletSigner, opts.suiClient),
        namespaceId: opts.namespaceId,
        principal: normalizeSuiAddress(opts.principal),
        canRead: bits.canRead,
        canWrite: bits.canWrite,
        canShare: bits.canShare,
    })
}
