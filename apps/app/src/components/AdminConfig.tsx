import { useEffect } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Card } from './Card'
import { fetchAdminConfig, formatTokenAmount } from '../utils/admin-api'

interface AdminConfigProps {
  adminKey: string
  onInvalidKey: () => void
}

export function AdminConfig({ adminKey, onInvalidKey }: AdminConfigProps) {
  const { data, isLoading, error } = useQuery({
    queryKey: ['adminConfig', adminKey],
    queryFn: () => fetchAdminConfig(adminKey),
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
      <Card title="Configuration" className="admin-config-card">
        <div className="admin-loading">Loading configuration...</div>
      </Card>
    )
  }

  if (error) {
    return (
      <Card title="Configuration" className="admin-config-card">
        <div className="admin-error">
          {isInvalidKey ? 'Invalid API key — signing out...' : 'Failed to load configuration'}
        </div>
      </Card>
    )
  }

  if (!data) {
    return (
      <Card title="Configuration" className="admin-config-card">
        <div className="admin-error">No configuration available</div>
      </Card>
    )
  }

  return (
    <Card title="Configuration" className="admin-config-card">
      <div className="admin-config-items">
        <div className="admin-config-item">
          <span className="admin-config-label">Balance Monitor Interval</span>
          <code className="admin-config-value">
            {data.balanceMonitorIntervalSecs} seconds
          </code>
        </div>

        <div className="admin-config-item">
          <span className="admin-config-label">Uploader WAL Low Threshold</span>
          <code className="admin-config-value" title={`${data.uploaderWalLowThresholdFrost} frost`}>
            {formatTokenAmount(data.uploaderWalLowThresholdFrost)} WAL
          </code>
        </div>

        <div className="admin-config-item">
          <span className="admin-config-label">Sponsor SUI Low Threshold</span>
          <code className="admin-config-value" title={`${data.sponsorSuiLowThresholdMist} mist`}>
            {formatTokenAmount(data.sponsorSuiLowThresholdMist)} SUI
          </code>
        </div>

        <div className="admin-config-item">
          <span className="admin-config-label">Admin API Key Set</span>
          <span className={`admin-config-badge ${data.adminApiKeySet ? 'admin-config-badge-active' : 'admin-config-badge-inactive'}`}>
            {data.adminApiKeySet ? 'Configured' : 'Not configured'}
          </span>
        </div>
      </div>
    </Card>
  )
}
