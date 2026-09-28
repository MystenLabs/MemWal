import { SuiGrpcClient } from '@mysten/sui/grpc'
import { bcs } from '@mysten/sui/bcs'
import { afterEach, describe, expect, it, vi } from 'vitest'

import {
    fetchAccountIdForOwner,
    fetchObjectJson,
    findCreatedAccountId,
    isGrpcClient,
    isMissingObjectError,
    pollAccountIdForOwner,
    resetRegistryTableIdCache,
} from './suiClientCompat'

afterEach(() => {
    resetRegistryTableIdCache()
})

describe('gRPC Sui client compatibility', () => {
    it('uses the gRPC getObject request shape', async () => {
        const client = new SuiGrpcClient({ network: 'testnet', baseUrl: 'https://provider.example/grpc' })
        const getObject = vi.spyOn(client, 'getObject').mockResolvedValue({
            object: { json: { accounts: { id: '0xtable' } } },
        } as never)

        await expect(fetchObjectJson(client, '0xregistry')).resolves.toEqual({ accounts: { id: '0xtable' } })
        expect(isGrpcClient(client)).toBe(true)
        expect(getObject).toHaveBeenCalledWith({ objectId: '0xregistry', include: { json: true } })
    })

    it('encodes the address dynamic-field key as bytes', async () => {
        const client = new SuiGrpcClient({ network: 'testnet', baseUrl: 'https://provider.example/grpc' })
        vi.spyOn(client, 'getObject').mockResolvedValue({
            object: { json: { accounts: { id: '0xtable2' } } },
        } as never)
        const accountBytes = new Uint8Array(32).fill(0xab)
        const getDynamicField = vi.spyOn(client, 'getDynamicField').mockResolvedValue({
            dynamicField: { value: { bcs: accountBytes } },
        } as never)

        await expect(fetchAccountIdForOwner(client, '0xregistry2', '0x1')).resolves.toBe(`0x${'ab'.repeat(32)}`)
        expect(getDynamicField).toHaveBeenCalledOnce()
        const request = getDynamicField.mock.calls[0]![0]
        expect(request.parentId).toBe('0xtable2')
        expect(request.name.type).toBe('address')
        expect(request.name.bcs).toEqual(new Uint8Array(32).fill(0).map((_, i) => i === 31 ? 1 : 0))
    })

    it('returns null when gRPC getObject throws Object {id} not found', async () => {
        const objectId = `0x${'ab'.repeat(32)}`
        const client = new SuiGrpcClient({ network: 'testnet', baseUrl: 'https://provider.example/grpc' })
        vi.spyOn(client, 'getObject').mockRejectedValue(new Error(`Object ${objectId} not found`))

        await expect(fetchObjectJson(client, objectId)).resolves.toBeNull()
    })

    it('retries when gRPC getDynamicField throws Object {id} not found', async () => {
        const fieldId = `0x${'cd'.repeat(32)}`
        const accountBytes = new Uint8Array(32).fill(0x11)
        const client = new SuiGrpcClient({ network: 'testnet', baseUrl: 'https://provider.example/grpc' })
        vi.spyOn(client, 'getObject').mockResolvedValue({
            object: { json: { accounts: { id: '0xtable-grpc-miss' } } },
        } as never)
        let lookups = 0
        vi.spyOn(client, 'getDynamicField').mockImplementation(async () => {
            lookups += 1
            if (lookups < 3) throw new Error(`Object ${fieldId} not found`)
            return { dynamicField: { value: { bcs: accountBytes } } } as never
        })

        await expect(
            pollAccountIdForOwner(client, '0xregistry-grpc-df', '0x1', {
                attempts: 4,
                sleep: async () => undefined,
            }),
        ).resolves.toBe(`0x${'11'.repeat(32)}`)
        expect(lookups).toBe(3)
    })
})

