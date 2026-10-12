import { useEffect, useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import {
  fetchAdminActivity,
  fetchAdminConfig,
  fetchAdminErrors,
  fetchAdminCoverage,
  fetchAdminUploadSummary,
  fetchAdminInventory,
  fetchAdminWallets,
  formatTokenAmount,
  shortAddress,
  suiExplorerAccountUrl,
  type AdminActivity,
  type AdminInventory,
  type UploadError,
} from '../utils/admin-api'
import { Drawer } from './Drawer'
import { formatBytes, formatCount, toCsv } from './metrics'
import { baselineChange, investigationWindows } from './range'

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
        <Drawer title={selected.id.slice(0, 8)} label={`Job ${selected.id}`} onClose={() => setSelected(null)}>
          <p className="wa-mono">{selected.id}</p>
          <dl className="wa-dl">
            <div><dt>Owner</dt><dd className="wa-mono">{selected.owner}</dd></div>
            <div><dt>Namespace</dt><dd>{selected.namespace || '—'}</dd></div>
            <div><dt>Status</dt><dd>{selected.status}</dd></div>
            <div><dt>Queued</dt><dd>{new Date(selected.createdAt).toLocaleString()}</dd></div>
            <div><dt>Updated</dt><dd>{new Date(selected.timestamp).toLocaleString()}</dd></div>
          </dl>
          <p className="wa-note">{selected.rawErrorMessage ?? selected.errorMessage}</p>
          <p className="wa-note">Stage history, retry counts, and blob ids are not on this response. Retry and cancel are not offered because this route is read-only.</p>
        </Drawer>
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

function formatWhen(value: Date, timeZone: string) {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone,
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).format(value)
}

