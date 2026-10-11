import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { fetchAdminQuality, type QualitySource } from '../utils/admin-api'
import { formatCount } from './metrics'

const LABEL: Record<string, string> = {
  implemented: 'Implemented',
  not_implemented: 'Not implemented',
  external_dependency: 'External dependency',
  unsupported_by_source: 'Unsupported by source',
  healthy: 'Healthy',
  collecting_no_samples: 'Collecting, no samples',
  collection_path_unverified: 'Collection path unverified',
  stale: 'Stale',
  failed: 'Failed',
  disabled: 'Disabled',
  unknown: 'Unknown',
  complete: 'Complete',
  partial: 'Partial',
  aggregate_only: 'Aggregate only',
  request_detail: 'Request detail',
  historical_unavailable: 'History unavailable',
  measured: 'Measured',
  reported_pending: 'Reported, pending',
}

function label(value: string) {
  return LABEL[value] ?? value
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

export function QualityPage({ adminKey, onInvalidKey, onOpenView }: { adminKey: string | null; onInvalidKey: () => void; onOpenView: (view: string) => void }) {
  const [queryText, setQueryText] = useState('')
  const [health, setHealth] = useState('all')
  const [capability, setCapability] = useState('all')
  const [selected, setSelected] = useState<QualitySource | null>(null)
  const inventory = useQuery({
    queryKey: ['admin', 'quality'],
    queryFn: () => fetchAdminQuality(adminKey as string),
    enabled: Boolean(adminKey),
    retry: (count, error) => (error as Error).message !== 'INVALID_KEY' && count < 1,
  })
  if (inventory.error instanceof Error && inventory.error.message === 'INVALID_KEY') onInvalidKey()
  if (!adminKey) return null
  if (inventory.isLoading && !inventory.data) {
    return <div className="wa-page"><div className="wa-skel" aria-busy="true" aria-label="Loading">{Array.from({ length: 6 }, (_, index) => <div className="wa-skel-row" key={index} />)}</div></div>
  }
  if (inventory.error && !inventory.data) {
    const message = inventory.error instanceof Error ? inventory.error.message : 'Request failed'
    return <div className="wa-page"><Fail message="Quality inventory failed." detail={message} onRetry={() => inventory.refetch()} /></div>
  }
  const sources = inventory.data?.sources ?? []
  const visible = sources.filter((source) => {
    const haystack = `${source.name} ${source.limitation}`.toLowerCase()
    return haystack.includes(queryText.toLowerCase()) && (health === 'all' || source.health === health) && (capability === 'all' || source.capability === capability)
  })
  const failed = sources.filter((source) => source.health === 'failed' || source.health === 'stale').length
  return (
    <div className="wa-page">
      <div className="wa-kpis">
        <article className="wa-kpi"><div className="label">Implemented</div><div className="value">{formatCount(sources.filter((source) => source.capability === 'implemented').length)}</div><div className="delta">Capability, not health</div></article>
        <article className="wa-kpi"><div className="label">Healthy</div><div className="value">{formatCount(sources.filter((source) => source.health === 'healthy').length)}</div><div className="delta">Checked this request</div></article>
        <article className="wa-kpi"><div className="label">Partial coverage</div><div className="value">{formatCount(sources.filter((source) => source.coverage === 'partial').length)}</div><div className="delta">Known denominator</div></article>
        <article className="wa-kpi"><div className="label">Not implemented</div><div className="value">{formatCount(sources.filter((source) => source.capability !== 'implemented').length)}</div><div className="delta">Includes external dependencies</div></article>
        <article className="wa-kpi"><div className="label">Failed or stale</div><div className="value">{formatCount(failed)}</div><div className="delta">{failed === 0 ? 'Checked. Unknown health is excluded.' : 'Query or freshness failure'}</div></article>
        <article className="wa-kpi"><div className="label">Oldest healthy update</div><div className="value">{inventory.data?.oldestHealthyUpdate ? new Date(inventory.data.oldestHealthyUpdate).toLocaleDateString() : '—'}</div><div className="delta">No common completeness boundary</div></article>
      </div>
      <section className="wa-panel">
        <div className="wa-chart-head">
          <h2>Source inventory</h2>
          <button className="wa-btn" type="button" onClick={() => inventory.refetch()}>Refresh</button>
        </div>
        <p className="wa-note">Checked {inventory.data?.checkedAt ?? '—'}. Counts come from this inventory. {inventory.isError ? 'Refresh failed. Showing the last successful inventory.' : ''}</p>
        <div className="wa-top">
          <input className="wa-input wa-search" aria-label="Search sources" placeholder="Search source" value={queryText} onChange={(event) => setQueryText(event.target.value)} />
          <select className="wa-select" aria-label="Health" value={health} onChange={(event) => setHealth(event.target.value)}>
            <option value="all">All health</option>
            {['healthy', 'collection_path_unverified', 'collecting_no_samples', 'failed', 'disabled', 'unknown'].map((value) => <option key={value} value={value}>{label(value)}</option>)}
          </select>
          <select className="wa-select" aria-label="Capability" value={capability} onChange={(event) => setCapability(event.target.value)}>
            <option value="all">All capabilities</option>
            {['implemented', 'not_implemented', 'external_dependency', 'unsupported_by_source'].map((value) => <option key={value} value={value}>{label(value)}</option>)}
          </select>
        </div>
        <div className="wa-table-wrap">
          <table className="wa-table">
            <thead><tr><th>Source</th><th>Capability</th><th>Health</th><th>Coverage</th><th>Observed</th></tr></thead>
            <tbody>
              {visible.length === 0 && <tr><td colSpan={5} className="wa-empty">No sources match this filter.</td></tr>}
              {visible.map((source) => (
                <tr key={source.id}>
                  <td><button type="button" className="wa-btn" onClick={() => setSelected(source)}>{source.name}</button></td>
                  <td>{label(source.capability)}</td>
                  <td>{label(source.health)}</td>
                  <td>{label(source.coverage)}{source.coveragePercent == null ? '' : ` · ${source.coveragePercent.toFixed(0)}%`}</td>
                  <td className="num">{source.observed == null ? '—' : formatCount(source.observed)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
      {selected && (
        <>
          <button className="wa-drawer-back" aria-label="Close source detail" onClick={() => setSelected(null)} />
          <aside className="wa-drawer" role="dialog" aria-label={selected.name}>
            <button className="wa-btn" type="button" onClick={() => setSelected(null)}>Close</button>
            <h3>{selected.name}</h3>
            <p className="wa-note">{selected.limitation}</p>
            <div className="wa-split"><span>Population</span><b>{selected.population}</b></div>
            <div className="wa-split"><span>Evidence</span><b>{label(selected.classification)}</b></div>
            <div className="wa-split"><span>Since</span><b>{selected.since ?? 'None'}</b></div>
            <div className="wa-split"><span>Last success</span><b>{selected.lastSuccess ?? 'None'}</b></div>
            <p className="wa-note">{selected.detail}</p>
            {selected.view && <button className="wa-btn" type="button" onClick={() => onOpenView(selected.view as string)}>Open related page</button>}
          </aside>
        </>
      )}
    </div>
  )
}
