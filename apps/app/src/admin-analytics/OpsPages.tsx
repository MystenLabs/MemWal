import { useEffect, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import {
  fetchAdminConfig,
  fetchAdminErrors,
  fetchAdminInventory,
  fetchAdminUploadSummary,
  fetchAdminWallets,
  formatTokenAmount,
  shortAddress,
  suiExplorerAccountUrl,
  type AdminActivity,
  type AdminInventory,
  type UploadError,
} from '../utils/admin-api'
import { formatBytes, formatCount } from './metrics'

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

function Fail({ message, detail, onRetry }: { message: string; detail?: string; onRetry: () => void }) {
  return (
    <div className="wa-empty">
      <p>{message}</p>
      {detail && <p className="wa-note">{detail}</p>}
      <button className="wa-btn" type="button" onClick={onRetry}>Retry</button>
    </div>
  )
}

function failureDetail(error: Error | null, endpoint: string) {
  if (!error) return `No response from ${endpoint}.`
  if (error.message === 'INVALID_KEY') return 'Admin session rejected.'
  if (error.message.startsWith('SERVER_ERROR')) return `${endpoint} returned a server error. Other admin routes can still succeed.`
  if (error.message.includes('HTTP 404')) return `${endpoint} is not on the running relayer.`
  return error.message
}

function Bars({ rows, empty }: { rows: Array<{ label: string; value: number }>; empty: string }) {
  const max = Math.max(1, ...rows.map((row) => row.value))
  if (rows.length === 0) return <p className="wa-empty">{empty}</p>
  return (
    <div>
      {rows.map((row) => (
        <div className="wa-bar-row" key={row.label}>
          <span>{row.label}</span>
          <div className="wa-bar"><i style={{ width: `${(row.value / max) * 100}%` }} /></div>
          <b>{formatCount(row.value)}</b>
        </div>
      ))}
    </div>
  )
}

function Kpi({ label, value, delta, title }: { label: string; value: string; delta: string; title?: string }) {
  return (
    <article className="wa-kpi" title={title}>
      <div className="label">{label}</div>
      <div className={`value${value === '—' ? ' wa-unavailable' : ''}`}>{value}</div>
      <div className="delta">{delta}</div>
    </article>
  )
}

export function ActivityPage({ activity, loading, error, periodLabel, onInvalidKey, onRetry }: {
  activity: AdminActivity | undefined
  loading: boolean
  error: Error | null
  periodLabel: string
  onInvalidKey: () => void
  onRetry: () => void
}) {
  useInvalid(error, onInvalidKey)
  const actions = activity?.actions
  const series = actions?.memoriesByHour?.map((row) => ({ label: row.hour.slice(11, 16), value: row.count }))
    ?? actions?.memoriesByDay.map((row) => ({ label: row.day.slice(5), value: row.count }))
    ?? []
  const written = series.reduce((sum, row) => sum + row.value, 0)
  return (
    <div className="wa-page">
      <div className="wa-kpis">
        <Kpi label="Memories written" value={actions ? formatCount(written) : '—'} delta={periodLabel} />
        <Kpi label="Uploads completed" value={actions ? formatCount(actions.uploadsCompleted) : '—'} delta={actions ? `Prior ${formatCount(actions.uploadsCompletedPrior)}` : 'Waiting'} />
        <Kpi label="Uploads failed" value={actions ? formatCount(actions.uploadsFailed) : '—'} delta={actions ? `Prior ${formatCount(actions.uploadsFailedPrior)}` : 'Waiting'} />
        <Kpi label="In flight" value={actions ? formatCount(actions.uploadsInFlight) : '—'} delta="Current jobs" />
        <Kpi label="Active delegates" value="—" delta="Unavailable" title="Delegate activity is not in the activity API." />
        <Kpi label="Retrievals" value="—" delta="Unavailable" title="Retrieval requests are not stored per account." />
      </div>
      <div className="wa-board">
        <section className="wa-panel wa-chart-panel">
          <div className="wa-chart-head">
            <h2>Completed writes</h2>
            <span className="wa-note">{actions?.memoriesByHour ? 'Hourly' : 'Daily'} · dev relayer</span>
          </div>
          {loading && <Skeleton rows={5} />}
          {!loading && !actions && <Fail message="Dev relayer activity failed." detail={failureDetail(error, 'GET /api/admin/activity')} onRetry={onRetry} />}
          {actions && <Bars rows={series} empty="No completed writes in this window." />}
        </section>
        <aside className="wa-rail">
          <section>
            <h2>Sponsored actions</h2>
            {!actions && <p className="wa-note">Waiting for activity.</p>}
            {actions && actions.sponsored.length === 0 && <p className="wa-note">None in this window.</p>}
            {actions?.sponsored.map((row) => (
              <div className="wa-split" key={row.kind}><span>{row.kind === 'create_account' ? 'Account creation' : row.kind === 'add_delegate_key' ? 'Delegate added' : row.kind === 'remove_delegate_key' ? 'Delegate removed' : row.kind}</span><b>{row.count}</b></div>
            ))}
          </section>
          <section>
            <h2>Measured outflow</h2>
            <p className="wa-note">Balance-sample decreases. Not a provider invoice.</p>
            {activity && (
              <>
                <div className="wa-split"><span>Uploader WAL</span><b>{activity.uploaderWal.comparable ? formatTokenAmount(activity.uploaderWal.outflow) : '—'}</b></div>
                <div className="wa-split"><span>Uploader SUI</span><b>{activity.uploaderSui.comparable ? formatTokenAmount(activity.uploaderSui.outflow) : '—'}</b></div>
              </>
            )}
          </section>
        </aside>
        <section className="wa-panel wa-table-panel">
          <h2>Completed uploads by owner</h2>
          <div className="wa-table-wrap">
            <table className="wa-table">
              <thead><tr><th>Owner</th><th className="wa-num">Uploads</th><th>Prior window</th></tr></thead>
              <tbody>
                {actions && actions.topOwners.length === 0 && <tr><td colSpan={3}>No completed uploads in this window.</td></tr>}
                {actions?.topOwners.map((owner) => (
                  <tr key={owner.owner}>
                    <td className="wa-mono" title={owner.owner}>{shortAddress(owner.owner)}</td>
                    <td className="wa-num">{owner.uploadsCompleted}</td>
                    <td className="wa-note">Not returned per owner</td>
                  </tr>
                ))}
                {!actions && <tr><td colSpan={3} className="wa-note">Owner rankings stay blank until activity loads.</td></tr>}
              </tbody>
            </table>
          </div>
        </section>
      </div>
    </div>
  )
}

export function UploadJobsPage({ adminKey, onInvalidKey, periodLabel, start, end, priorStart }: {
  adminKey: string
  onInvalidKey: () => void
  periodLabel: string
  start: Date
  end: Date
  priorStart: Date | null
}) {
  const [offset, setOffset] = useState(0)
  const [selected, setSelected] = useState<UploadError | null>(null)
  const [filter, setFilter] = useState('')
  const limit = 20
  const summary = useQuery({
    queryKey: ['admin', 'upload-summary', start.toISOString(), end.toISOString(), priorStart?.toISOString() ?? ''],
    queryFn: () => fetchAdminUploadSummary(adminKey, { start, end, priorStart }),
    retry: (count, error) => (error as Error).message !== 'INVALID_KEY' && count < 2,
  })
  const query = useQuery({
    queryKey: ['admin', 'errors', limit, offset],
    queryFn: () => fetchAdminErrors(adminKey, limit, offset),
    retry: (count, error) => (error as Error).message !== 'INVALID_KEY' && count < 2,
  })
  useInvalid(summary.error ?? query.error, onInvalidKey)
  const needle = filter.trim().toLowerCase()
  const rows = (query.data?.errors ?? []).filter((job) => !needle || `${job.id} ${job.owner} ${job.namespace} ${job.errorMessage}`.toLowerCase().includes(needle))
  const data = summary.data
  const rate = data && data.successDenominator > 0 ? `${Math.round((data.successNumerator / data.successDenominator) * 100)}%` : data ? 'No completed outcomes' : '—'
  const oldest = data?.oldestQueuedAt ? `${Math.max(0, Math.round((Date.now() - Date.parse(data.oldestQueuedAt)) / 60000))} min` : data ? 'None queued' : '—'
  return (
    <div className="wa-page">
      <div className="wa-kpis">
        <Kpi label="Queued now" value={data ? formatCount(data.queuedNow) : '—'} delta="Now" title="remember_jobs status pending. Not a historical queue." />
        <Kpi label="Processing now" value={data ? formatCount(data.processingNow) : '—'} delta={data?.staleProcessing ? `${data.staleProcessing} quiet past 10 min` : 'Heartbeat under 10 min'} title="running or uploaded with a fresh updated_at. Quiet rows are excluded until the stale sweep fails them." />
        <Kpi label="Completed" value={data ? formatCount(data.completed) : '—'} delta={periodLabel} title="status done. updated_at is the completion transition." />
        <Kpi label="Failed" value={data ? formatCount(data.failed) : '—'} delta={data ? `Prior ${formatCount(data.failedPrior)}` : periodLabel} title="Terminal status failed in the selected window." />
        <Kpi label="Success rate" value={rate} delta={data && data.successDenominator > 0 ? `${data.successNumerator}/${data.successDenominator}` : 'No terminal outcomes'} title="Completed / (completed + terminally failed). Queued and processing are excluded." />
        <Kpi label="Oldest queued" value={oldest} delta="Created time" />
      </div>
      {summary.error && !summary.isLoading && <Fail message="Upload summary failed." detail={failureDetail(summary.error as Error, 'GET /api/admin/upload-summary')} onRetry={() => summary.refetch()} />}
      <section className="wa-panel">
        <div className="wa-chart-head">
          <h2>Upload failures</h2>
          <div className="wa-actions">
            <input className="wa-input" aria-label="Filter this page" placeholder="Filter this page" value={filter} onChange={(event) => setFilter(event.target.value)} />
            <button className="wa-btn" type="button" onClick={() => query.refetch()} disabled={query.isFetching}>{query.isFetching ? 'Refreshing' : 'Refresh'}</button>
          </div>
        </div>
        <p className="wa-note">This table is the recorded failure list. Completed and queued counts above come from remember_jobs, not from this page.</p>
        {query.isLoading && <Skeleton rows={5} />}
        {query.error && !query.isLoading && <Fail message="Failed to load upload errors." detail={failureDetail(query.error as Error, 'GET /api/admin/upload-errors')} onRetry={() => query.refetch()} />}
        {query.data && rows.length === 0 && <p className="wa-empty">No failed uploads in this period.</p>}
        {rows.length > 0 && (
          <div className="wa-table-wrap">
            <table className="wa-table">
              <thead><tr><th>Job</th><th>Owner</th><th>Namespace</th><th>Status</th><th>Updated</th><th>Error</th></tr></thead>
              <tbody>
                {rows.map((job) => (
                  <tr key={job.id} onClick={() => setSelected(job)}>
                    <td className="wa-mono">{job.id.slice(0, 8)}</td>
                    <td className="wa-mono" title={job.owner}>{shortAddress(job.owner)}</td>
                    <td>{job.namespace || '—'}</td>
                    <td>{job.status}</td>
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
      {selected && (
        <aside className="wa-drawer" role="dialog" aria-label={`Job ${selected.id}`}>
          <button className="wa-btn" type="button" onClick={() => setSelected(null)}>Close</button>
          <h3 className="wa-mono">{selected.id}</h3>
          <div className="wa-split"><span>Owner</span><b className="wa-mono">{selected.owner}</b></div>
          <div className="wa-split"><span>Namespace</span><b>{selected.namespace || '—'}</b></div>
          <div className="wa-split"><span>Status</span><b>{selected.status}</b></div>
          <div className="wa-split"><span>Queued</span><b>{new Date(selected.createdAt).toLocaleString()}</b></div>
          <div className="wa-split"><span>Updated</span><b>{new Date(selected.timestamp).toLocaleString()}</b></div>
          <p className="wa-note">{selected.rawErrorMessage ?? selected.errorMessage}</p>
          <p className="wa-note">Stage history, retry counts, and blob ids are not on this response. Retry and cancel are not offered because this route is read-only.</p>
        </aside>
      )}
    </div>
  )
}

function CopyAddress({ address }: { address: string }) {
  const [copied, setCopied] = useState(false)
  return (
    <button className="wa-btn" type="button" onClick={() => {
      void navigator.clipboard.writeText(address)
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1200)
    }}>{copied ? 'Copied' : 'Copy'}</button>
  )
}

function AddressLink({ address }: { address: string }) {
  return (
    <a className="wa-ext" href={suiExplorerAccountUrl(address)} title={address} target="_blank" rel="noreferrer">
      {shortAddress(address)}
    </a>
  )
}

export function WalletsPage({ adminKey, onInvalidKey, activity }: {
  adminKey: string
  onInvalidKey: () => void
  activity?: AdminActivity
}) {
  const query = useQuery({
    queryKey: ['admin', 'wallets'],
    queryFn: () => fetchAdminWallets(adminKey),
    refetchInterval: 30000,
    retry: (count, error) => (error as Error).message !== 'INVALID_KEY' && count < 2,
  })
  useInvalid(query.error, onInvalidKey)
  const data = query.data
  const low = data?.uploaderPoolWallets.filter((wallet) => wallet.status === 'low').length ?? 0
  const healthy = data?.uploaderPoolWallets.filter((wallet) => wallet.status === 'ok').length ?? 0
  const sui = data ? data.uploaderPoolWallets.reduce((total, wallet) => total + wallet.suiBalance, 0n) : 0n
  const wal = data ? data.uploaderPoolWallets.reduce((total, wallet) => total + wallet.walBalance, 0n) : 0n
  return (
    <div className="wa-page">
      <div className="wa-kpis">
        <Kpi label="Uploader wallets" value={data ? formatCount(data.uploaderPoolWallets.length) : '—'} delta="Pool" />
        <Kpi label="Healthy" value={data ? formatCount(healthy) : '—'} delta="At or above threshold" />
        <Kpi label="Low balance" value={data ? formatCount(low) : '—'} delta="Below configured threshold" />
        <Kpi label="Spendable SUI" value={data ? formatTokenAmount(sui) : '—'} delta="Uploader pool" />
        <Kpi label="Spendable WAL" value={data ? formatTokenAmount(wal) : '—'} delta="Uploader pool" />
        <Kpi label="Sponsor SUI" value={data ? formatTokenAmount(data.sponsorWallet.suiBalance) : '—'} delta="Sponsor only" />
      </div>
      <section className="wa-panel">
        <div className="wa-chart-head">
          <h2>Uploader pool</h2>
          <button className="wa-btn" type="button" onClick={() => query.refetch()} disabled={query.isFetching}>{query.isFetching ? 'Refreshing' : 'Refresh'}</button>
        </div>
        <p className="wa-note">Low means spendable SUI or WAL is under the relayer threshold. The source has no critical tier.</p>
        {query.isLoading && <Skeleton />}
        {query.error && !query.isLoading && <Fail message="Failed to load wallets." detail={failureDetail(query.error as Error, 'GET /api/admin/wallets')} onRetry={() => query.refetch()} />}
        {data && (
          <div className="wa-table-wrap">
            <table className="wa-table">
              <thead><tr><th>Address</th><th className="wa-num">Spendable SUI</th><th className="wa-num">Spendable WAL</th><th>Status</th><th /></tr></thead>
              <tbody>
                {data.uploaderPoolWallets.map((wallet) => (
                  <tr key={wallet.address}>
                    <td><AddressLink address={wallet.address} /></td>
                    <td className="wa-num">{formatTokenAmount(wallet.suiBalance)}</td>
                    <td className="wa-num">{formatTokenAmount(wallet.walBalance)}</td>
                    <td><span className={`wa-badge${wallet.status === 'ok' ? '' : ' off'}`}>{wallet.status}</span></td>
                    <td><CopyAddress address={wallet.address} /></td>
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
          <div className="wa-split"><span>Address</span><b><AddressLink address={data.sponsorWallet.address} /></b></div>
          <div className="wa-split"><span>Spendable SUI</span><b>{formatTokenAmount(data.sponsorWallet.suiBalance)}</b></div>
          <div className="wa-split"><span>Threshold</span><b>{formatTokenAmount(data.sponsorWallet.suiThreshold)} SUI</b></div>
          <div className="wa-split"><span>Status</span><b>{data.sponsorWallet.status}</b></div>
          <div className="wa-split"><span>Checked</span><b>{new Date(data.lastUpdated).toLocaleString()}</b></div>
        </section>
      )}
      <section className="wa-panel">
        <h2>Measured spend</h2>
        {activity ? (
          <>
            <p className="wa-note">Outflow is the sum of balance-sample decreases in the selected activity window. A top-up does not cancel it. This is not provider bandwidth cost.</p>
            <div className="wa-split"><span>Uploader WAL outflow</span><b>{activity.uploaderWal.comparable ? formatTokenAmount(activity.uploaderWal.outflow) : 'Not comparable'}</b></div>
            <div className="wa-split"><span>Uploader SUI outflow</span><b>{activity.uploaderSui.comparable ? formatTokenAmount(activity.uploaderSui.outflow) : 'Not comparable'}</b></div>
            <div className="wa-split"><span>Sponsor SUI outflow</span><b>{activity.sponsorSui.comparable ? formatTokenAmount(activity.sponsorSui.outflow) : 'Not comparable'}</b></div>
          </>
        ) : (
          <p className="wa-empty">Cost tracking unavailable. Current balances are not historical spend.</p>
        )}
      </section>
    </div>
  )
}

function coverage(inventory: AdminInventory) {
  if (inventory.logicalRows === 0) return 'No rows'
  return `${Math.round((inventory.sizedRows / inventory.logicalRows) * 100)}% of rows`
}

export function StorageLivePage({ adminKey, onInvalidKey }: { adminKey: string; onInvalidKey: () => void }) {
  const query = useQuery({
    queryKey: ['admin', 'inventory'],
    queryFn: () => fetchAdminInventory(adminKey),
    retry: (count, error) => (error as Error).message !== 'INVALID_KEY' && count < 2,
  })
  useInvalid(query.error, onInvalidKey)
  const data = query.data
  return (
    <div className="wa-page">
      <div className="wa-kpis">
        <Kpi label="Logical rows" value={data ? formatCount(data.logicalRows) : '—'} delta="vector_entries" />
        <Kpi label="Unique blobs" value={data ? formatCount(data.distinctBlobs) : '—'} delta="Distinct blob id" />
        <Kpi label="Known encrypted" value={data ? formatBytes(data.uniqueEncryptedBytes) : '—'} delta={data ? coverage(data) : 'Waiting'} title="One size per blob id. Zero-byte rows are excluded." />
        <Kpi label="Unknown size" value={data ? formatCount(data.unknownSizeRows) : '—'} delta="blob_size_bytes = 0" />
        <Kpi label="Plaintext" value="—" delta="Not stored" title="Production rows do not keep plaintext length." />
        <Kpi label="Encoded storage" value="—" delta="Not collected" title="Walrus encoded allocation is not in vector_entries." />
      </div>
      <div className="wa-board">
        <section className="wa-panel">
          <h2>Current encrypted inventory</h2>
          {query.isLoading && <Skeleton rows={4} />}
          {query.error && !query.isLoading && <Fail message="Storage inventory failed." detail={failureDetail(query.error as Error, 'GET /api/admin/inventory')} onRetry={() => query.refetch()} />}
          {data && (
            <>
              <p className="wa-note">Known bytes are ciphertext sizes already stored at upload. Shared blobs are counted once. Row-sum {formatBytes(data.rowSumEncryptedBytes)} can be larger when one blob is referenced by several memories. As of {new Date(data.generatedAt).toLocaleString()}.</p>
              <div className="wa-table-wrap">
                <table className="wa-table">
                  <thead><tr><th>Namespace</th><th className="wa-num">Rows</th><th className="wa-num">Known encrypted</th></tr></thead>
                  <tbody>
                    {data.namespaces.length === 0 && <tr><td colSpan={3}>No indexed memories.</td></tr>}
                    {data.namespaces.map((row) => (
                      <tr key={row.key}><td>{row.key}</td><td className="wa-num">{formatCount(row.rows)}</td><td className="wa-num">{formatBytes(row.knownEncryptedBytes)}</td></tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}
        </section>
        <aside className="wa-rail">
          <section>
            <h2>Not in this read</h2>
            <div className="wa-split"><span>Plaintext bytes</span><b className="wa-unavailable">Unavailable</b></div>
            <div className="wa-split"><span>Encoded allocation</span><b className="wa-unavailable">Unavailable</b></div>
            <div className="wa-split"><span>Historical snapshot</span><b className="wa-unavailable">Unavailable</b></div>
            <p className="wa-note">This page is current inventory, not lifetime uploaded bytes and not paid lease allocation.</p>
          </section>
        </aside>
      </div>
    </div>
  )
}

const BOUNDARIES = [
  ['Relayer → client', 'Not stored', 'Response-body bytes are not retained per request.'],
  ['Aggregator → relayer', 'Not stored', 'Upstream body bytes are not a histogram.'],
  ['Storage node → aggregator', 'Unsupported', 'Node telemetry is not correlated to a request id.'],
] as const

export function RetrievalLivePage() {
  return (
    <div className="wa-page">
      <div className="wa-kpis">
        <Kpi label="p50 bytes" value="—" delta="Unavailable" title="No per-request byte population." />
        <Kpi label="p90 bytes" value="—" delta="Unavailable" />
        <Kpi label="p99 bytes" value="—" delta="Unavailable" />
        <Kpi label="p50 latency" value="—" delta="Unavailable" />
        <Kpi label="p99 latency" value="—" delta="Unavailable" />
        <Kpi label="Sample count" value="—" delta="No request records" />
      </div>
      <section className="wa-panel">
        <h2>Transfer boundaries</h2>
        <div className="wa-table-wrap">
          <table className="wa-table">
            <thead><tr><th>Boundary</th><th>Status</th><th>Why</th></tr></thead>
            <tbody>
              {BOUNDARIES.map((row) => (
                <tr key={row[0]}><td>{row[0]}</td><td>{row[1]}</td><td>{row[2]}</td></tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="wa-note">Percentiles are not calculated from upload counters. A missing node series is unavailable, not zero traffic.</p>
      </section>
    </div>
  )
}

export function IncidentLivePage() {
  return (
    <div className="wa-page">
      <section className="wa-panel">
        <h2>No verified incident window</h2>
        <p className="wa-note">The incident year and exact start are unconfirmed. This page will not pick April or May.</p>
        <div className="wa-table-wrap">
          <table className="wa-table">
            <thead><tr><th>Window</th><th>Requests</th><th>p50 bytes</th><th>p99 bytes</th><th>p99 latency</th></tr></thead>
            <tbody>
              {['Before', 'During', 'After'].map((label) => (
                <tr key={label}>
                  <td>{label}</td>
                  <td className="wa-unavailable">Unavailable</td>
                  <td className="wa-unavailable">Unavailable</td>
                  <td className="wa-unavailable">Unavailable</td>
                  <td className="wa-unavailable">Unavailable</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  )
}

export function QualityPage({ activityError }: { activityError: Error | null }) {
  const activityState = activityError ? 'Failed' : 'Collected'
  const rows = [
    ['Account activity', 'GET /api/admin/activity', activityState, 'Top owners and write counts. Not every account.'],
    ['Writes', 'remember jobs', activityState, 'Completed, failed, and in-flight counters.'],
    ['Retrieval requests', 'Not collected', 'Unsupported', 'No request-byte or latency population.'],
    ['Plaintext sizes', 'Not stored', 'Unsupported', 'Production rows do not keep plaintext length.'],
    ['Encrypted sizes', 'vector_entries.blob_size_bytes', 'Partial', 'Zero is the column default, so coverage is sized rows only.'],
    ['Encoded storage', 'Not collected', 'Unsupported', 'Walrus allocation field is not verified or stored.'],
    ['Relayer response bytes', 'Not collected', 'Unsupported', 'No per-request histogram.'],
    ['Node egress', 'Not collected', 'Unsupported', 'No correlated node telemetry.'],
    ['Delegate lifecycle', 'Not collected', 'Unsupported', 'Auth cache is not a registry.'],
    ['Upload failures', 'GET /api/admin/upload-errors', 'Collected', 'Failures only. Not queue depth.'],
    ['Wallet balances', 'GET /api/admin/wallets', 'Collected', 'Current balances. Low is below threshold, not a critical tier.'],
  ]
  return (
    <div className="wa-page">
      <div className="wa-kpis">
        <Kpi label="Sources listed" value={formatCount(rows.length)} delta="Defined inventory" />
        <Kpi label="Collected" value={formatCount(rows.filter((row) => row[2] === 'Collected').length)} delta="Live admin routes" />
        <Kpi label="Partial" value={formatCount(rows.filter((row) => row[2] === 'Partial').length)} delta="Known subtotal only" />
        <Kpi label="Unsupported" value={formatCount(rows.filter((row) => row[2] === 'Unsupported').length)} delta="Not a zero" />
        <Kpi label="Failed now" value={activityError ? '1' : '0'} delta={activityError ? activityError.message : 'Activity route'} />
        <Kpi label="Latest complete" value="—" delta="Per-source timestamps differ" />
      </div>
      <section className="wa-panel">
        <h2>Coverage</h2>
        <div className="wa-table-wrap">
          <table className="wa-table">
            <thead><tr><th>Metric</th><th>Source</th><th>Status</th><th>Limitation</th></tr></thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row[0]}><td>{row[0]}</td><td className="wa-mono">{row[1]}</td><td>{row[2]}</td><td>{row[3]}</td></tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
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
  if (query.error || !query.data) return <Fail message="Failed to load configuration." detail={query.error ? failureDetail(query.error as Error, 'GET /api/admin/config') : undefined} onRetry={() => query.refetch()} />
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