export function IncidentLivePage({
  adminKey,
  period,
  timeZone,
  baseline,
  onInvalidKey,
  onOpenDay,
  onOpenQuality,
}: {
  adminKey: string | null
  period: { start: Date; end: Date; label: string; partial?: boolean }
  timeZone: string
  baseline: { start: Date; end: Date; label: string } | null
  onInvalidKey: () => void
  onOpenDay: (ymd: string) => void
  onOpenQuality: () => void
}) {
  const now = useMemo(() => new Date(), [period.start.getTime(), period.end.getTime()])
  const adjacent = investigationWindows(period, now)
  const before = baseline ?? adjacent.before
  const during = useQuery({
    queryKey: ['incident-during', period.start.toISOString(), period.end.toISOString(), before.start.toISOString()],
    queryFn: () => fetchAdminActivity(adminKey as string, { start: period.start, end: period.end, priorStart: before.start }),
    enabled: Boolean(adminKey),
    retry: (count, error) => (error as Error).message !== 'INVALID_KEY' && count < 1,
  })
  const beforeSeries = useQuery({
    queryKey: ['incident-before', before.start.toISOString(), before.end.toISOString()],
    queryFn: () => fetchAdminActivity(adminKey as string, { start: before.start, end: before.end }),
    enabled: Boolean(adminKey),
    retry: (count, error) => (error as Error).message !== 'INVALID_KEY' && count < 1,
  })
  const after = useQuery({
    queryKey: ['incident-after', adjacent.after?.start.toISOString() ?? '', adjacent.after?.end.toISOString() ?? ''],
    queryFn: () => fetchAdminActivity(adminKey as string, { start: adjacent.after!.start, end: adjacent.after!.end }),
    enabled: Boolean(adminKey && adjacent.after),
    retry: (count, error) => (error as Error).message !== 'INVALID_KEY' && count < 1,
  })
  const coverage = useQuery({
    queryKey: ['admin', 'coverage'],
    queryFn: () => fetchAdminCoverage(adminKey as string),
    enabled: Boolean(adminKey),
    retry: (count, error) => (error as Error).message !== 'INVALID_KEY' && count < 1,
  })
  const [hover, setHover] = useState<number | null>(null)
  const [ownerSort, setOwnerSort] = useState<'uploads' | 'owner'>('uploads')
  useInvalid(during.error, onInvalidKey)
  if (!adminKey) return null
  if (during.isLoading && !during.data) return <div className="wa-page"><Skeleton rows={6} /></div>
  if (during.error && !during.data) {
    return (
      <div className="wa-page">
        <section className="wa-panel">
          <h2>Analytics request failed</h2>
          <p className="wa-note">{failureDetail(during.error as Error, 'GET /api/admin/activity')}</p>
          <button className="wa-btn" type="button" onClick={() => during.refetch()}>Retry</button>
        </section>
      </div>
    )
  }
  const actions = during.data?.actions
  const retrievalReason = coverage.data?.retrievalRecords
    ? `${formatCount(coverage.data.retrievalRecords)} retrieval records since ${coverage.data.retrievalSince ?? 'collection start'}. This window is not a request-level population.`
    : 'No retrievals recorded. Collection has not stored a retrieval request, so percentiles are not calculated.'
  const points = [
    ...(beforeSeries.data?.actions.memoriesByDay ?? []).map((day) => ({ ...day, region: 'before' as const })),
    ...(actions?.memoriesByDay ?? []).map((day) => ({ ...day, region: 'during' as const })),
    ...(after.data?.actions.memoriesByDay ?? []).map((day) => ({ ...day, region: 'after' as const })),
  ]
  const peak = Math.max(1, ...points.map((point) => point.count))
  const duringHours = Math.max(1 / 60, (period.end.getTime() - period.start.getTime()) / 3_600_000)
  const beforeHours = Math.max(1 / 60, (before.end.getTime() - before.start.getTime()) / 3_600_000)
  const unequal = Math.abs(duringHours - beforeHours) > 0.05
  const owners = [...(actions?.topOwners ?? [])].sort((left, right) => ownerSort === 'owner' ? left.owner.localeCompare(right.owner) : right.uploadsCompleted - left.uploadsCompleted)
  const duringUploads = actions?.uploadsCompleted ?? 0
  const beforeUploads = actions?.uploadsCompletedPrior ?? 0
  const exportInvestigation = () => {
    const header = ['section', 'metric', 'before', 'during', 'after', 'change', 'definition', 'source']
    const body = [
      ['window', 'start', before.start.toISOString(), period.start.toISOString(), adjacent.after?.start.toISOString() ?? '', '', 'UTC half-open', 'resolved URL range'],
      ['window', 'end', before.end.toISOString(), period.end.toISOString(), adjacent.after?.end.toISOString() ?? '', '', timeZone, 'resolved URL range'],
      ['write', 'uploads_completed', String(beforeUploads), String(duringUploads), adjacent.after ? String(after.data?.actions.uploadsCompleted ?? '') : 'not_yet_available', baselineChange(duringUploads, beforeUploads), 'remember_jobs completed in the window', 'GET /api/admin/activity'],
      ['write', 'uploads_failed', String(actions?.uploadsFailedPrior ?? 0), String(actions?.uploadsFailed ?? 0), adjacent.after ? String(after.data?.actions.uploadsFailed ?? '') : 'not_yet_available', baselineChange(actions?.uploadsFailed ?? 0, actions?.uploadsFailedPrior ?? 0), 'remember_jobs failed in the window', 'GET /api/admin/activity'],
      ['retrieval', 'requests', '', '', '', '', retrievalReason, coverage.data ? 'GET /api/admin/coverage' : 'coverage unavailable'],
      ['retrieval', 'node_bytes', '', '', '', '', 'Node provider correlation unavailable', 'not measured'],
      ['reported', '2026-10-10 cold read', '', '', '', '', 'Reported, verification pending. Not a request percentile for this window.', 'separate snapshot'],
    ]
    const blob = new Blob([toCsv([header, ...body])], { type: 'text/csv;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const link = document.createElement('a')
    link.href = url
    link.download = 'incident-investigation.csv'
    link.click()
    URL.revokeObjectURL(url)
  }
  return (
    <div className="wa-page">
      <section className="wa-panel">
        <div className="wa-chart-head">
          <h2>No saved incidents</h2>
          <button className="wa-btn" type="button" onClick={exportInvestigation}>Export investigation</button>
        </div>
        <p className="wa-note">Choose a time window to investigate traffic and performance. This is a custom investigation, not a confirmed incident window. April and May are not guessed.</p>
        <p className="wa-note">During: {period.label}, {formatWhen(period.start, timeZone)} – {formatWhen(period.end, timeZone)} ({timeZone}){period.partial || adjacent.ongoing ? ' · partial' : ''}. Before: {before.label}, {formatWhen(before.start, timeZone)} – {formatWhen(before.end, timeZone)}. After: {adjacent.after ? `${adjacent.after.label}, ${formatWhen(adjacent.after.start, timeZone)} – ${formatWhen(adjacent.after.end, timeZone)}` : 'Not yet available. The during window is still open.'}</p>
        <button className="wa-btn" type="button" onClick={onOpenQuality}>View measurement coverage</button>
      </section>
      <div className="wa-kpis">
        <article className="wa-kpi"><div className="label">Uploads completed</div><div className="value">{formatCount(duringUploads)}</div><div className="delta">{baselineChange(duringUploads, beforeUploads)} vs before</div></article>
        <article className="wa-kpi"><div className="label">Uploads / hour</div><div className="value">{(duringUploads / duringHours).toFixed(2)}</div><div className="delta">{unequal ? 'Windows differ in length' : 'Same elapsed duration'}</div></article>
        <article className="wa-kpi"><div className="label">Retrieval requests</div><div className="value wa-unavailable">—</div><div className="delta">No request records</div></article>
        <article className="wa-kpi"><div className="label">Relayer p99</div><div className="value wa-unavailable">—</div><div className="delta">Histogram not registered</div></article>
        <article className="wa-kpi"><div className="label">Aggregator p99</div><div className="value wa-unavailable">—</div><div className="delta">Not retained per request</div></article>
        <article className="wa-kpi"><div className="label">Node transfer</div><div className="value wa-unavailable">—</div><div className="delta">Correlation unavailable</div></article>
      </div>
      <div className="wa-invest">
        <section className="wa-panel">
          <div className="wa-chart-head">
            <h2>Memories created</h2>
            <span className="wa-note">Count · {timeZone} · not retrieval bytes</span>
          </div>
          {points.length === 0 ? <p className="wa-empty">No memories created in these measured windows.</p> : (
            <div className="wa-timeline">
              <svg viewBox="0 0 640 220" role="img" aria-label="Memories created by day">
                {points.map((point, index) => {
                  const bar = Math.max(8, 600 / points.length - 6)
                  const height = Math.max(2, (point.count / peak) * 160)
                  const x = 20 + index * (bar + 6)
                  return (
                    <g key={`${point.region}-${point.day}`}>
                      <rect x={x} y={180 - height} width={bar} height={height} rx="2" fill={point.region === 'during' ? '#8055ff' : point.region === 'before' ? '#3a3a3a' : '#6a5acd'} onMouseEnter={() => setHover(index)} onMouseLeave={() => setHover(null)} onClick={() => onOpenDay(point.day)} />
                      <text x={x} y="198" fill="#8a8a8a" fontSize="10">{point.day.slice(5)}</text>
                    </g>
                  )
                })}
              </svg>
              {hover != null && points[hover] && (
                <div className="wa-tip">{points[hover].day} · {timeZone} · memories created · {points[hover].count} · {points[hover].region} · sample is the day count · no deployment annotation</div>
              )}
              <p className="wa-note">Gray is before, violet is during, lighter violet is after. Click a day to open that calendar day. Missing retrieval series are omitted, not drawn as zero.</p>
            </div>
          )}
        </section>
        <section className="wa-panel">
          <h2>Coverage and evidence</h2>
          <p className="wa-note">{coverage.isError ? 'Coverage request failed. Write counts on the left are still usable.' : retrievalReason}</p>
          <p className="wa-note">Earliest request detail: {coverage.data?.retrievalSince ?? 'none'}. Complete through: {during.data?.generatedAt ?? 'unknown'}. Aggregate retrieval histograms: not registered. Known gap: no per-request byte, latency, cache, or retry series.</p>
          <p className="wa-note">10 Oct 2026 snapshot, reported, verification pending: 239.6 MiB plain, 10.11 TiB encoded accounting, 168,376 blobs, one cold-read node transfer of 445,556 B, aggregator-to-relayer p50/p90/p99 of 555 / 1,537 / 20,412 B. It does not fill this timeline or April/May percentiles.</p>
          <h3>What changed</h3>
          <p className="wa-note">Observed: uploads completed moved from {formatCount(beforeUploads)} to {formatCount(duringUploads)} ({baselineChange(duringUploads, beforeUploads)}). {owners[0] ? `${shortAddress(owners[0].owner)} completed ${formatCount(owners[0].uploadsCompleted)} of ${formatCount(duringUploads)} during uploads.` : 'No owner completed an upload in the during window.'}</p>
          <p className="wa-note">Evidence: activity counts for the resolved windows. Retrieval volume, payload size, cache misses, retries, and latency are not in this response.</p>
          <p className="wa-note">Hypothesis: none. Confirmed cause: none. An upload change is not a retrieval-incident cause.</p>
          {coverage.isError && <button className="wa-btn" type="button" onClick={() => coverage.refetch()}>Retry coverage</button>}
        </section>
      </div>
      {during.isError && during.data && <p className="wa-note">Refresh failed. Showing the last successful activity result from {during.data.generatedAt}.</p>}
      <section className="wa-panel">
        <h2>Before / during / after</h2>
        <p className="wa-note">{unequal ? `Before is ${beforeHours.toFixed(1)} h and during is ${duringHours.toFixed(1)} h. Compare the per-hour rate, not only the raw count.` : 'Before and during use the same elapsed duration.'} Population is completed or failed remember jobs, not retrieval requests.</p>
        <div className="wa-table-wrap">
          <table className="wa-table">
            <thead><tr><th>Metric</th><th>Before</th><th>During</th><th>After</th><th>During vs before</th></tr></thead>
            <tbody>
              <tr><td>Uploads completed</td><td className="num">{formatCount(beforeUploads)}</td><td className="num">{formatCount(duringUploads)}</td><td className="num">{adjacent.after ? (after.isLoading ? '…' : formatCount(after.data?.actions.uploadsCompleted ?? 0)) : 'Not yet available'}</td><td>{baselineChange(duringUploads, beforeUploads)}{unequal ? ` · ${(duringUploads / duringHours).toFixed(2)}/h vs ${(beforeUploads / beforeHours).toFixed(2)}/h` : ''}</td></tr>
              <tr><td>Uploads failed</td><td className="num">{formatCount(actions?.uploadsFailedPrior ?? 0)}</td><td className="num">{formatCount(actions?.uploadsFailed ?? 0)}</td><td className="num">{adjacent.after ? formatCount(after.data?.actions.uploadsFailed ?? 0) : 'Not yet available'}</td><td>{baselineChange(actions?.uploadsFailed ?? 0, actions?.uploadsFailedPrior ?? 0)}</td></tr>
              <tr><td>Memory deletes</td><td className="num">{formatCount(actions?.memoryDeletesPrior ?? 0)}</td><td className="num">{formatCount(actions?.memoryDeletes ?? 0)}</td><td className="num">{adjacent.after ? formatCount(after.data?.actions.memoryDeletes ?? 0) : 'Not yet available'}</td><td>{baselineChange(actions?.memoryDeletes ?? 0, actions?.memoryDeletesPrior ?? 0)}</td></tr>
              <tr><td>Retrieval requests</td><td className="wa-unavailable" colSpan={4}>{retrievalReason}</td></tr>
              <tr><td>Relayer → client bytes</td><td className="wa-unavailable" colSpan={4}>Response-body histograms are not registered. Not substituted from upload size.</td></tr>
              <tr><td>Aggregator → relayer bytes</td><td className="wa-unavailable" colSpan={4}>Upstream body bytes are not retained per request.</td></tr>
              <tr><td>Node → aggregator bytes</td><td className="wa-unavailable" colSpan={4}>Node provider correlation unavailable.</td></tr>
            </tbody>
          </table>
        </div>
      </section>
      <section className="wa-panel">
        <h2>Upload contributors</h2>
        <p className="wa-note">During-window owners only. Delegate, bytes, latency, cache, and retry are not on this response, so those rankings are not shown. Before-window owners are not returned, so new versus returning cannot be separated.</p>
        <div className="wa-table-wrap">
          <table className="wa-table">
            <thead><tr><th><button type="button" onClick={() => setOwnerSort('owner')}>Owner{ownerSort === 'owner' ? ' ↓' : ''}</button></th><th><button type="button" onClick={() => setOwnerSort('uploads')}>Uploads completed{ownerSort === 'uploads' ? ' ↓' : ''}</button></th><th>Share of during uploads</th></tr></thead>
            <tbody>
              {owners.length === 0 ? <tr><td colSpan={3} className="wa-empty">No completed uploads in this window.</td></tr> : owners.map((owner) => (
                <tr key={owner.owner}><td className="mono">{shortAddress(owner.owner)}</td><td className="num">{formatCount(owner.uploadsCompleted)}</td><td className="num">{duringUploads ? `${Math.round((owner.uploadsCompleted / duringUploads) * 100)}%` : 'No baseline'}</td></tr>
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
