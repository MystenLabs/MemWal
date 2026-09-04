import { render, screen } from '@testing-library/react'
import { beforeEach, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
    v2NamespacesEnabled: false,
    namespaces: [] as Array<{ id: string; label: string; active: boolean; keyVersion: number }>,
    v2AccountId: null as string | null,
    loading: false,
    error: '',
    refresh: vi.fn(),
}))

vi.mock('../config', () => ({
    config: {
        get v2NamespacesEnabled() { return mocks.v2NamespacesEnabled },
        v2PackageId: '0xpkg',
        v2RegistryId: '0xreg',
        v2NamespaceRegistryId: '0xnsreg',
        v2WriterAddresses: [],
        suiNetwork: 'testnet',
        sealKeyServers: [],
    },
}))

vi.mock('@mysten/dapp-kit', () => ({
    useCurrentAccount: () => ({ address: '0x' + '11'.repeat(32) }),
    useSuiClient: () => ({}),
    useSignPersonalMessage: () => ({ mutateAsync: vi.fn() }),
}))

vi.mock('../hooks/useSponsoredTransaction', () => ({
    useSponsoredTransaction: () => ({ mutateAsync: vi.fn() }),
}))

vi.mock('../App', () => ({
    useDelegateKey: () => ({ delegatePublicKey: 'aa'.repeat(32), delegateKey: 'bb'.repeat(32), accountObjectId: '0xacc' }),
}))

vi.mock('../hooks/useV2Namespaces', () => ({
    useV2Namespaces: () => ({
        namespaces: mocks.namespaces,
        v2AccountId: mocks.v2AccountId,
        delegateAddresses: [],
        loading: mocks.loading,
        error: mocks.error,
        refresh: mocks.refresh,
    }),
}))

import NamespacesSection from './NamespacesSection'

beforeEach(() => {
    mocks.v2NamespacesEnabled = false
    mocks.namespaces = []
    mocks.v2AccountId = null
    mocks.loading = false
    mocks.error = ''
})

it('renders nothing when V2 namespaces are disabled', () => {
    const { container } = render(<NamespacesSection />)
    expect(container).toBeEmptyDOMElement()
    expect(screen.queryByText('Namespaces')).not.toBeInTheDocument()
})

it('shows an English empty state when enabled and none exist', () => {
    mocks.v2NamespacesEnabled = true
    mocks.v2AccountId = '0xacc'
    render(<NamespacesSection />)
    expect(screen.getByText('Namespaces')).toBeInTheDocument()
    expect(screen.getByText(/No namespaces yet/)).toBeInTheDocument()
})