describe('JSON-RPC registry lookup', () => {
    it('unwraps accounts.id.id before getDynamicFieldObject', async () => {
        const tableId = '0xtable'
        const accountId = '0xaccount'
        let requestedParentId: string | undefined
        const client = {
            async getObject() {
                return {
                    data: {
                        content: {
                            fields: {
                                accounts: {
                                    type: '0x2::table::Table<address, 0x2::object::ID>',
                                    fields: {
                                        id: { id: tableId },
                                        size: '1',
                                    },
                                },
                            },
                        },
                    },
                }
            },
            async getDynamicFieldObject({ parentId }: { parentId: string }) {
                requestedParentId = parentId
                return { data: { content: { fields: { value: accountId } } } }
            },
        }

        await expect(fetchAccountIdForOwner(client, '0xregistry-json', '0xowner')).resolves.toBe(accountId)
        expect(requestedParentId).toBe(tableId)
    })

    it('returns null instead of throwing a GetObject 404', async () => {
        const client = {
            async getObject() {
                throw Object.assign(new Error('Unexpected status code: 404 ()'), { status: 404 })
            },
        }

        await expect(fetchObjectJson(client, '0xmissing')).resolves.toBeNull()
        expect(isMissingObjectError(Object.assign(new Error('Unexpected status code: 404 ()'), { status: 404 }))).toBe(true)
    })

    it('returns null when the dynamic field 404s', async () => {
        const client = {
            async getObject() {
                return { data: { content: { fields: { accounts: { fields: { id: { id: '0xtable3' } } } } } } }
            },
            async getDynamicFieldObject() {
                throw Object.assign(new Error('Unexpected status code: 404 ()'), { status: 404 })
            },
        }

        await expect(fetchAccountIdForOwner(client, '0xregistry-404', '0xowner')).resolves.toBeNull()
    })

    it('retries a transient miss then returns the account id', async () => {
        let lookups = 0
        const client = {
            async getObject() {
                return { data: { content: { fields: { accounts: { fields: { id: { id: '0xtable4' } } } } } } }
            },
            async getDynamicFieldObject() {
                lookups += 1
                if (lookups < 3) {
                    throw Object.assign(new Error('Unexpected status code: 404 ()'), { status: 404 })
                }
                return { data: { content: { fields: { value: '0xaccount-ready' } } } }
            },
        }

        await expect(
            pollAccountIdForOwner(client, '0xregistry-retry', '0xowner', {
                attempts: 4,
                sleep: async () => undefined,
            }),
        ).resolves.toBe('0xaccount-ready')
        expect(lookups).toBe(3)
    })

    it('returns null on a gRPC Object {id} not found miss', async () => {
        const client = {
            async getObject() {
                throw new Error('Object 0xabc not found')
            },
        }

        await expect(fetchObjectJson(client, '0xabc')).resolves.toBeNull()
    })

    it('retries a gRPC Object {id} not found miss then returns the account id', async () => {
        let lookups = 0
        const client = {
            async getObject() {
                return { data: { content: { fields: { accounts: { fields: { id: { id: '0xtable5' } } } } } } }
            },
            async getDynamicFieldObject() {
                lookups += 1
                if (lookups < 3) {
                    throw new Error('Object 0xtable5 not found')
                }
                return { data: { content: { fields: { value: '0xaccount-grpc-ready' } } } }
            },
        }

        await expect(
            pollAccountIdForOwner(client, '0xregistry-grpc-retry', '0xowner', {
                attempts: 4,
                sleep: async () => undefined,
            }),
        ).resolves.toBe('0xaccount-grpc-ready')
        expect(lookups).toBe(3)
    })

    it('retries an unrecognized lookup throw instead of aborting on the first attempt', async () => {
        let lookups = 0
        const client = {
            async getObject() {
                return { data: { content: { fields: { accounts: { fields: { id: { id: '0xtable6' } } } } } } }
            },
            async getDynamicFieldObject() {
                lookups += 1
                if (lookups < 3) throw new Error('Could not load object')
                return { data: { content: { fields: { value: '0xaccount-unrecognized' } } } }
            },
        }

        await expect(
            pollAccountIdForOwner(client, '0xregistry-unrecognized', '0xowner', {
                attempts: 4,
                sleep: async () => undefined,
            }),
        ).resolves.toBe('0xaccount-unrecognized')
        expect(lookups).toBe(3)
    })

    it('rethrows a non-miss after the attempt budget is spent', async () => {
        const client = {
            async getObject() {
                throw new Error('ECONNRESET')
            },
        }

        await expect(
            pollAccountIdForOwner(client, '0xregistry-fatal', '0xowner', {
                attempts: 2,
                sleep: async () => undefined,
            }),
        ).rejects.toThrow('ECONNRESET')
    })
})

