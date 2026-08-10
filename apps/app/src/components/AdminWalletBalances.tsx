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

function formatBalance(balance: bigint, symbol: string): string {
  return `${formatTokenAmount(balance)} ${symbol}`
}

export function AdminWalletBalances({ adminKey, onInvalidKey }: AdminWalletBalancesProps) {
  const { data, isLoading, isFetching, error, refetch } = useQuery({
    queryKey: ['admin', 'wallets'],
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
      <Card title="Wallet Balances" className="dashboard-keys-card admin-wallets-card">
        <div className="admin-loading">Loading wallet data...</div>
      </Card>
    )
  }

  if (error) {
    return (
      <Card title="Wallet Balances" className="dashboard-keys-card admin-wallets-card">
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
        className="dashboard-keys-card admin-wallets-card"
        action={
          <div className="card-header-actions">
            <button
              onClick={() => refetch()}
              className="btn btn-secondary btn-sm dashboard-keys-refresh admin-refresh-btn"
              title="Refresh wallet data"
              disabled={isFetching}
            >
              <RefreshCw size={12} />
              Refresh
            </button>
          </div>
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
              {response.uploaderPoolWallets.length === 0 ? (
                <tr>
                  <td colSpan={4} className="admin-table-empty">
                    No uploader wallets reported
                  </td>
                </tr>
              ) : response.uploaderPoolWallets.map((wallet) => (
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
                    <span className={`admin-status-badge admin-status-badge--${wallet.status}`}>
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

      <Card title="Sponsor Wallet" className="dashboard-keys-card admin-sponsor-card">
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
            <span className={`admin-status-badge admin-status-badge--${response.sponsorWallet.status}`}>
              {response.sponsorWallet.status}
            </span>
          </div>
        </div>
      </Card>
    </div>
  )
}
