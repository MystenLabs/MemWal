import { render, screen } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
    address: '0xowner',
    accountId: null as string | null,
}))

vi.mock('./config', () => ({
    config: {
        memwalRegistryId: '0xreg',
    },
}))
vi.mock('@mysten/dapp-kit', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@mysten/dapp-kit')>()
    return {
        ...actual,
        useCurrentAccount: () => ({ address: mocks.address }),
        useSuiClient: () => ({}),
    }
})
vi.mock('./utils/suiClientCompat', () => ({
    fetchAccountIdForOwner: vi.fn(() => Promise.resolve(mocks.accountId)),
}))

import { PostAuthAccountCheck } from './App'

function renderAt() {
    return render(
        <MemoryRouter initialEntries={['/']}>
            <Routes>
                <Route path="/" element={<PostAuthAccountCheck />} />
                <Route path="/setup" element={<div>SETUP</div>} />
                <Route path="/dashboard" element={<div>DASHBOARD</div>} />
            </Routes>
        </MemoryRouter>,
    )
}

describe('PostAuthAccountCheck', () => {
    beforeEach(() => {
        mocks.accountId = null
    })

    it('routes a brand-new account (no on-chain Account object) to /setup', async () => {
        mocks.accountId = null
        renderAt()
        expect(await screen.findByText('SETUP')).toBeInTheDocument()
    })

    it('routes an existing account to /dashboard', async () => {
        mocks.accountId = '0xaccount'
        renderAt()
        expect(await screen.findByText('DASHBOARD')).toBeInTheDocument()
    })
})
