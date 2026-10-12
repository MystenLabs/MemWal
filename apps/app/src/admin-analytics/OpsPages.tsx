import { useEffect, useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import {
  fetchAdminActivity,
  fetchAdminConfig,
  fetchAdminErrors,
  fetchAdminCoverage,
  fetchAdminQuality,
  fetchAdminRetrieval,
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

export function activityBuckets(windowHours: number, hourly: Array<{ hour: string; count: number }> | null | undefined, daily: Array<{ day: string; count: number }>) {
  if (hourly && hourly.length > 0 && windowHours > 0 && windowHours <= 36) {
    return { grain: 'Hourly', rows: hourly.map((row) => ({ label: row.hour.replace('T', ' ').slice(0, 16), value: row.count })) }
  }
  return { grain: 'Daily', rows: daily.map((row) => ({ label: row.day, value: row.count })) }
}

export function priorText(comparing: boolean, value: number) {
  return comparing ? `Prior ${value}` : 'No comparison'
}


export function afterCell(partial: boolean, hours: number, loading: boolean, value: number | undefined) {
  if (partial && hours < 1) return 'Still collecting'
  if (loading) return '…'
  return String(value ?? 0)
}
export function ActivityPage({ activity, loading, error, periodLabel, comparing, windowHours, onInvalidKey, onRetry, refreshing = false, onExport, exportReady = false }: {
  activity: AdminActivity | undefined
  loading: boolean
  error: Error | null
  periodLabel: string
  comparing: boolean
  windowHours: number
  onInvalidKey: () => void
  onRetry: () => void
  refreshing?: boolean
  onExport?: () => void
  exportReady?: boolean
}) {
  useInvalid(error, onInvalidKey)
  const actions = activity?.actions
  const buckets = activityBuckets(windowHours, actions?.memoriesByHour, actions?.memoriesByDay ?? [])
  const written = buckets.rows.reduce((sum, row) => sum + row.value, 0)
  const sameCount = actions != null && written === actions.uploadsCompleted
  return (
    <div className="wa-page" aria-busy={loading}>
      <div className="wa-kpis">
        <Kpi label="Successful writes" value={actions ? formatCount(written) : '—'} delta={periodLabel} title="Completed remember jobs in the chart buckets for the selected window." />
        <Kpi label="Uploads completed" value={actions ? formatCount(actions.uploadsCompleted) : '—'} delta={actions ? priorText(comparing, actions.uploadsCompletedPrior) : 'Waiting'} title={sameCount ? 'Matches the chart total for this window. Both count remember jobs marked done.' : 'Jobs whose status became done in the selected window. The chart counts the same jobs by bucket.'} />
        <Kpi label="Uploads failed" value={actions ? formatCount(actions.uploadsFailed) : '—'} delta={actions ? priorText(comparing, actions.uploadsFailedPrior) : 'Waiting'} />
        <Kpi label="In flight" value={actions ? formatCount(actions.uploadsInFlight) : '—'} delta="Current state" title="Jobs pending, running, or uploaded now. Not limited to the selected period." />
        <Kpi label="Active delegates" value="—" delta="Unavailable" title="Delegate activity is not in the activity API." />
        <Kpi label="Retrievals" value="—" delta="Not on this response" title="Retrieval records are a separate source. This page does not substitute upload counts." />
      </div>
      <div className="wa-board">
        <section className="wa-panel wa-chart-panel">
          <div className="wa-chart-head">
            <h2>Completed writes</h2>
            <span className="wa-note">{buckets.grain} · {periodLabel}</span>
          </div>
          {loading && <Skeleton rows={5} />}
          {!loading && !actions && <Fail message="Dev relayer activity failed." detail={failureDetail(error, 'GET /api/admin/activity')} onRetry={onRetry} />}
          {actions && <Bars rows={buckets.rows} empty="No completed writes in this window." />}
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
            <h2>Observed balance outflow</h2>
            <p className="wa-note">Balance-sample decreases. Not provider billing.</p>
            {activity && (
              <>
                <div className="wa-split"><span>Uploader WAL</span><b>{activity.uploaderWal.comparable ? formatTokenAmount(activity.uploaderWal.outflow) : '—'}</b></div>
                <div className="wa-split"><span>Uploader SUI</span><b>{activity.uploaderSui.comparable ? formatTokenAmount(activity.uploaderSui.outflow) : '—'}</b></div>
              </>
            )}
          </section>
        </aside>
        <section className="wa-panel wa-table-panel">
          <div className="wa-section-title">
            <h2>Completed uploads by owner</h2>
            {onExport && <button className="wa-btn" type="button" onClick={onExport} disabled={!exportReady}>Export upload counts</button>}
          </div>
          <p className="wa-note">Top owners only. This is not every account. The file uses the selected dates, timezone, and comparison.</p>
          {refreshing && <p className="wa-note" role="status">Updating</p>}
          <div className="wa-table-wrap">
            <table className="wa-table">
              <thead><tr><th>Owner</th><th className="wa-num">Uploads</th>{comparing && <th>Prior window</th>}</tr></thead>
              <tbody>
                {actions && actions.topOwners.length === 0 && <tr><td colSpan={comparing ? 3 : 2}>No completed uploads in this window.</td></tr>}
                {actions?.topOwners.map((owner) => (
                  <tr key={owner.owner}>
                    <td className="wa-mono" title={owner.owner}>{shortAddress(owner.owner)}</td>
                    <td className="wa-num">{owner.uploadsCompleted}</td>
                    {comparing && <td className="wa-note">Not returned per owner</td>}
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
    <div className="wa-page" aria-busy={summary.isLoading || query.isLoading}>
      <span className="wa-sr" role="status">{summary.isLoading || query.isLoading ? 'Loading upload jobs' : query.isFetching ? 'Updating upload jobs' : ''}</span>
      <div className="wa-kpis">
        <Kpi label="Queued now" value={data ? formatCount(data.queuedNow) : '—'} delta="Current state" title="Jobs waiting now. Not a historical queue." />
        <Kpi label="Processing now" value={data ? formatCount(data.processingNow) : '—'} delta={data?.staleProcessing ? `${data.staleProcessing} quiet past 10 min` : 'Heartbeat under 10 min'} title="Running or uploaded with a fresh update. Quiet rows are excluded until the stale sweep fails them." />
        <Kpi label="Completed" value={data ? formatCount(data.completed) : '—'} delta={periodLabel} title="Finished in the selected window." />
        <Kpi label="Failed" value={data ? formatCount(data.failed) : '—'} delta={data ? `Prior ${formatCount(data.failedPrior)}` : periodLabel} title="Terminal failures in the selected window." />
        <Kpi label="Success rate" value={rate} delta={data && data.successDenominator > 0 ? `${data.successNumerator}/${data.successDenominator}` : 'No terminal outcomes'} title="Completed divided by completed plus terminally failed. Queued and processing are excluded." />
        <Kpi label="Oldest queued" value={oldest} delta="Current state" />
      </div>
      {summary.isLoading && <Skeleton rows={2} />}
      {summary.error && !summary.isLoading && <Fail message="Upload summary failed." detail={failureDetail(summary.error as Error, 'GET /api/admin/upload-summary')} onRetry={() => summary.refetch()} />}
      <section className="wa-panel" aria-busy={query.isLoading}>
        <div className="wa-section-stack">
          <div className="wa-section-title">
            <h2>Upload failures</h2>
            <div className="wa-actions">
              <input className="wa-input" aria-label="Filter this page" placeholder="Filter this page" value={filter} onChange={(event) => setFilter(event.target.value)} />
              <button className="wa-btn" type="button" onClick={() => query.refetch()} disabled={query.isFetching}>{query.isFetching ? 'Refreshing' : 'Refresh'}</button>
            </div>
          </div>
          <p className="wa-note">Recorded upload failures. Summary counts cover the selected period. This list is the latest recorded pages and is not limited to that window.</p>
        </div>
        {query.isLoading && <Skeleton rows={5} />}
        {query.isFetching && query.data && <p className="wa-note" role="status">Updating</p>}
        {query.error && !query.isLoading && <Fail message="Failed to load upload errors." detail={failureDetail(query.error as Error, 'GET /api/admin/upload-errors')} onRetry={() => query.refetch()} />}
        {query.data && rows.length === 0 && <p className="wa-empty">{needle ? 'No failures on this page match the filter.' : 'No recorded upload failures.'}</p>}
        {rows.length > 0 && (
          <div className="wa-table-wrap">
            <table className="wa-table">
              <thead><tr><th>Job</th><th>Owner</th><th>Namespace</th><th>Status</th><th>Updated</th><th>Error</th></tr></thead>
              <tbody>
                {rows.map((job) => (
                  <tr key={job.id} onClick={() => setSelected(job)}>
                    <td className="wa-mono" title={job.id}>{job.id.slice(0, 8)}</td>
                    <td className="wa-mono" title={job.owner}>{shortAddress(job.owner)}</td>
                    <td>{job.namespace || '—'}</td>
                    <td>{job.status}</td>
                    <td>{new Date(job.timestamp).toLocaleString()}</td>
                    <td className="wa-clip" title={job.errorMessage}>{shortError(job.errorMessage)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <div className="wa-pager">
          <p className="wa-note">{query.data ? `${query.data.total === 0 ? 0 : offset + 1}–${Math.min(offset + rows.length, query.data.total)} of ${query.data.total} recorded failures` : 'Waiting for the failure list'}</p>
          <div className="wa-actions">
            <button className="wa-btn" type="button" disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - limit))}>Previous</button>
            <button className="wa-btn" type="button" disabled={!query.data || offset + limit >= query.data.total} onClick={() => setOffset(offset + limit)}>Next</button>
          </div>
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
          <p className="wa-prose">{selected.errorMessage}</p>
          <details>
            <summary>Technical error</summary>
            <p className="wa-prose wa-mono">{selected.rawErrorMessage ?? selected.errorMessage}</p>
          </details>
          <p className="wa-note">Read-only details. Retry and cancel are not on this route.</p>
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

function shortError(message: string) {
  const line = message.split('\n')[0]?.trim() || 'No error message'
  return line.length > 72 ? `${line.slice(0, 69)}…` : line
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
        <h2>Observed balance outflow</h2>
        {activity ? (
          <>
            <p className="wa-note">Sum of balance-sample decreases in the selected window. A top-up does not cancel it.</p>
            <div className="wa-split"><span>Uploader WAL outflow</span><b>{activity.uploaderWal.comparable ? `${formatTokenAmount(activity.uploaderWal.outflow)} WAL` : 'Not comparable'}</b></div>
            <div className="wa-split"><span>Uploader SUI outflow</span><b>{activity.uploaderSui.comparable ? `${formatTokenAmount(activity.uploaderSui.outflow)} SUI` : 'Not comparable'}</b></div>
            <div className="wa-split"><span>Sponsor SUI outflow</span><b>{activity.sponsorSui.comparable ? `${formatTokenAmount(activity.sponsorSui.outflow)} SUI` : 'Not comparable'}</b></div>
            <details>
              <summary>Provider cost</summary>
              <p className="wa-note">This is not provider bandwidth cost.</p>
            </details>
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

export function boundaryCopy(source: { capability: string; health: string; observed: number | null; limitation: string } | undefined, missing: string) {
  if (!source) return { status: 'Unknown', why: missing, samples: null as number | null }
  if (source.capability === 'not_implemented') return { status: 'Not implemented', why: source.limitation, samples: null }
  if (source.capability === 'unsupported_by_source') return { status: 'Unsupported', why: source.limitation, samples: null }
  if (source.health === 'failed') return { status: 'Query failed', why: source.limitation, samples: null }
  if (source.observed === 0) return { status: 'No samples', why: 'Instrumentation is deployed. No sample has been recorded in this process.', samples: 0 }
  return { status: 'Aggregate only', why: 'A process histogram is available. It is not a per-account request history.', samples: source.observed }
}

function percentileValue(set: { samples: number; p50: number | null; p90: number | null; p99: number | null } | undefined, rank: 'p50' | 'p90' | 'p99', failed: boolean, loading: boolean, unit = 'B') {
  if (failed || loading || !set || set.samples === 0 || set[rank] == null) return '—'
  return unit === 'B' ? formatBytes(BigInt(set[rank] as number)) : `${set[rank]} ${unit}`
}

function percentileDelta(set: { samples: number } | undefined, failed: boolean, loading: boolean) {
  if (failed) return 'Request failed'
  if (loading || !set) return 'Loading'
  if (set.samples === 0) return 'No samples recorded'
  return `${set.samples} samples`
}


export function RetrievalLivePage({ adminKey, start, end, onInvalidKey, onOpenQuality }: { adminKey: string | null; start: Date; end: Date; onInvalidKey: () => void; onOpenQuality: () => void }) {
  const inventory = useQuery({
    queryKey: ['admin', 'quality'],
    queryFn: () => fetchAdminQuality(adminKey as string),
    enabled: Boolean(adminKey),
    retry: (count, error) => (error as Error).message !== 'INVALID_KEY' && count < 1,
  })
  const summary = useQuery({
    queryKey: ['admin', 'retrieval', start.toISOString(), end.toISOString()],
    queryFn: () => fetchAdminRetrieval(adminKey as string, start, end),
    enabled: Boolean(adminKey),
    retry: (count, error) => (error as Error).message !== 'INVALID_KEY' && count < 1,
  })
  useInvalid(summary.error, onInvalidKey)
  useInvalid(inventory.error, onInvalidKey)
  const sources = inventory.data?.sources ?? []
  const byId = (id: string) => sources.find((source) => source.id === id)
  const records = byId('retrieval_requests')
  const failed = Boolean(inventory.error)
  const bodyStatus = summary.data
    ? summary.data.relayerBodyBytes.samples > 0
      ? { status: 'Measured', why: summary.data.bodyDefinition, samples: summary.data.relayerBodyBytes.samples }
      : { status: summary.data.requests === 0 ? 'No samples' : 'Field missing', why: summary.data.requests === 0 ? 'No recall completed in this window.' : 'Requests exist, but relayer body bytes are null.', samples: summary.data.relayerBodyBytes.samples }
    : { status: summary.isError ? 'Request failed' : 'Loading', why: summary.isError ? 'The retrieval summary did not load.' : 'Waiting for the selected window.', samples: null as number | null }
  const upstreamStatus = summary.data && summary.data.upstreamBytes.samples > 0
    ? { status: 'Measured', why: 'Aggregator-to-relayer bytes recorded on the request. This is relayer ingress, not client egress.', samples: summary.data.upstreamBytes.samples }
    : { status: summary.data ? 'Not measured' : 'Loading', why: summary.data?.nodeReason ? 'No upstream byte field on the requests in this window.' : 'Waiting for the selected window.', samples: summary.data ? 0 : null }
  const nodeStatus = { status: 'Unsupported', why: summary.data?.nodeReason ?? 'Node telemetry is not correlated to a request id.', samples: summary.data?.nodeBytes.samples ?? null }
  const rows = [
    ['Relayer → client', bodyStatus],
    ['Aggregator → relayer', upstreamStatus],
    ['Storage node → aggregator', nodeStatus],
  ] as const
  const samples = summary.isError ? null : summary.data ? summary.data.requests : failed ? null : records?.observed ?? null
  return (
    <div className="wa-page">
      <div className="wa-kpis">
        <Kpi label="p50 bytes" value={percentileValue(summary.data?.relayerBodyBytes, 'p50', summary.isError, summary.isLoading)} delta={percentileDelta(summary.data?.relayerBodyBytes, summary.isError, summary.isLoading)} title={summary.data?.bodyDefinition} />
        <Kpi label="p90 bytes" value={percentileValue(summary.data?.relayerBodyBytes, 'p90', summary.isError, summary.isLoading)} delta={percentileDelta(summary.data?.relayerBodyBytes, summary.isError, summary.isLoading)} />
        <Kpi label="p99 bytes" value={percentileValue(summary.data?.relayerBodyBytes, 'p99', summary.isError, summary.isLoading)} delta={percentileDelta(summary.data?.relayerBodyBytes, summary.isError, summary.isLoading)} />
        <Kpi label="p50 latency" value={percentileValue(summary.data?.latencyMs, 'p50', summary.isError, summary.isLoading, 'ms')} delta={percentileDelta(summary.data?.latencyMs, summary.isError, summary.isLoading)} />
        <Kpi label="p99 latency" value={percentileValue(summary.data?.latencyMs, 'p99', summary.isError, summary.isLoading, 'ms')} delta={percentileDelta(summary.data?.latencyMs, summary.isError, summary.isLoading)} />
        <Kpi label="Request records" value={samples == null ? '—' : formatCount(samples)} delta={samples === 0 ? 'No samples recorded' : samples == null ? 'Unknown' : 'Recorded requests'} />
      </div>
      <section className="wa-panel">
        <div className="wa-chart-head">
          <h2>Storage nodes → aggregator → relayer → client</h2>
          <button className="wa-btn" type="button" onClick={onOpenQuality}>View source details</button>
        </div>
        <p className="wa-note">Relayer → client is outbound body bytes. Aggregator → relayer is relayer ingress. A process histogram is not a per-account request history, and an empty table is not zero traffic.</p>
        {failed && <button className="wa-btn" type="button" onClick={() => inventory.refetch()}>Retry</button>}
        <div className="wa-table-wrap">
          <table className="wa-table">
            <thead><tr><th>Boundary</th><th>Status</th><th className="wa-prose">Why</th></tr></thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row[0]}><td>{row[0]}</td><td>{row[1].status}</td><td className="wa-prose">{row[1].why}</td></tr>
              ))}
            </tbody>
          </table>
        </div>
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
      ['write', 'uploads_completed', String(beforeUploads), String(duringUploads), adjacent.after ? String(after.data?.actions.uploadsCompleted ?? '') : 'not_yet_available', baselineChange(duringUploads, beforeUploads), 'completed uploads in the window', 'GET /api/admin/activity'],
      ['write', 'uploads_failed', String(actions?.uploadsFailedPrior ?? 0), String(actions?.uploadsFailed ?? 0), adjacent.after ? String(after.data?.actions.uploadsFailed ?? '') : 'not_yet_available', baselineChange(actions?.uploadsFailed ?? 0, actions?.uploadsFailedPrior ?? 0), 'failed uploads in the window', 'GET /api/admin/activity'],
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
        <p className="wa-note">Custom investigation, not a confirmed incident. Window: {period.label}, {formatWhen(period.start, timeZone)} – {formatWhen(period.end, timeZone)} ({timeZone}){period.partial || adjacent.ongoing ? ' · partial' : ''}.</p>
        <details>
          <summary>Measurement details</summary>
          <p className="wa-note">Before: {before.label}, {formatWhen(before.start, timeZone)} – {formatWhen(before.end, timeZone)}. After: {adjacent.after ? `${adjacent.after.label}, ${formatWhen(adjacent.after.start, timeZone)} – ${formatWhen(adjacent.after.end, timeZone)}` : 'Not yet available. The during window is still open.'} April and May are not guessed.</p>
        </details>
        <button className="wa-btn" type="button" onClick={onOpenQuality}>View measurement coverage</button>
      </section>
      <div className="wa-kpis">
        <article className="wa-kpi"><div className="label">Uploads completed</div><div className="value">{formatCount(duringUploads)}</div><div className="delta">{baselineChange(duringUploads, beforeUploads)} vs before</div></article>
        <article className="wa-kpi"><div className="label">Uploads / hour</div><div className="value">{(duringUploads / duringHours).toFixed(2)}</div><div className="delta">{unequal ? 'Windows differ in length' : 'Same elapsed duration'}</div></article>
        <article className="wa-kpi"><div className="label">Retrieval requests</div><div className="value">{coverage.data ? formatCount(coverage.data.retrievalRecords) : '—'}</div><div className="delta">{coverage.data ? 'Recorded, not this chart' : 'Coverage unknown'}</div></article>
        <article className="wa-kpi"><div className="label">Relayer p99</div><div className="value wa-unavailable">—</div><div className="delta">Percentile not on this response</div></article>
        <article className="wa-kpi"><div className="label">Aggregator p99</div><div className="value wa-unavailable">—</div><div className="delta">Not implemented</div></article>
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
          <p className="wa-note">Observed: uploads completed moved from {formatCount(beforeUploads)} to {formatCount(duringUploads)} ({baselineChange(duringUploads, beforeUploads)}). Sample: {formatCount(owners.length)} owner rows.</p>
          <p className="wa-note">Window: {period.label}, {formatWhen(period.start, timeZone)} – {formatWhen(period.end, timeZone)} ({timeZone}).</p>
          <details>
            <summary>Measurement details</summary>
            <p className="wa-note">Earliest request detail: {coverage.data?.retrievalSince ?? 'none'}. Complete through: {during.data?.generatedAt ?? 'unknown'}. Histograms are not registered. No per-request byte, latency, cache, or retry series. No confirmed cause.</p>
          </details>
          <details>
            <summary>10 October 2026 cold read</summary>
            <p className="wa-note">Reported, verification pending: 239.6 MiB plain, 10.11 TiB encoded accounting, 168,376 blobs, one node transfer of 445,556 B, aggregator-to-relayer p50/p90/p99 of 555 / 1,537 / 20,412 B. It does not fill this timeline.</p>
          </details>
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
              <tr><td>Uploads completed</td><td className="num">{formatCount(beforeUploads)}</td><td className="num">{formatCount(duringUploads)}</td><td className="num">{adjacent.after ? afterCell(Boolean(adjacent.after.partial), (adjacent.after.end.getTime() - adjacent.after.start.getTime()) / 3_600_000, after.isLoading, after.data?.actions.uploadsCompleted) : 'Not yet available'}</td><td>{baselineChange(duringUploads, beforeUploads)}{unequal ? ` · ${(duringUploads / duringHours).toFixed(2)}/h vs ${(beforeUploads / beforeHours).toFixed(2)}/h` : ''}</td></tr>
              <tr><td>Uploads failed</td><td className="num">{formatCount(actions?.uploadsFailedPrior ?? 0)}</td><td className="num">{formatCount(actions?.uploadsFailed ?? 0)}</td><td className="num">{adjacent.after ? formatCount(after.data?.actions.uploadsFailed ?? 0) : 'Not yet available'}</td><td>{baselineChange(actions?.uploadsFailed ?? 0, actions?.uploadsFailedPrior ?? 0)}</td></tr>
              <tr><td>Memory deletes</td><td className="num">{formatCount(actions?.memoryDeletesPrior ?? 0)}</td><td className="num">{formatCount(actions?.memoryDeletes ?? 0)}</td><td className="num">{adjacent.after ? formatCount(after.data?.actions.memoryDeletes ?? 0) : 'Not yet available'}</td><td>{baselineChange(actions?.memoryDeletes ?? 0, actions?.memoryDeletesPrior ?? 0)}</td></tr>
              <tr><td>Retrieval requests</td><td className="wa-unavailable" colSpan={4}>{retrievalReason}</td></tr>
              <tr><td>Relayer → client bytes</td><td className="wa-unavailable" colSpan={4}>Percentile values are not on this response. Not substituted from upload size.</td></tr>
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
    <section className="wa-panel" aria-busy={false}>
      <h2>Settings</h2>
      <p className="wa-note">Read-only. These values come from the relayer and cannot be changed here.</p>
      <div className="wa-split"><span>Balance monitor</span><b>{data.balanceMonitorIntervalSecs} seconds</b></div>
      <div className="wa-split"><span>Uploader WAL low</span><b>{formatTokenAmount(data.uploaderWalLowThresholdFrost)} WAL</b></div>
      <div className="wa-split"><span>Uploader SUI low</span><b>{formatTokenAmount(data.uploaderSuiLowThresholdMist)} SUI</b></div>
      <div className="wa-split"><span>Sponsor SUI low</span><b>{formatTokenAmount(data.sponsorSuiLowThresholdMist)} SUI</b></div>
    </section>
  )
}

export function AccessPage({ adminKey, onInvalidKey, network }: { adminKey: string; onInvalidKey: () => void; network: string }) {
  const query = useQuery({
    queryKey: ['admin', 'coverage', 'access'],
    queryFn: () => fetchAdminCoverage(adminKey),
    retry: (count, error) => (error as Error).message !== 'INVALID_KEY' && count < 1,
  })
  useInvalid(query.error, onInvalidKey)
  return (
    <section className="wa-panel" aria-busy={query.isLoading}>
      <h2>Access and audit</h2>
      <p className="wa-note">Read-only. Signed in for {network}. Admin key only.</p>
      <span className="wa-sr" role="status">{query.isLoading ? 'Loading audit coverage' : query.isFetching ? 'Updating audit coverage' : ''}</span>
      {query.isLoading && <Skeleton rows={3} />}
      {query.error && !query.isLoading && <Fail message="Audit coverage failed." detail={failureDetail(query.error as Error, 'GET /api/admin/coverage')} onRetry={() => query.refetch()} />}
      {query.data && (
        <>
          <p className="wa-note">{formatCount(query.data.auditEvents)} retained audit rows. The admin API returns that count, not actor, action, target, or timestamp rows.</p>
          <p className="wa-empty">Event list unavailable. Pagination starts when the API returns those rows.</p>
        </>
      )}
    </section>
  )
}

