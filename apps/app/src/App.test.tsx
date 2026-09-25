import { render, screen } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
    address: '0xowner',
    accountId: null as string | null,
    rejectWith: null as Error | null,
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
    fetchAccountIdForOwner: vi.fn(() =>
        mocks.rejectWith ? Promise.reject(mocks.rejectWith) : Promise.resolve(mocks.accountId),
    ),
}))

import { PostAuthAccountCheck, PostAuthRedirect } from './App'

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

function renderPostAuthRedirect() {
    return render(
        <MemoryRouter initialEntries={['/']}>
            <Routes>
                <Route path="/" element={<PostAuthRedirect />} />
                <Route path="/setup" element={<div>SETUP</div>} />
                <Route path="/dashboard" element={<div>DASHBOARD</div>} />
            </Routes>
        </MemoryRouter>,
    )
}

describe('PostAuthAccountCheck', () => {
    beforeEach(() => {
        mocks.accountId = null
        mocks.rejectWith = null
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

    it('falls back to /dashboard when the lookup itself fails (transport error)', async () => {
        mocks.rejectWith = new Error('connection refused')
        renderAt()
        expect(await screen.findByText('DASHBOARD')).toBeInTheDocument()
    })
})

describe('PostAuthRedirect — /setup breadcrumb (Thanos, WALM-675 scope)', () => {
    const SETUP_CONNECT_STORAGE_KEY = 'memwal_setup_connect'

    beforeEach(() => {
        sessionStorage.clear()
        mocks.accountId = '0xaccount'
        mocks.rejectWith = null
    })

    it('resumes /setup when a signed-out visit left the breadcrumb, over the account-existence guess', async () => {
        sessionStorage.setItem(SETUP_CONNECT_STORAGE_KEY, '1')
        renderPostAuthRedirect()
        expect(await screen.findByText('SETUP')).toBeInTheDocument()
        expect(sessionStorage.getItem(SETUP_CONNECT_STORAGE_KEY)).toBeNull()
    })

    it('falls through to the account-existence check with no breadcrumb', async () => {
        mocks.accountId = '0xaccount'
        renderPostAuthRedirect()
        expect(await screen.findByText('DASHBOARD')).toBeInTheDocument()
    })
})