describe('isMissingObjectError', () => {
    it('treats HTTP 404 and notExists as a miss', () => {
        expect(isMissingObjectError(Object.assign(new Error('Unexpected status code: 404 ()'), { status: 404 }))).toBe(true)
        expect(isMissingObjectError(new Error('notExists'))).toBe(true)
        expect(isMissingObjectError(new Error('dynamicFieldNotFound'))).toBe(true)
        expect(isMissingObjectError(new Error('object not found'))).toBe(true)
        expect(isMissingObjectError(new Error('Object 0xabc not found'))).toBe(true)
        expect(isMissingObjectError(new Error(`Object 0x${'ab'.repeat(32)} not found`))).toBe(true)
        expect(isMissingObjectError(new Error('Object 0xabc with version 1 not found'))).toBe(true)
        expect(isMissingObjectError(new Error('Object 0xabc does not exist'))).toBe(true)
        expect(isMissingObjectError(new Error('Dynamic field not found for object 0xparent'))).toBe(true)
        expect(isMissingObjectError(Object.assign(new Error('Object 0xabc does not exist'), { code: 'notExists' }))).toBe(true)
        expect(isMissingObjectError(Object.assign(new Error('not found'), { code: 'NOT_FOUND' }))).toBe(true)
    })

    it('does not treat JSON-RPC Method not found as a missing object', () => {
        expect(
            isMissingObjectError(
                new Error('Method not found. JSON-RPC on public fullnodes has been deprecated.'),
            ),
        ).toBe(false)
        expect(isMissingObjectError(Object.assign(new Error('Method not found'), { code: -32601 }))).toBe(false)
    })
})

describe('findCreatedAccountId', () => {
    it('falls back to the AccountCreated event when objectChanges omit the account', () => {
        expect(
            findCreatedAccountId({
                objectChanges: [],
                events: [
                    {
                        type: '0xpackage::account::AccountCreated',
                        parsedJson: { account_id: '0xaccount-from-event' },
                    },
                ],
            }),
        ).toBe('0xaccount-from-event')
    })

    it('reads gRPC eventType + BCS AccountCreated', () => {
        const AccountCreatedBcs = bcs.struct('AccountCreated', {
            account_id: bcs.Address,
            owner: bcs.Address,
        })
        const accountId = `0x${'11'.repeat(32)}`
        const owner = `0x${'22'.repeat(32)}`
        const eventBcs = AccountCreatedBcs.serialize({ account_id: accountId, owner }).toBytes()

        expect(
            findCreatedAccountId({
                Transaction: {
                    events: [
                        {
                            eventType: '0xpackage::account::AccountCreated',
                            bcs: eventBcs,
                        },
                    ],
                },
            }),
        ).toBe(accountId)
    })

    it('reads gRPC created objects via objectTypes', () => {
        const accountId = '0xgrpc-account'
        expect(
            findCreatedAccountId({
                effects: {
                    changedObjects: [{ objectId: accountId, idOperation: 'Created' }],
                },
                objectTypes: { [accountId]: '0xpackage::account::MemWalAccount' },
            }),
        ).toBe(accountId)
    })
})

