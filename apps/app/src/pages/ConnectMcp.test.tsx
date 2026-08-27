import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
    address: '0xowner',
    accountId: '0xaccount',
    signAndExecute: vi.fn(),
}))

vi.mock('../config', () => ({
    config: {
        memwalServerUrl: 'https://relayer.test',
        memwalPackageId: '0xpkg',
        memwalRegistryId: '0xreg',
        suiNetwork: 'testnet',
        docsUrl: 'https://docs.test',
    },
}))
vi.mock('@mysten/dapp-kit', () => ({
    ConnectModal: () => null,
    useCurrentAccount: () => ({ address: mocks.address }),
    useSuiClient: () => ({ waitForTransaction: vi.fn().mockResolvedValue({}) }),
}))
vi.mock('../hooks/useSponsoredTransaction', () => ({
    useSponsoredTransaction: () => ({ mutateAsync: mocks.signAndExecute }),
}))
vi.mock('../utils/suiClientCompat', () => ({
    fetchAccountIdForOwner: vi.fn().mockResolvedValue(mocks.accountId),
}))
vi.mock('../utils/analytics', () => ({
    trackEvent: vi.fn(),
    getAnalyticsErrorType: () => 'unknown',
}))

import ConnectMcp from './ConnectMcp'

const PORT = '38291'
const PUBLIC_KEY = 'a'.repeat(64)
const STATE = 'b'.repeat(64)
const RELAYER = 'https://relayer.test'

/** Answers the page's `/preflight` so it reaches consent, then applies
 * `callback` to the `/callback` POST that decides the outcome under test. */
function stubListener(callback: () => Promise<Response>) {
    vi.stubGlobal(
        'fetch',
        vi.fn(async (input: RequestInfo | URL) => {
            const url = String(input)
            if (url.endsWith('/preflight')) {
                return new Response(
                    JSON.stringify({ ok: true, publicKey: PUBLIC_KEY, label: 'Claude Code', relayer: RELAYER }),
                    { status: 200, headers: { 'content-type': 'application/json' } },
                )
            }
            if (url.endsWith('/callback')) return callback()
            throw new Error(`unexpected fetch: ${url}`)
        }),
    )
}

async function signIn() {
    const query = `?port=${PORT}&publicKey=${PUBLIC_KEY}&relayer=${encodeURIComponent(RELAYER)}&connectState=${STATE}`
    render(
        <MemoryRouter initialEntries={[`/connect/mcp${query}`]}>
            <ConnectMcp />
        </MemoryRouter>,
    )
    const approve = await screen.findByRole('button', { name: /approve in wallet/i })
    await userEvent.click(approve)
}

beforeEach(() => {
    vi.clearAllMocks()
    mocks.signAndExecute.mockResolvedValue({ digest: '0xdigest' })
})

describe('MCP sign-in hand-off', () => {
    it('confirms the connection when the listener accepts the callback', async () => {
        stubListener(async () => new Response('{}', { status: 200 }))
        await signIn()

        expect(await screen.findByText(/MCP client connected/i)).toBeInTheDocument()
        expect(screen.getByText(/handed off to your MCP client/i)).toBeInTheDocument()
    })

    it('offers the one-time setup once the client is connected', async () => {
        stubListener(async () => new Response('{}', { status: 200 }))
        await signIn()

        expect(await screen.findByText(/MCP client connected/i)).toBeInTheDocument()
        expect(screen.getByText(/Required: one-time setup/i)).toBeInTheDocument()
        expect(screen.getByText(/without asking for confirmation/i)).toBeInTheDocument()
        expect(screen.getByText(/Instructions for Claude/i)).toBeInTheDocument()
        expect(screen.getAllByText(/Always allow/i).length).toBeGreaterThanOrEqual(1)
        expect(screen.getByRole('link', { name: /memory\.walrus\.xyz/i })).toHaveAttribute(
            'href',
            'https://memory.walrus.xyz',
        )
        expect(screen.getByRole('button', { name: /copy instruction/i })).toBeInTheDocument()
    })

    it('withholds the one-time setup when the hand-off never landed', async () => {
        stubListener(async () => {
            throw new TypeError('Failed to fetch')
        })
        await signIn()

        expect(await screen.findByText(/Almost there/i)).toBeInTheDocument()
        expect(screen.queryByRole('button', { name: /copy instruction/i })).not.toBeInTheDocument()
    })

    it('does not claim success when nothing answers on localhost', async () => {
        stubListener(async () => {
            throw new TypeError('Failed to fetch')
        })
        await signIn()

        expect(await screen.findByText(/Almost there/i)).toBeInTheDocument()
        expect(screen.queryByText(/MCP client connected/i)).not.toBeInTheDocument()
        expect(screen.getByText(/Nothing answered on your computer/i)).toBeInTheDocument()
        expect(screen.getByText(/stopped waiting after this tab was already open/i)).toBeInTheDocument()
        expect(screen.queryByText(/opened too late/i)).not.toBeInTheDocument()
        expect(screen.getByText(/Sign in again and open the new link straight away/i)).toBeInTheDocument()
        expect(screen.getByText(/left running through the wallet prompt/i)).toBeInTheDocument()
        expect(screen.getByText(/unused key from this attempt is already on your account/i)).toBeInTheDocument()
        expect(screen.queryByText(/usually works/i)).not.toBeInTheDocument()
    })

    it('explains an expired link when preflight cannot reach the listener', async () => {
        vi.stubGlobal(
            'fetch',
            vi.fn(async (input: RequestInfo | URL) => {
                const url = String(input)
                if (url.endsWith('/preflight')) throw new TypeError('Failed to fetch')
                throw new Error(`unexpected fetch: ${url}`)
            }),
        )
        const query = `?port=${PORT}&publicKey=${PUBLIC_KEY}&relayer=${encodeURIComponent(RELAYER)}&connectState=${STATE}`
        render(
            <MemoryRouter initialEntries={[`/connect/mcp${query}`]}>
                <ConnectMcp />
            </MemoryRouter>,
        )

        expect(await screen.findByText(/opened too late/i)).toBeInTheDocument()
        expect(screen.getByText(/Something went wrong/i)).toBeInTheDocument()
        expect(screen.queryByText(/Almost there/i)).not.toBeInTheDocument()
    })

    it('tells a refused hand-off apart from an absent one', async () => {
        stubListener(async () => new Response('nope', { status: 409 }))
        await signIn()

        expect(await screen.findByText(/Almost there/i)).toBeInTheDocument()
        expect(screen.queryByText(/MCP client connected/i)).not.toBeInTheDocument()
        expect(await screen.findByText(/rejected this hand-off/i)).toBeInTheDocument()
        expect(screen.queryByText(/Nothing answered on your computer/i)).not.toBeInTheDocument()
    })

    it('keeps the key reassuring and links troubleshooting on failure', async () => {
        stubListener(async () => {
            throw new TypeError('Failed to fetch')
        })
        await signIn()

        expect(await screen.findByText(/first half of sign-in succeeded/i)).toBeInTheDocument()
        expect(screen.getByRole('link', { name: /troubleshooting/i })).toHaveAttribute(
            'href',
            'https://docs.test/troubleshooting/overview#sign-in-succeeds-but-credentials-are-not-saved',
        )
    })
})
