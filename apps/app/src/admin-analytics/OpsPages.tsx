import { useEffect, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import {
  fetchAdminConfig,
  fetchAdminErrors,
  fetchAdminWallets,
  formatTokenAmount,
  shortAddress,
  suiExplorerAccountUrl,
  type AdminActivity,
} from '../utils/admin-api'
import { formatCount } from './metrics'

function useInvalid(error: unknown, onInvalidKey: () => void) {
  const invalid = error instanceof Error && error.message === 'INVALID_KEY'
  useEffect(() => {
    if (invalid) onInvalidKey()
  }, [invalid, onInvalidKey])
  return invalid
}

function Skeleton({ rows = 4 }: { rows?: number }) {
  return (
    <div className="wa-skel" aria-busy="true" aria-label="Loading">
      {Array.from({ length: rows }, (_, index) => <div className="wa-skel-row" key={index} />)}
    </div>
  )
}

function Fail({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div className="wa-empty">
      <p>{message}</p>
      <button className="wa-btn" type="button" onClick={onRetry}>Retry</button>
    </div>
  )
}

export function ActivityPage({ activity, loading, error, hours, onInvalidKey }: {
  activity: AdminActivity | undefined
  loading: boolean
  error: Error | null
  hours: number
  onInvalidKey: () => void
}) {
  useInvalid(error, onInvalidKey)
  if (loading) return <Skeleton rows={6} />
  if (!activity) return <Fail message="Dev relayer activity failed." onRetry={() => window.location.reload()} />
  const written = activity.actions.memoriesByDay.reduce((sum, day) => sum + day.count, 0)
  return (
    <div className="wa-page">
      <div className="wa-kpis">
        <article className="wa-kpi"><div className="label">Memories written</div><div className="value">{formatCount(written)}</div><div className="delta">Last {hours}h</div></article>
        <article className="wa-kpi"><div className="label">Uploads completed</div><div className="value">{formatCount(activity.actions.uploadsCompleted)}</div><div className="delta">Prior {formatCount(activity.actions.uploadsCompletedPrior)}</div></article>
        <article className="wa-kpi"><div className="label">Uploads failed</div><div className="value">{formatCount(activity.actions.uploadsFailed)}</div><div className="delta">Prior {formatCount(activity.actions.uploadsFailedPrior)}</div></article>
        <article className="wa-kpi"><div className="label" title="Delegate activity is not in the activity API.">Active delegates</div><div className="value wa-unavailable">—</div><div className="delta">Unavailable</div></article>
        <article className="wa-kpi"><div className="label" title="Retrieval requests are not stored per account.">Retrievals</div><div className="value wa-unavailable">—</div><div className="delta">Unavailable</div></article>
        <article className="wa-kpi"><div className="label" title="Top 8 owners with completed uploads.">Owners listed</div><div className="value">{formatCount(activity.actions.topOwners.length)}</div><div className="delta">Top 8</div></article>
      </div>
      <section className="wa-panel">
        <h2>Completed uploads by owner</h2>
        <div className="wa-table-wrap">
          <table className="wa-table">
            <thead><tr><th>Owner</th><th>Uploads</th><th>Prior window</th></tr></thead>
            <tbody>
              {activity.actions.topOwners.length === 0 && <tr><td colSpan={3}>No completed uploads in this window.</td></tr>}
              {activity.actions.topOwners.map((owner) => (
                <tr key={owner.owner}>
                  <td className="wa-mono">{owner.owner}</td>
                  <td>{owner.uploadsCompleted}</td>
                  <td className="wa-note">Not returned per owner</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  )
}

export function UploadJobsPage({ adminKey, onInvalidKey }: { adminKey: string; onInvalidKey: () => void }) {
  const [offset, setOffset] = useState(0)
  const limit = 20
  const query = useQuery({
    queryKey: ['admin', 'errors', limit, offset],
    queryFn: () => fetchAdminErrors(adminKey, limit, offset),
    retry: (count, error) => (error as Error).message !== 'INVALID_KEY' && count < 2,
  })
  useInvalid(query.error, onInvalidKey)
  return (
    <div className="wa-page">
      <div className="wa-kpis">
        <article className="wa-kpi"><div className="label">Failed in view</div><div className="value">{query.data ? formatCount(query.data.errors.length) : '—'}</div><div className="delta">This page</div></article>
        <article className="wa-kpi"><div className="label">Failed total</div><div className="value">{query.data ? formatCount(query.data.total) : '—'}</div><div className="delta">Recorded failures</div></article>
        <article className="wa-kpi"><div className="label" title="Queue depth is not exposed by the failed-job list.">Queued</div><div className="value wa-unavailable">—</div><div className="delta">Unavailable</div></article>
        <article className="wa-kpi"><div className="label" title="Only failed jobs are listed here.">Success rate</div><div className="value wa-unavailable">—</div><div className="delta">Upload failures only</div></article>
      </div>
      <section className="wa-panel">
        <div className="wa-chart-head">
          <h2>Upload failures</h2>
          <button className="wa-btn" type="button" onClick={() => query.refetch()} disabled={query.isFetching}>{query.isFetching ? 'Refreshing' : 'Refresh'}</button>
        </div>
        {query.isLoading && <Skeleton rows={5} />}
        {query.error && !query.isLoading && <Fail message="Failed to load upload errors." onRetry={() => query.refetch()} />}
        {query.data && query.data.errors.length === 0 && <p className="wa-empty">No failed uploads in this page.</p>}
        {query.data && query.data.errors.length > 0 && (
          <div className="wa-table-wrap">
            <table className="wa-table">
              <thead><tr><th>Job</th><th>Owner</th><th>Namespace</th><th>Updated</th><th>Error</th></tr></thead>
              <tbody>
                {query.data.errors.map((job) => (
                  <tr key={job.id}>
                    <td className="wa-mono">{job.id.slice(0, 8)}</td>
                    <td className="wa-mono">{shortAddress(job.owner)}</td>
                    <td>{job.namespace || '—'}</td>
                    <td>{new Date(job.timestamp).toLocaleString()}</td>
                    <td>{job.errorMessage}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <div className="wa-actions" style={{ marginTop: 12 }}>
          <button className="wa-btn" type="button" disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - limit))}>Previous</button>
          <button className="wa-btn" type="button" disabled={!query.data || offset + limit >= query.data.total} onClick={() => setOffset(offset + limit)}>Next</button>
        </div>
      </section>
    </div>
  )
}

export function WalletsPage({ adminKey, onInvalidKey }: { adminKey: string; onInvalidKey: () => void }) {
  const query = useQuery({
    queryKey: ['admin', 'wallets'],
    queryFn: () => fetchAdminWallets(adminKey),
    refetchInterval: 30000,
    retry: (count, error) => (error as Error).message !== 'INVALID_KEY' && count < 2,
  })
  useInvalid(query.error, onInvalidKey)
  const data = query.data
  const low = data?.uploaderPoolWallets.filter((wallet) => wallet.status !== 'healthy').length ?? 0
  return (
    <div className="wa-page">
      <div className="wa-kpis">
        <article className="wa-kpi"><div className="label">Uploader wallets</div><div className="value">{data ? formatCount(data.uploaderPoolWallets.length) : '—'}</div><div className="delta">Pool</div></article>
        <article className="wa-kpi"><div className="label">Low balance</div><div className="value">{data ? formatCount(low) : '—'}</div><div className="delta">Below configured threshold</div></article>
        <article className="wa-kpi"><div className="label" title="Historical spend is not inferred from balances.">Cost tracking</div><div className="value wa-unavailable">—</div><div className="delta">Unavailable</div></article>
      </div>
      <section className="wa-panel">
        <div className="wa-chart-head">
          <h2>Uploader pool</h2>
          <button className="wa-btn" type="button" onClick={() => query.refetch()} disabled={query.isFetching}>{query.isFetching ? 'Refreshing' : 'Refresh'}</button>
        </div>
        {query.isLoading && <Skeleton />}
        {query.error && !query.isLoading && <Fail message="Failed to load wallets." onRetry={() => query.refetch()} />}
        {data && (
          <div className="wa-table-wrap">
            <table className="wa-table">
              <thead><tr><th>Address</th><th>Spendable SUI</th><th>Spendable WAL</th><th>Status</th></tr></thead>
              <tbody>
                {data.uploaderPoolWallets.map((wallet) => (
                  <tr key={wallet.address}>
                    <td><a href={suiExplorerAccountUrl(wallet.address)}>{shortAddress(wallet.address)}</a></td>
                    <td>{formatTokenAmount(wallet.suiBalance)}</td>
                    <td>{formatTokenAmount(wallet.walBalance)}</td>
                    <td><span className={`wa-badge${wallet.status === 'healthy' ? '' : ' off'}`}>{wallet.status}</span></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
      {data && (
        <section className="wa-panel">
          <h2>Sponsor wallet</h2>
          <div className="wa-split"><span>Address</span><b className="wa-mono">{shortAddress(data.sponsorWallet.address)}</b></div>
          <div className="wa-split"><span>Spendable SUI</span><b>{formatTokenAmount(data.sponsorWallet.suiBalance)}</b></div>
          <div className="wa-split"><span>Threshold</span><b>{formatTokenAmount(data.sponsorWallet.suiThreshold)} SUI</b></div>
          <div className="wa-split"><span>Status</span><b>{data.sponsorWallet.status}</b></div>
          <div className="wa-split"><span>Checked</span><b>{new Date(data.lastUpdated).toLocaleString()}</b></div>
        </section>
      )}
    </div>
  )
}

export function ConfigPage({ adminKey, onInvalidKey }: { adminKey: string; onInvalidKey: () => void }) {
  const query = useQuery({
    queryKey: ['admin', 'config'],
    queryFn: () => fetchAdminConfig(adminKey),
    retry: (count, error) => (error as Error).message !== 'INVALID_KEY' && count < 2,
  })
  useInvalid(query.error, onInvalidKey)
  if (query.isLoading) return <Skeleton rows={3} />
  if (query.error || !query.data) return <Fail message="Failed to load configuration." onRetry={() => query.refetch()} />
  const data = query.data
  return (
    <section className="wa-panel">
      <h2>Read-only thresholds</h2>
      <div className="wa-split"><span>Balance monitor</span><b>{data.balanceMonitorIntervalSecs}s</b></div>
      <div className="wa-split"><span>Uploader WAL low</span><b>{formatTokenAmount(data.uploaderWalLowThresholdFrost)} WAL</b></div>
      <div className="wa-split"><span>Uploader SUI low</span><b>{formatTokenAmount(data.uploaderSuiLowThresholdMist)} SUI</b></div>
      <div className="wa-split"><span>Sponsor SUI low</span><b>{formatTokenAmount(data.sponsorSuiLowThresholdMist)} SUI</b></div>
      <p className="wa-note">These values are read from the relayer. This page does not save changes.</p>
    </section>
  )
}

export function UnavailablePage({ title, reason }: { title: string; reason: string }) {
  return (
    <section className="wa-panel">
      <h2>{title}</h2>
      <p className="wa-empty">{reason}</p>
    </section>
  )
}
