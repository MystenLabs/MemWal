import { render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { ConsentCard } from './ConnectClaude'
import { SuccessCard } from './ConnectMcp'

const payload = {
    accountId: '0xaccount',
    walletAddress: '0xwallet',
    packageId: '0xpackage',
    txDigest: 'digest',
    label: 'Test MCP',
    state: 'state',
}

it('shows Custom Instructions only after local credential handoff succeeds', () => {
    const { rerender } = render(
        <MemoryRouter>
            <SuccessCard payload={payload} callbackDelivered={false} port="17463" />
        </MemoryRouter>,
    )

    expect(screen.queryByText('Enable proactive memory')).not.toBeInTheDocument()

    rerender(
        <MemoryRouter>
            <SuccessCard payload={payload} callbackDelivered={true} port="17463" />
        </MemoryRouter>,
    )

    expect(screen.getByText('Enable proactive memory')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Copy instructions' })).toBeInTheDocument()
})

it('shows proactive-write disclosure and instructions only for OAuth write scope', () => {
    const baseSession = {
        client_name: 'Claude',
        redirect_host: 'claude.ai',
        scopes: ['memwal:read'],
        delegate_public_key: 'public-key',
        delegate_sui_address: '0xdelegate',
        expires_at: '2026-08-18T00:00:00Z',
    }
    const props = {
        wallet: '0x1234567890abcdef',
        onConnect: () => {},
        onCancel: () => {},
    }
    const { rerender } = render(<ConsentCard session={baseSession} {...props} />)

    expect(screen.queryByText('Enable proactive memory')).not.toBeInTheDocument()
    expect(screen.queryByText(/Proactively save durable preferences/)).not.toBeInTheDocument()

    rerender(
        <ConsentCard
            session={{ ...baseSession, scopes: ['memwal:read', 'memwal:write'] }}
            {...props}
        />,
    )

    expect(screen.getByText('Enable proactive memory')).toBeInTheDocument()
    expect(screen.getByText(/Proactively save durable preferences/)).toBeInTheDocument()
})
