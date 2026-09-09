/**
 * WALM-605 recovery path.
 *
 * A Sui outage during `POST /complete` leaves the authorization session
 * `pending` instead of burning it. That only helps if the consent UI can
 * re-send *that one request*: re-running the whole flow would re-submit
 * `add_delegate_key` for a key already on chain, which aborts with code 0 and
 * surfaces as a misleading "not the owner".
 */
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
    address: '0xowner',
    accountId: '0xaccount',
    signAndExecute: vi.fn(),
    signPersonalMessage: vi.fn(),
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
    useSignPersonalMessage: () => ({ mutateAsync: mocks.signPersonalMessage }),
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

import ConnectClaude from './ConnectClaude'

const SESSION = `mws_${'a'.repeat(24)}`

function json(body: unknown, status = 200) {
    return new Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json' },
    })
}

const SESSION_VIEW = {
    client_name: 'Claude',
    redirect_host: 'claude.ai',
    scopes: ['memory.read'],
    delegate_public_key: 'ab'.repeat(32),
    delegate_sui_address: '0xdelegate',
    expires_at: new Date(Date.now() + 600_000).toISOString(),
}

/**
 * Serves the session GET and the `/account` preflight, and hands each
 * `/complete` POST to the next entry of `completeResponses`. Returns a counter
 * of how many times each endpoint was called.
 */
function stubRelayer(completeResponses: (() => Response)[]) {
    const calls = { account: 0, complete: 0 }
    vi.stubGlobal(
        'fetch',
        vi.fn(async (input: RequestInfo | URL) => {
            const url = String(input)
            if (url.endsWith(`/session/${SESSION}`)) return json(SESSION_VIEW)
            if (url.endsWith('/account')) {
                calls.account += 1
                // Reused delegate: no add_delegate_key transaction is needed,
                // so the test isolates the /complete round-trip.
                return json({
                    needs_onchain_registration: false,
                    delegate_public_key: SESSION_VIEW.delegate_public_key,
                    delegate_sui_address: SESSION_VIEW.delegate_sui_address,
                })
            }
            if (url.endsWith('/complete')) {
                const next = completeResponses[calls.complete] ?? completeResponses.at(-1)
                calls.complete += 1
                return next!()
            }
            throw new Error(`unexpected fetch: ${url}`)
        }),
    )
    return calls
}

async function approve() {
    render(
        <MemoryRouter initialEntries={[`/connect/claude?session=${SESSION}`]}>
            <ConnectClaude />
        </MemoryRouter>,
    )
    await userEvent.click(await screen.findByRole('button', { name: 'Approve' }))
}

beforeEach(() => {
    vi.clearAllMocks()
    mocks.signPersonalMessage.mockResolvedValue({ signature: 'sig' })
    // jsdom refuses a real navigation; the page only needs the call to not throw.
    vi.stubGlobal('location', { ...window.location, replace: vi.fn() })
})

describe('ConnectClaude /complete recovery', () => {
    it('offers a retry of /complete alone when Sui is unavailable', async () => {
        const calls = stubRelayer([
            () =>
                json(
                    {
                        error: 'temporarily_unavailable',
                        error_description: 'could not verify the delegate key on-chain right now',
                    },
                    503,
                ),
            () => json({ redirect_url: 'https://claude.ai/callback?code=abc' }),
        ])

        await approve()

        // Not the terminal error state: the session is still pending.
        const retry = await screen.findByRole('button', { name: /finish connecting/i })
        expect(screen.queryByText('Something went wrong')).toBeNull()

        await userEvent.click(retry)

        await waitFor(() => expect(calls.complete).toBe(2))
        // The retry re-sent /complete only — no second preflight, so no second
        // add_delegate_key submission.
        expect(calls.account).toBe(1)
        expect(mocks.signAndExecute).not.toHaveBeenCalled()
        await screen.findByText(/Redirecting you back/)
    })

    it('still fails terminally on a definitive rejection', async () => {
        stubRelayer([
            () =>
                json(
                    {
                        error: 'invalid_request',
                        error_description: 'delegate key is not registered on-chain',
                    },
                    400,
                ),
        ])

        await approve()

        await screen.findByText('Something went wrong')
        expect(screen.queryByRole('button', { name: /finish connecting/i })).toBeNull()
    })
})
