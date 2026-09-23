import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { describe, expect, it, vi } from 'vitest'
import ConnectWalrusMemory from './ConnectWalrusMemory'

vi.mock('../utils/analytics', () => ({
    trackEvent: vi.fn(),
}))

function renderPanel() {
    return render(
        <ConnectWalrusMemory path="agent" onPathChange={() => {}} hasDelegateKey={false} />,
    )
}

describe('ConnectWalrusMemory', () => {
    it('shows the Claude Code install lines from the design', () => {
        renderPanel()

        expect(screen.getByText(/claude plugin marketplace add https:\/\/github\.com\/MystenLabs\/MemWal\.git/)).toBeInTheDocument()
        expect(screen.getByText(/\/plugin marketplace add https:\/\/github\.com\/MystenLabs\/MemWal\.git/)).toBeInTheDocument()
        expect(screen.queryByText(/Plain text/)).not.toBeInTheDocument()
        expect(screen.getByText(/Or, inside Claude Code/)).toBeInTheDocument()
        expect(screen.queryByRole('link', { name: /view your memory in walrus console/i })).not.toBeInTheDocument()
        expect(screen.queryByRole('heading', { name: 'View your memories' })).not.toBeInTheDocument()
    })

    it('shows the Walrus Console promo only after its available date', () => {
        render(
            <ConnectWalrusMemory
                path="agent"
                onPathChange={() => {}}
                hasDelegateKey={false}
                consoleAvailable
            />,
        )

        expect(screen.getByRole('link', { name: /view your memory in walrus console/i })).toHaveAttribute('href', 'https://console.wal.app')
        expect(screen.getByRole('heading', { name: 'View your memories' })).toBeInTheDocument()
        expect(screen.getByRole('link', { name: /open walrus console/i })).toHaveAttribute('href', 'https://console.wal.app')
    })

    it('copies the Claude Code slash commands without a plain-text label', async () => {
        const user = userEvent.setup()
        const writeText = vi.spyOn(navigator.clipboard, 'writeText').mockResolvedValue(undefined)
        renderPanel()

        await user.click(screen.getByRole('button', { name: 'Copy Claude Code slash' }))

        const copied = writeText.mock.calls[0]?.[0]
        expect(copied).toBe([
            '/plugin marketplace add https://github.com/MystenLabs/MemWal.git',
            '/plugin install memwal@memwal-plugins',
        ].join('\n'))
        expect(copied).not.toContain('Plain text')
    })

    it('installs Cursor by copying the plugin, not a marketplace command', async () => {
        const user = userEvent.setup()
        renderPanel()

        await user.click(screen.getByRole('tab', { name: 'Cursor' }))

        const command = screen.getByRole('tabpanel').querySelector('code')
        expect(command?.textContent).toContain('npx -y degit MystenLabs/MemWal/packages/mcp/plugin ~/.cursor/plugins/local/memwal')
        expect(command?.textContent).not.toMatch(/plugin marketplace/i)
    })

    it('switches to the SDK install when connecting an app', async () => {
        const user = userEvent.setup()
        const onPathChange = vi.fn()
        render(
            <ConnectWalrusMemory path="agent" onPathChange={onPathChange} hasDelegateKey={false} />,
        )

        await user.click(screen.getByRole('button', { name: /connect an app/i }))

        expect(onPathChange).toHaveBeenCalledWith('app')
    })

    it('ends the app path with the playground and a place to paste an existing key', () => {
        render(
            <MemoryRouter>
                <ConnectWalrusMemory path="app" onPathChange={() => {}} hasDelegateKey={false} />
            </MemoryRouter>,
        )

        expect(screen.getByRole('heading', { name: 'Create a delegate key' })).toBeInTheDocument()
        expect(screen.getByLabelText('existing delegate key')).toBeInTheDocument()
        expect(screen.getByRole('link', { name: /open playground/i })).toHaveAttribute('href', '/playground')
    })
})
