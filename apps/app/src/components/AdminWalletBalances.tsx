import { useEffect } from 'react'
import { useQuery } from '@tanstack/react-query'
import { RefreshCw } from 'lucide-react'
import { Card } from './Card'
import { fetchAdminWallets, formatTokenAmount, type AdminWalletsResponse } from '../utils/admin-api'

interface AdminWalletBalancesProps {
  adminKey: string
  onInvalidKey: () => void
}

function abbreviateAddress(address: string): string {
  if (address.length <= 22) return address
  return `${address.slice(0, 6)}...${address.slice(-4)}`
}

function getStatusBadgeColor(status: string): string {
  switch (status) {
    case 'healthy':
      return '#4ade80'
    case 'warning':
      return '#fbbf24'
    case 'critical':
      return '#ff8f8f'
    default:
      return '#8f9294'
  }
}

function formatBalance(balance: bigint, symbol: string): string {
  return `${formatTokenAmount(balance)} ${symbol}`
}

export function AdminWalletBalances({ adminKey, onInvalidKey }: AdminWalletBalancesProps) {
  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ['adminWallets', adminKey],
    queryFn: () => fetchAdminWallets(adminKey),
    refetchInterval: 30000,
    retry: (failureCount, error) => {
      const err = error as Error
      return err.message !== 'INVALID_KEY' && failureCount < 3
    },
  })

  const isInvalidKey = error instanceof Error && error.message === 'INVALID_KEY'

  useEffect(() => {
    if (isInvalidKey) onInvalidKey()
  }, [isInvalidKey, onInvalidKey])

  if (isLoading) {
    return (
      <Card title="Wallet Balances" className="admin-wallets-card">
        <div className="admin-loading">Loading wallet data...</div>
      </Card>
    )
  }

  if (error) {
    return (
      <Card title="Wallet Balances" className="admin-wallets-card">
        <div className="admin-error">
          {isInvalidKey ? 'Invalid API key — signing out...' : 'Failed to load wallets'}
        </div>
      </Card>
    )
  }

  const response = data as AdminWalletsResponse

  return (
    <div className="admin-wallets-section">
      <Card
        title="Uploader Pool Wallets"
        className="admin-wallets-card"
        action={
          <button
            onClick={() => refetch()}
            className="admin-refresh-btn"
            title="Refresh wallet data"
            disabled={isLoading}
          >
            <RefreshCw size={16} />
            Refresh Now
          </button>
        }
      >
        <div className="admin-table-wrapper">
          <table className="admin-table">
            <thead>
              <tr>
                <th scope="col">Address</th>
                <th scope="col" style={{ textAlign: 'right' }}>SUI</th>
                <th scope="col" style={{ textAlign: 'right' }}>WAL</th>
                <th scope="col">Status</th>
              </tr>
            </thead>
            <tbody>
              {response.uploaderPoolWallets.map((wallet) => (
                <tr key={wallet.address} className="admin-table-row">
                  <td title={wallet.address} className="admin-table-monospace">
                    {abbreviateAddress(wallet.address)}
                  </td>
                  <td style={{ textAlign: 'right' }} className="admin-table-monospace" title={`${wallet.suiBalance} mist`}>
                    {formatBalance(wallet.suiBalance, 'SUI')}
                  </td>
                  <td style={{ textAlign: 'right' }} className="admin-table-monospace" title={`${wallet.walBalance} frost`}>
                    {formatBalance(wallet.walBalance, 'WAL')}
                  </td>
                  <td>
                    <span
                      className="admin-status-badge"
                      style={{ color: getStatusBadgeColor(wallet.status) }}
                    >
                      {wallet.status}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="admin-timestamp">
          Last updated: {new Date(response.lastUpdated).toLocaleString()}
        </div>
      </Card>

      <Card title="Sponsor Wallet" className="admin-sponsor-card">
        <div className="admin-sponsor-content">
          <div className="admin-sponsor-item">
            <span className="admin-sponsor-label">Address</span>
            <code className="admin-sponsor-value" title={response.sponsorWallet.address}>
              {abbreviateAddress(response.sponsorWallet.address)}
            </code>
          </div>

          <div className="admin-sponsor-item">
            <span className="admin-sponsor-label">SUI Balance</span>
            <code className="admin-sponsor-value" title={`${response.sponsorWallet.suiBalance} mist`}>
              {formatBalance(response.sponsorWallet.suiBalance, 'SUI')}
            </code>
          </div>

          <div className="admin-sponsor-item">
            <span className="admin-sponsor-label">SUI Threshold</span>
            <code className="admin-sponsor-value" title={`${response.sponsorWallet.suiThreshold} mist`}>
              {formatBalance(response.sponsorWallet.suiThreshold, 'SUI')}
            </code>
          </div>

          <div className="admin-sponsor-item">
            <span className="admin-sponsor-label">Status</span>
            <span
              className="admin-status-badge"
              style={{ color: getStatusBadgeColor(response.sponsorWallet.status) }}
            >
              {response.sponsorWallet.status}
            </span>
          </div>
        </div>
      </Card>
    </div>
  )
}
