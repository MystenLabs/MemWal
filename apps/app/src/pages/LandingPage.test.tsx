import { render } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
    currentAccount: null as { address: string } | null,
    navigate: vi.fn(),
}))

vi.mock('../config', () => ({
    config: {
        enokiApiKey: '',
        googleClientId: '',
        termsOfServiceUrl: 'https://example.com/tos',
        privacyPolicyUrl: 'https://example.com/privacy',
    },
}))
vi.mock('../utils/analytics', () => ({
    trackEvent: vi.fn(),
}))
vi.mock('@mysten/dapp-kit', () => ({
    ConnectButton: () => null,
    useConnectWallet: () => ({ mutate: vi.fn() }),
    useCurrentAccount: () => mocks.currentAccount,
    useWallets: () => [],
}))
vi.mock('@mysten/enoki', () => ({
    isEnokiWallet: () => false,
}))
vi.mock('react-router-dom', async (importOriginal) => {
    const actual = await importOriginal<typeof import('react-router-dom')>()
    return { ...actual, useNavigate: () => mocks.navigate }
})

import LandingPage from './LandingPage'

// A wallet connect (Slush etc.) resolves in-page — no OAuth redirect through
// "/" — so this effect is the only place that can route a fresh wallet
// sign-in onward. It must go through "/" (PostAuthRedirect), not hardcode
// /dashboard, or new-account detection never runs for this path (Nikola's
// finding on WALM-675's PR #1003).
describe('LandingPage', () => {
    beforeEach(() => {
        mocks.currentAccount = null
        mocks.navigate.mockClear()
    })

    it('routes through "/" instead of hardcoding /dashboard once a wallet connects', () => {
        const { rerender } = render(
            <MemoryRouter initialEntries={['/']}>
                <LandingPage />
            </MemoryRouter>,
        )
        expect(mocks.navigate).not.toHaveBeenCalled()

        mocks.currentAccount = { address: '0xnewwallet' }
        rerender(
            <MemoryRouter initialEntries={['/']}>
                <LandingPage />
            </MemoryRouter>,
        )

        expect(mocks.navigate).toHaveBeenCalledWith('/')
        expect(mocks.navigate).not.toHaveBeenCalledWith('/dashboard')
    })
})
