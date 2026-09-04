import { expect, it } from 'vitest'
import { toHex } from '@mysten/sui/utils'
import {
    compactObjectId,
    grantBitsFromCheckboxes,
    isCurrentAccountDelegate,
    NAMESPACE_LABEL_MAX_LENGTH,
    namespaceSealKeyId,
    normalizeLabelForSubmit,
    permissionFlags,
    PERMISSION_READ,
    PERMISSION_SHARE,
    PERMISSION_WRITE,
    principalsToGrant,
    sanitizeLabelInput,
    validateGrantBits,
    validateNamespaceLabel,
} from './v2Namespace'

it('strips HTML and control characters from labels', () => {
    expect(sanitizeLabelInput('team<script>\u0000>')).toBe('teamscript')
    expect(sanitizeLabelInput('work / home')).toBe('work  home')
    expect(normalizeLabelForSubmit('  notes  ')).toBe('notes')
})

it('rejects empty and over-long namespace labels', () => {
    expect(validateNamespaceLabel('')).toBe('Namespace label cannot be empty')
    expect(validateNamespaceLabel('a'.repeat(NAMESPACE_LABEL_MAX_LENGTH))).toBeNull()
    expect(validateNamespaceLabel('a'.repeat(NAMESPACE_LABEL_MAX_LENGTH + 1))).toBe(
        'Namespace label must be 64 characters or fewer',
    )
})

it('WRITE and SHARE imply READ when mapping grant bits', () => {
    expect(grantBitsFromCheckboxes({ read: false, write: true, share: false })).toEqual({
        canRead: true,
        canWrite: true,
        canShare: false,
    })
    expect(grantBitsFromCheckboxes({ read: false, write: false, share: true })).toEqual({
        canRead: true,
        canWrite: false,
        canShare: true,
    })
    expect(grantBitsFromCheckboxes({ read: true, write: false, share: false })).toEqual({
        canRead: true,
        canWrite: false,
        canShare: false,
    })
    expect(validateGrantBits(grantBitsFromCheckboxes({ read: false, write: false, share: false }))).toMatch(/Read or Write/)
})

it('decodes on-chain permission flags', () => {
    expect(permissionFlags(PERMISSION_READ | PERMISSION_WRITE)).toEqual({
        canRead: true,
        canWrite: true,
        canShare: false,
    })
    expect(permissionFlags(PERMISSION_READ | PERMISSION_SHARE)).toEqual({
        canRead: true,
        canWrite: false,
        canShare: true,
    })
})

it('matches Move golden seal-id tails (40 bytes, little-endian key version)', () => {
    const namespaceId = '0xcafe'
    expect(toHex(namespaceSealKeyId(namespaceId, 1n))).toBe(
        '000000000000000000000000000000000000000000000000000000000000cafe0100000000000000',
    )
    expect(toHex(namespaceSealKeyId(namespaceId, 10000n))).toBe(
        '000000000000000000000000000000000000000000000000000000000000cafe1027000000000000',
    )
    expect(namespaceSealKeyId(namespaceId, 1n)).toHaveLength(40)
})

it('grants skip the owner, zero address, and duplicates', () => {
    const owner = '0x' + '11'.repeat(32)
    const writer = '0x' + '22'.repeat(32)
    const delegate = '0x' + '22'.repeat(32)
    expect(principalsToGrant([writer, '0x0', owner], delegate, owner)).toEqual([
        '0x' + '22'.repeat(32),
    ])
})

it('treats only current account delegates as share-eligible', () => {
    const delegate = '0x' + 'ab'.repeat(32)
    expect(isCurrentAccountDelegate(delegate, [delegate])).toBe(true)
    expect(isCurrentAccountDelegate('0x' + 'cd'.repeat(32), [delegate])).toBe(false)
    expect(isCurrentAccountDelegate('not-an-address', [delegate])).toBe(false)
})

it('compacts object ids for display', () => {
    const id = '0x' + 'ab'.repeat(32)
    expect(compactObjectId(id).startsWith('0xabababab')).toBe(true)
    expect(compactObjectId(id).includes('...')).toBe(true)
})
