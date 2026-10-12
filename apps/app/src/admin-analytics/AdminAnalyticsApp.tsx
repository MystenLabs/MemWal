import { useEffect, useMemo, useRef, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Activity, AlertTriangle, ClipboardCheck, Database, KeyRound, LayoutDashboard, LineChart, ListChecks, LogOut, Menu, Settings, Shield, Users, Wallet, X } from 'lucide-react'
import { useSearchParams } from 'react-router-dom'
import { AdminKeyEntry } from '../components/AdminKeyEntry'
import { fetchAdminActivity, type AdminActivity } from '../utils/admin-api'
import { ActivityPage, ConfigPage, IncidentLivePage, RetrievalLivePage, StorageLivePage, UploadJobsPage, WalletsPage, priorText } from './OpsPages'
import { QualityPage } from './QualityPage'
import { Drawer, useNarrow } from './Drawer'
import { Chevron } from './Controls'
import { DateRangeControl } from './DateRangeControl'
import { comparisonWindow, formatSpan, isRangeId, resolveRange, type CompareId, type RangeId } from './range'
import { config } from '../config'
import './admin-analytics.css'
import {
  buildDemo,
  bytePopulation,
  populationSummary,
  requestsInRange,
  type DemoAccount,
  type DemoRequest,
  type PopulationSummary,
} from './fixture'
import {

  formatBytes,
  formatCount,
  formatMetric,
  formatYmd,
  overheadPercent,
  percentile,
  toCsv,
  type Metric,
} from './metrics'

const VIEWS = [
  { id: 'overview', group: 'Analytics', label: 'Overview' },
  { id: 'storage', group: 'Analytics', label: 'Storage' },
  { id: 'retrieval', group: 'Analytics', label: 'Retrieval & Egress' },
  { id: 'accounts', group: 'Analytics', label: 'Accounts & Delegates' },
  { id: 'activity', group: 'Analytics', label: 'Activity & Adoption' },
  { id: 'uploads', group: 'Operations', label: 'Upload Jobs' },
  { id: 'wallets', group: 'Operations', label: 'Wallets & Costs' },
  { id: 'incidents', group: 'Operations', label: 'Incidents' },
  { id: 'quality', group: 'Operations', label: 'Data Quality' },
  { id: 'config', group: 'Administration', label: 'Configuration' },
  { id: 'access', group: 'Administration', label: 'Access & Audit' },
] as const

type ViewId = (typeof VIEWS)[number]['id']


interface Props {
  adminKey: string | null
  demo: boolean
  banner?: string
  isSubmitting: boolean
  onSignIn: (key: string) => Promise<void>
  onLogout: () => void
  onInvalidKey: () => void
}

function isView(value: string | null): value is ViewId {
  return VIEWS.some((view) => view.id === value)
}


function Spark({ points }: { points: number[] }) {
  const max = Math.max(1, ...points)
  const d = points.map((point, index) => {
    const x = (index / Math.max(1, points.length - 1)) * 72
    const y = 22 - (point / max) * 18
    return `${index === 0 ? 'M' : 'L'}${x.toFixed(1)} ${y.toFixed(1)}`
  }).join(' ')
  return (
    <svg className="wa-spark" width="76" height="24" viewBox="0 0 76 24" role="img" aria-label={`Seven day activity ${points.join(', ')}`}>
      <path d={d} fill="none" stroke="#8055ff" strokeWidth="1.6" />
    </svg>
  )
}

export function nearestBucket(clientX: number, left: number, width: number, count: number) {
  if (count <= 1 || width <= 0) return 0
  const ratio = (clientX - left) / width
  return Math.max(0, Math.min(count - 1, Math.round(ratio * (count - 1))))
}

function Chart({
  points,
  series,
}: {
  points: Array<{ label: string; relayer: number; upstream: number; requests: number; latency: number }>
  series: 'bytes' | 'requests' | 'latency'
}) {
  const [hover, setHover] = useState<number | null>(null)
  const width = 640
  const height = 230
  const pick = (point: typeof points[number]) => series === 'requests' ? point.requests : series === 'latency' ? point.latency : point.relayer
  const max = Math.max(1, ...points.map(pick))
  const x = (index: number) => 36 + (index / Math.max(1, points.length - 1)) * (width - 52)
  const y = (value: number) => 16 + (1 - value / max) * (height - 42)
  const line = points.map((point, index) => `${index === 0 ? 'M' : 'L'}${x(index).toFixed(1)} ${y(pick(point)).toFixed(1)}`).join(' ')
  const area = points.length ? `${line} L${x(points.length - 1).toFixed(1)} ${height - 26} L${x(0).toFixed(1)} ${height - 26} Z` : ''
  const unit = series === 'latency' ? 'ms' : series === 'requests' ? 'requests' : 'bytes'
  const inspect = (clientX: number, target: SVGSVGElement) => {
    const box = target.getBoundingClientRect()
    const index = nearestBucket(clientX, box.left, box.width, points.length)
    setHover((current) => current === index ? null : index)
  }
  const selected = hover != null ? points[hover] : null
  return (
    <div style={{ position: 'relative' }}>
      <svg className="wa-chart" viewBox={`0 0 ${width} ${height}`} role="img" tabIndex={0} aria-label={`${series} trend, ${points.length} buckets, peak ${max} ${unit}. Arrow keys inspect a bucket.`} onPointerUp={(event) => inspect(event.clientX, event.currentTarget)} onKeyDown={(event) => {
        if (event.key === 'Escape') setHover(null)
        if (event.key === 'ArrowRight') { event.preventDefault(); setHover((index) => Math.min(points.length - 1, (index ?? -1) + 1)) }
        if (event.key === 'ArrowLeft') { event.preventDefault(); setHover((index) => Math.max(0, (index ?? 1) - 1)) }
      }}>
        {[0, 0.5, 1].map((step) => (
          <g key={step}>
            <line x1="36" x2={width - 12} y1={y(max * (1 - step))} y2={y(max * (1 - step))} stroke="#2e2e2e" />
            <text x="4" y={y(max * (1 - step)) + 4} fill="#6f6f6f" fontSize="10">{series === 'bytes' ? formatBytes(BigInt(Math.round(max * (1 - step)))) : Math.round(max * (1 - step))}</text>
          </g>
        ))}
        <path d={area} fill="rgba(124, 106, 247, 0.08)" />
        <path d={line} fill="none" stroke="#7c6af7" strokeWidth="2" />
        {points.map((point, index) => (
          <circle key={point.label} cx={x(index)} cy={y(pick(point))} r={hover === index ? 4 : 2.5} fill="#7c6af7" />
        ))}
        {points.map((point, index) => index % Math.ceil(points.length / 6) === 0 ? (
          <text key={`${point.label}-x`} x={x(index)} y={height - 8} fill="#9a9a9a" fontSize="11" textAnchor="middle">{/^\d{4}-\d{2}-\d{2}T/.test(point.label) ? point.label.slice(11, 16) : /^\d{4}-\d{2}-\d{2}/.test(point.label) ? point.label.slice(5, 10) : point.label}</text>
        ) : null)}
      </svg>
      {selected && (
        <div className="wa-tip" role="status" style={{ left: 8, right: 8, top: 8 }}>{selected.label}: {series === 'bytes' ? formatBytes(BigInt(pick(selected))) : pick(selected)} {series === 'requests' ? 'memories' : unit}</div>
      )}
    </div>
  )
}

export function AdminAnalyticsApp({
  adminKey,
  demo,
  banner,
  isSubmitting,
  onSignIn,
  onLogout,
  onInvalidKey,
}: Props) {
  const [params, setParams] = useSearchParams()
  const view = isView(params.get('view')) ? params.get('view') as ViewId : 'overview'
  const range: RangeId = isRangeId(params.get('range')) ? params.get('range') as RangeId : '7d'
  const compare: CompareId = (['none', 'previous', 'week', 'month', 'year'] as const).includes(params.get('compare') as CompareId) ? params.get('compare') as CompareId : 'previous'
  const timeZone = params.get('tz') || 'Asia/Ho_Chi_Minh'
  const day = params.get('day') || formatYmd(new Date(), timeZone)
  const accountId = params.get('account') || ''
  const query = params.get('q') || ''
  const showAll = params.get('all') === '1'
  const [requestId, setRequestId] = useState<string | null>(null)
  const [navOpen, setNavOpen] = useState(false)
  const narrow = useNarrow()
  const [moreOpen, setMoreOpen] = useState(false)
  const menuButton = useRef<HTMLButtonElement>(null)
  const [sort, setSort] = useState<'egress' | 'requests' | 'latency'>('egress')
  const [series, setSeries] = useState<'bytes' | 'requests' | 'latency'>('bytes')
  const now = useMemo(() => new Date(), [])
  const model = useMemo(() => buildDemo(now), [now])
  const period = resolveRange(range, timeZone, now, { day, month: params.get('month') || undefined, year: params.get('year') || undefined, from: params.get('from') || undefined, to: params.get('to') || undefined })
  const compared = comparisonWindow(compare, period, timeZone)
  const activityQuery = useQuery({
    queryKey: ['admin', 'activity', period.start.toISOString(), period.end.toISOString(), compared?.start.toISOString() ?? ''],
    queryFn: () => fetchAdminActivity(adminKey as string, { start: period.start, end: period.end, priorStart: compared?.start ?? null }),
    enabled: !demo && Boolean(adminKey),
    retry: (count, error) => (error as Error).message !== 'INVALID_KEY' && count < 2,
  })
  const scoped = requestsInRange(model, period.start, period.end, accountId || undefined)
  const relayer = populationSummary(bytePopulation(scoped, 'relayerBytes'))
  const upstream = populationSummary(bytePopulation(scoped, 'upstreamBytes'))

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      setRequestId(null)
      setNavOpen(false)
      setMoreOpen(false)
      menuButton.current?.focus()
    }
    globalThis.addEventListener('keydown', onKey)
    return () => globalThis.removeEventListener('keydown', onKey)
  }, [])

  useEffect(() => {
    if (!navOpen) return
    const overflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    const panel = document.getElementById('admin-nav')
    panel?.querySelector<HTMLElement>("button[aria-label='Close navigation']")?.focus()
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Tab' || !panel) return
      const nodes = [...panel.querySelectorAll<HTMLElement>('button')].filter((node) => !node.hasAttribute('disabled'))
      const first = nodes[0]
      const last = nodes[nodes.length - 1]
      if (!first || !last) return
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus() }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus() }
    }
    document.addEventListener('keydown', onKey)
    return () => {
      document.body.style.overflow = overflow
      document.removeEventListener('keydown', onKey)
    }
  }, [navOpen])

  const setParam = (key: string, value: string) => {
    const next = new URLSearchParams(params)
    if (value) next.set(key, value)
    else next.delete(key)
    setParams(next, { replace: true })
  }

  const buckets = useMemo(() => {
    const map = new Map<string, { label: string; relayer: number; upstream: number; requests: number; latency: number }>()
    for (let cursor = period.start.getTime(); cursor < period.end.getTime(); cursor += 86400_000) {
      const label = formatYmd(new Date(cursor), timeZone)
      if (!map.has(label)) map.set(label, { label, relayer: 0, upstream: 0, requests: 0, latency: 0 })
    }
    for (const request of scoped) {
      const label = formatYmd(new Date(request.at), timeZone)
      const bucket = map.get(label) ?? { label, relayer: 0, upstream: 0, requests: 0, latency: 0 }
      bucket.relayer += Number(request.relayerBytes)
      bucket.upstream += Number(request.upstreamBytes ?? 0)
      bucket.requests += 1
      bucket.latency += request.latencyMs
      map.set(label, bucket)
    }
    return [...map.values()].sort((a, b) => a.label.localeCompare(b.label)).map((bucket) => ({
      ...bucket,
      latency: bucket.requests ? Math.round(bucket.latency / bucket.requests) : 0,
    }))
  }, [scoped, timeZone, period.start, period.end])

  const rows = model.accounts
    .map((account) => {
      const mine = requestsInRange(model, period.start, period.end, account.id)
      const bytes = populationSummary(bytePopulation(mine, 'relayerBytes'))
      return { account, mine, bytes }
    })
    .filter((row) => showAll || row.mine.length > 0 || row.account.status === 'live')
    .filter((row) => {
      const haystack = `${row.account.id} ${row.account.owner}`.toLowerCase()
      return haystack.includes(query.toLowerCase())
    })
    .sort((a, b) => {
      if (sort === 'requests') return b.mine.length - a.mine.length
      if (sort === 'latency') {
        const left = a.mine.reduce((total, request) => total + request.latencyMs, 0)
        const right = b.mine.reduce((total, request) => total + request.latencyMs, 0)
        return right - left
      }
      return a.bytes.total < b.bytes.total ? 1 : -1
    })

  const selected = model.accounts.find((account) => account.id === accountId) ?? null
  const selectedRequests = selected ? requestsInRange(model, period.start, period.end, selected.id) : []
  const openRequest = selectedRequests.find((request) => request.id === requestId) ?? scoped.find((request) => request.id === requestId) ?? null

  const exportView = () => {
    const live = activityQuery.data
    const header = demo
      ? ['definition_version', 'source', 'timezone', 'start', 'end', 'account', 'owner', 'requests', 'relayer_bytes']
      : ['source', 'generated_at', 'window_hours', 'owner', 'uploads_completed']
    const body = demo
      ? rows.map((row) => [
        model.definitionVersion,
        'demo-fixture',
        timeZone,
        period.start.toISOString(),
        period.end.toISOString(),
        row.account.id,
        row.account.owner,
        String(row.mine.length),
        row.bytes.total.toString(),
      ])
      : (live?.actions.topOwners ?? []).map((owner) => [
        'dev-relayer-activity',
        live?.generatedAt ?? '',
        period.label,
        owner.owner,
        String(owner.uploadsCompleted),
      ])
    if (!demo && body.length === 0) return
    const blob = new Blob([toCsv([header, ...body])], { type: 'text/csv;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const link = document.createElement('a')
    link.href = url
    link.download = `walrus-admin-${view}.csv`
    link.click()
    URL.revokeObjectURL(url)
  }
  return (
    <div className={`wa${navOpen ? ' wa-nav-open' : ''}`}>
      {navOpen && <button className="wa-nav-back" type="button" aria-label="Dismiss navigation" tabIndex={-1} onClick={() => { setNavOpen(false); menuButton.current?.focus() }} />}
      <aside id="admin-nav" className="wa-side" aria-label="Admin" aria-hidden={narrow && !navOpen ? true : undefined} inert={narrow && !navOpen ? true : undefined}>
        <div className="wa-brand">
          <img className="wa-logo" src="/walrus-memory-logo.svg?v=3" alt="Walrus Memory" />
          <button className="wa-icon-btn wa-drawer-close" type="button" aria-label="Close navigation" title="Close navigation" onClick={() => { setNavOpen(false); menuButton.current?.focus() }}><X size={18} /></button>
        </div>
        {['Analytics', 'Operations', 'Administration'].map((group) => (
          <div key={group}>
            <div className="wa-group">{group.toUpperCase()}</div>
            {VIEWS.filter((item) => item.group === group).map((item) => {
              const Icon = item.id === 'overview' ? LayoutDashboard : item.id === 'storage' ? Database : item.id === 'retrieval' ? Activity : item.id === 'accounts' ? Users : item.id === 'activity' ? LineChart : item.id === 'uploads' ? ListChecks : item.id === 'quality' ? ClipboardCheck : item.id === 'incidents' ? AlertTriangle : item.id === 'wallets' ? Wallet : item.id === 'config' ? Settings : item.id === 'access' ? Shield : KeyRound
              return (
              <button key={item.id} className="wa-navbtn" aria-current={view === item.id ? 'page' : undefined} onClick={() => { setParam('view', item.id); setNavOpen(false); menuButton.current?.focus() }}>
                <Icon className="wa-ico" size={14} />
                {item.label}
              </button>
              )
            })}
          </div>
        ))}
      </aside>
      <main className="wa-main">
        <div className="wa-mobile-bar">
          <button ref={menuButton} className="wa-btn wa-menu-btn" type="button" aria-expanded={navOpen} aria-controls="admin-nav" onClick={() => setNavOpen(true)}>
            <Menu size={14} aria-hidden="true" /> <span>Menu</span>
          </button>
          <strong>{VIEWS.find((item) => item.id === view)?.label}</strong>
        </div>
        <div className="wa-util">
          <div className="wa-crumb">Admin / <b>{VIEWS.find((item) => item.id === view)?.label}</b></div>
          <span className="wa-clock" title={timeZone}>{new Intl.DateTimeFormat('en-GB', { timeZone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(now)} <span className="wa-tz">{timeZone}</span></span>
          <button className="wa-btn" onClick={exportView} disabled={!demo && !activityQuery.data} title={demo ? 'Download the fixture account summary' : 'Download the live owner upload counts. Request-byte export is not stored.'}>Export</button>
          <span className="wa-env" title={demo ? 'Demo data. Node egress unavailable. Incident year not verified.' : 'Live request egress is unavailable. Wallet and activity routes are separate.'}>Notices</span>
          <button className="wa-btn" type="button" onClick={onLogout}><LogOut size={14} aria-hidden="true" /> <span>Sign out</span></button>
          <div className="wa-more">
            <button className="wa-more-btn wa-btn" type="button" aria-expanded={moreOpen} onClick={() => setMoreOpen((open) => !open)}><span>More</span><Chevron /></button>
            {moreOpen && (
              <div className="wa-more-list">
                <button className="wa-btn" type="button" onClick={() => { exportView(); setMoreOpen(false) }}>Export</button>
                <button className="wa-btn" type="button" onClick={onLogout}>Sign out</button>
              </div>
            )}
          </div>
        </div>
        <div className="wa-head">
          <div className="wa-title">
            <h1>{view === 'overview' ? 'Memory overview' : VIEWS.find((item) => item.id === view)?.label}</h1>
            <p>{view === 'activity' ? 'Account usage, delegate activity and adoption trends' : view === 'uploads' ? 'Upload progress, failures and processing health' : view === 'wallets' ? 'Uploader balances, sponsor funding and measured spend' : view === 'incidents' ? 'Investigate changes in retrieval traffic and performance' : view === 'quality' ? 'Measurement coverage, freshness and collection gaps' : view === 'config' ? 'Relayer settings and operational thresholds' : view === 'access' ? 'Admin sessions and recorded administrative activity' : view === 'storage' ? 'Plaintext, encrypted payload and encoded inventory' : view === 'retrieval' ? 'Request bytes, latency and transfer boundaries' : view === 'accounts' ? 'Owner wallets, delegate keys and selected-day activity' : 'Storage, retrieval and account activity'}</p>
          </div>
          <div className="wa-actions">
            {['overview', 'retrieval', 'accounts', 'activity', 'uploads', 'incidents'].includes(view) && (
              <DateRangeControl
                range={range}
                label={period.label}
                rangeTitle={`${formatSpan(period.start, period.end, timeZone)} · ${timeZone}. Rolling day presets are 24-hour windows and can touch an extra calendar date.`}
                compare={compare}
                compareLabel={compared ? `Comparison · ${formatSpan(compared.start, compared.end, timeZone)}` : 'No comparison'}
                selected={{ day, month: params.get('month') || undefined, year: params.get('year') || undefined }}
                onCommit={(patch) => {
                  const next = new URLSearchParams(params)
                  next.set('range', patch.range)
                  const values: Record<string, string | undefined> = {
                    day: patch.range === 'day' ? patch.day : undefined,
                    month: patch.range === 'month-pick' ? patch.month : undefined,
                    year: patch.range === 'year-pick' ? patch.year : undefined,
                    from: patch.range === 'custom' ? patch.from : undefined,
                    to: patch.range === 'custom' ? patch.to : undefined,
                  }
                  for (const [key, value] of Object.entries(values)) {
                    if (value) next.set(key, value)
                    else next.delete(key)
                  }
                  setParams(next, { replace: true })
                }}
                onCompare={(id) => setParam('compare', id === 'previous' ? '' : id)}
              />
            )}
            <span className="wa-env">dev · {config.suiNetwork}</span>
          </div>
        </div>
        {banner && <p className="wa-note" role="status" style={{ padding: '8px 16px' }}>{banner}</p>}
        {['overview', 'storage', 'retrieval', 'accounts'].includes(view) && (
          <div className="wa-seg" role="tablist" aria-label="Scope">
            {(['overview', 'storage', 'retrieval', 'accounts'] as ViewId[]).map((id) => (
              <button key={id} role="tab" aria-selected={view === id} onClick={() => setParam('view', id)}>
                {id === 'overview' ? 'Overview' : id === 'storage' ? 'Storage' : id === 'retrieval' ? 'Retrieval' : 'Accounts'}
              </button>
            ))}
          </div>
        )}
        {view === 'overview' && !demo && (
          <LiveOverview
            activity={activityQuery.data}
            loading={activityQuery.isLoading}
            error={activityQuery.error as Error | null}
            periodLabel={period.label}
            comparing={compare !== 'none'}
            windowEnd={period.end}
            timeZone={timeZone}
            onInvalidKey={onInvalidKey}
            onRetry={() => activityQuery.refetch()}
          />
        )}
        {view === 'overview' && demo && (
          <>
            <KpiStrip relayer={relayer} upstream={upstream} requests={scoped} accounts={rows.length} storage={model.accounts} />
            <div className="wa-board">
              <section className="wa-panel wa-chart-panel">
                <div className="wa-chart-head">
                  <h2>Retrieval trend</h2>
                  <div className="wa-legend">
                    {(['bytes', 'requests', 'latency'] as const).map((item) => (
                      <button key={item} aria-pressed={series === item} onClick={() => setSeries(item)}>
                        <i className="wa-swatch" style={{ background: item === 'bytes' ? '#7c6af7' : item === 'requests' ? '#5b8def' : '#e6c15a' }} />
                        {item}
                      </button>
                    ))}
                  </div>
                </div>
                <Chart points={buckets} series={series} />
              </section>
              <aside className="wa-rail">
                <Lifecycle requests={scoped} />
                <Sources requests={scoped} />
                <Contributors rows={rows} onOpen={(id) => setParam('account', id)} />
              </aside>
              <AccountTable rows={rows} sort={sort} onSort={setSort} onOpen={(id) => setParam('account', id)} query={query} onQuery={(value) => setParam('q', value)} showAll={showAll} onShowAll={(value) => setParam('all', value ? '1' : '')} />
            </div>
          </>
        )}

        {view === 'storage' && (demo ? <StorageView accounts={model.accounts} /> : adminKey && <StorageLivePage adminKey={adminKey} onInvalidKey={onInvalidKey} />)}
        {view === 'retrieval' && (demo ? (
          <RetrievalView
            requests={scoped}
            relayer={relayer}
            upstream={upstream}
            onOpen={setRequestId}
          />
        ) : <RetrievalLivePage adminKey={adminKey} start={period.start} end={period.end} onInvalidKey={onInvalidKey} onOpenQuality={() => setParam('view', 'quality')} />)}
        {view === 'accounts' && (demo ? (
          <AccountTable rows={rows} sort={sort} onSort={setSort} onOpen={(id) => setParam('account', id)} query={query} onQuery={(value) => setParam('q', value)} showAll={showAll} onShowAll={(value) => setParam('all', value ? '1' : '')} />
        ) : <ActivityPage activity={activityQuery.data} loading={activityQuery.isLoading} error={activityQuery.error as Error | null} periodLabel={period.label} comparing={compare !== 'none'} windowHours={(period.end.getTime() - period.start.getTime()) / 3_600_000} onInvalidKey={onInvalidKey} onRetry={() => activityQuery.refetch()} />)}
        {view === 'activity' && <ActivityPage activity={activityQuery.data} loading={activityQuery.isLoading} error={activityQuery.error as Error | null} periodLabel={period.label} comparing={compare !== 'none'} windowHours={(period.end.getTime() - period.start.getTime()) / 3_600_000} onInvalidKey={onInvalidKey} onRetry={() => activityQuery.refetch()} />}
        {view === 'uploads' && adminKey && <UploadJobsPage adminKey={adminKey} onInvalidKey={onInvalidKey} periodLabel={period.label} start={period.start} end={period.end} priorStart={compared?.start ?? null} />}
        {view === 'wallets' && adminKey && <WalletsPage adminKey={adminKey} onInvalidKey={onInvalidKey} activity={activityQuery.data} />}
        {view === 'incidents' && (demo ? <IncidentView modelStart={model.incident} requests={scoped} now={now} timeZone={timeZone} /> : <IncidentLivePage adminKey={adminKey} period={period} timeZone={timeZone} baseline={compared} onInvalidKey={onInvalidKey} onOpenDay={(ymd) => { const next = new URLSearchParams(params); next.set('range', 'day'); next.set('day', ymd); setParams(next) }} onOpenQuality={() => setParam('view', 'quality')} />)}
        {view === 'quality' && (demo ? <QualityView demo /> : <QualityPage adminKey={adminKey} onInvalidKey={onInvalidKey} onOpenView={(id) => setParam('view', id)} />)}
        {view === 'config' && adminKey && <ConfigPage adminKey={adminKey} onInvalidKey={onInvalidKey} />}
        {view === 'access' && (
          <section className="wa-panel">
            <h3>Access & audit</h3>
            <p className="wa-note">Admin key only. Builder, insider, owner, and delegate credentials do not open this site. Analytics do not include plaintext memories or private keys.</p>
            {adminKey ? <p className="wa-note">Signed in for {config.suiNetwork}. Exports from this browser session are labeled {demo ? 'demo-fixture' : 'unavailable'}.</p> : (
              <AdminKeyEntry onKeySubmit={onSignIn} isLoading={isSubmitting} banner={banner} />
            )}
          </section>
        )}

        {selected && (
          <Drawer title={selected.id} label={`${selected.id} day detail`} onClose={() => setParam('account', '')}>
            <p className="wa-mono">{selected.owner}</p>
              <p className="wa-note">Status now: {selected.status}. Historical status for this day is the same in the demo fixture because no chain checkpoint ledger is connected. Registered keys {selected.registeredKeys}. Used keys {new Set(selectedRequests.map((request) => request.delegateId ?? 'owner-session')).size}.</p>
              <div className="wa-split"><span>Plaintext</span><b>{formatMetric(selected.plaintext)}</b></div>
              <div className="wa-split"><span>Encrypted</span><b>{formatMetric(selected.encrypted)}</b></div>
              <div className="wa-split"><span>Encoded</span><b className={selected.encoded.state === 'unavailable' ? 'wa-unavailable' : ''}>{formatMetric(selected.encoded)}</b></div>
              <h3>Delegates</h3>
              {['fp_a1b2c3', 'fp_c3d4e5', null].map((id) => {
                const used = selectedRequests.filter((request) => request.delegateId === id)
                const status = id === 'fp_c3d4e5' ? 'revoked' : id ? 'active' : 'owner-session'
                return (
                  <div className="wa-split" key={id ?? 'owner'}>
                    <span>{id ?? 'owner/session · no delegate'}</span>
                    <b>{status} · {used.length} requests</b>
                  </div>
                )
              })}
              <h3>Requests</h3>
              {selectedRequests.length === 0 && <p className="wa-note">No authenticated product operations in this window. This is a verified empty population, not a missing source.</p>}
              {selectedRequests.slice(0, 40).map((request) => (
                <button key={request.id} className="wa-btn" onClick={() => setRequestId(request.id)}>
                  {request.id} · {request.operation} · {request.status}
                </button>
              ))}
              {selectedRequests.length > 40 && <p className="wa-note">Showing 40 of {selectedRequests.length}. Export the view for the full list. This page does not pretend the truncated rows are the population.</p>}
          </Drawer>
        )}
        {openRequest && <RequestDrawer request={openRequest} onClose={() => setRequestId(null)} />}
      </main>
    </div>
  )
}

function LiveOverview({
  activity,
  loading,
  error,
  periodLabel,
  windowEnd,
  timeZone,
  comparing,
  onInvalidKey,
  onRetry,
}: {
  activity: AdminActivity | undefined
  loading: boolean
  error: Error | null
  periodLabel: string
  windowEnd: Date
  timeZone: string
  comparing: boolean
  onInvalidKey: () => void
  onRetry: () => void
}) {
  if (error?.message === 'INVALID_KEY') onInvalidKey()
  if (!activity) {
    return <ActivityPage activity={activity} loading={loading} error={error} periodLabel={periodLabel} comparing={comparing} windowHours={0} onInvalidKey={onInvalidKey} onRetry={onRetry} />
  }
  const days = activity.actions.memoriesByDay.filter((day) => day.day < formatYmd(windowEnd, timeZone) || formatYmd(new Date(windowEnd.getTime() - 1), timeZone) === day.day)
  const buckets = activity.actions.memoriesByHour?.map((row) => ({ label: row.hour, relayer: 0, upstream: 0, requests: row.count, latency: 0 }))
    ?? days.map((day) => ({ label: day.day, relayer: 0, upstream: 0, requests: day.count, latency: 0 }))
  const written = (activity.actions.memoriesByHour ?? days).reduce((sum, row) => sum + row.count, 0)
  const maxUploads = Math.max(1, ...activity.actions.topOwners.map((owner) => owner.uploadsCompleted))
  const outcomes: Array<[string, number]> = [
    ['Completed', activity.actions.uploadsCompleted],
    ['Failed', activity.actions.uploadsFailed],
  ]
  const outcomeMax = Math.max(1, ...outcomes.map(([, count]) => count))
  return (
    <>
      <div className="wa-kpis">
        <article className="wa-kpi"><div className="label">Memories written</div><div className="value">{formatCount(written)}</div><div className="delta">{periodLabel}</div></article>
        <article className="wa-kpi"><div className="label">Uploads completed</div><div className="value">{formatCount(activity.actions.uploadsCompleted)}</div><div className="delta">{priorText(comparing, activity.actions.uploadsCompletedPrior)}</div></article>
        <article className="wa-kpi"><div className="label">Uploads failed</div><div className="value">{formatCount(activity.actions.uploadsFailed)}</div><div className="delta">{priorText(comparing, activity.actions.uploadsFailedPrior)}</div></article>
        <article className="wa-kpi"><div className="label">In flight</div><div className="value">{formatCount(activity.actions.uploadsInFlight)}</div><div className="delta">Current jobs</div></article>
        <article className="wa-kpi"><div className="label" title="Request-byte percentiles are not stored.">Retrieval bytes p99</div><div className="value wa-unavailable">—</div><div className="delta">Unavailable</div></article>
        <article className="wa-kpi"><div className="label" title="Top 8 owners with completed uploads, not every account.">Owners listed</div><div className="value">{formatCount(activity.actions.topOwners.length)}</div><div className="delta">Top 8</div></article>
      </div>
      <div className="wa-board">
        <section className="wa-panel wa-chart-panel">
          <div className="wa-chart-head"><h2>Memories written</h2><span className="wa-note">{activity.windowStart ? periodLabel : `${periodLabel} requested. Relayer has not applied that window.`}{activity.clamped ? ' · shortened to the query limit' : ''}</span></div>
          <Chart points={buckets} series="requests" />
        </section>
        <aside className="wa-rail">
          <section>
            <h2>Upload outcomes</h2>
            <p className="wa-note">Completed and failed jobs in the selected window. Bar length is compared with the larger of those two counts.</p>
            {outcomes.map(([label, count]) => (
              <div className="wa-bar-row" key={label}>
                <span>{label}</span>
                <div className="wa-bar"><i style={{ width: `${(count / outcomeMax) * 100}%` }} /></div>
                <b>{count}</b>
              </div>
            ))}
          </section>
          <section>
            <h2>Other operations</h2>
            <div className="wa-split"><span>Deletes in window</span><b>{formatCount(activity.actions.memoryDeletes)}</b></div>
            <div className="wa-split"><span>In flight now</span><b>{formatCount(activity.actions.uploadsInFlight)}</b></div>
          </section>
          <section>
            <h2>Sponsored actions</h2>
            {activity.actions.sponsored.length === 0 && <p className="wa-note">None in this window.</p>}
            {activity.actions.sponsored.map((row) => (
              <div className="wa-split" key={row.kind}><span>{row.kind === 'create_account' ? 'Account creation' : row.kind === 'add_delegate_key' ? 'Delegate added' : row.kind === 'remove_delegate_key' ? 'Delegate removed' : row.kind}</span><b>{row.count}</b></div>
            ))}
          </section>
        </aside>
        <section className="wa-panel wa-table-panel">
          <h2>Completed uploads</h2>
          <div className="wa-table-wrap">
            <table className="wa-table">
              <thead><tr><th>Owner</th><th>Uploads</th><th>Vs leader</th></tr></thead>
              <tbody>
                {activity.actions.topOwners.map((owner) => (
                  <tr key={owner.owner}>
                    <td className="wa-mono">{owner.owner}</td>
                    <td>{owner.uploadsCompleted}</td>
                    <td>{Math.round((owner.uploadsCompleted / maxUploads) * 100)}%</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      </div>
    </>
  )
}

function KpiStrip({
  relayer,
  upstream,
  requests,
  accounts,
  storage,
}: {
  relayer: PopulationSummary
  upstream: PopulationSummary
  requests: DemoRequest[]
  accounts: number
  storage: DemoAccount[]
}) {
  const plaintext = storage.reduce((total, account) => account.plaintext.state === 'measured' ? total + account.plaintext.value : total, 0n)
  const encrypted = storage.reduce((total, account) => account.encrypted.state === 'measured' ? total + account.encrypted.value : total, 0n)
  const knownPlain = storage.filter((account) => account.plaintext.state === 'measured').length
  const cells: Array<{ label: string; value: string; meta: string; warn?: boolean }> = [
    { label: 'Live memories', value: '—', meta: 'No inventory snapshot', warn: true },
    { label: 'Plaintext storage', value: formatBytes(plaintext), meta: `Known ${knownPlain}/${storage.length}` },
    { label: 'Encrypted payload', value: formatBytes(encrypted), meta: 'Demo snapshot' },
    { label: 'Encoded storage', value: '—', meta: 'Field not verified', warn: true },
    { label: 'Retrieval requests', value: formatCount(requests.length), meta: relayer.p99 == null ? 'No baseline' : `p99 ${formatBytes(relayer.p99)}` },
    { label: 'Active accounts', value: formatCount(accounts), meta: `Upstream ${formatBytes(upstream.total)}` },
  ]
  return (
    <div className="wa-kpis">
      {cells.map((cell) => (
        <article className="wa-kpi" key={cell.label}>
          <div className="label" title={cell.meta}>{cell.label}</div>
          <div className={`value${cell.warn ? ' wa-unavailable' : ''}`}>{cell.value}</div>
          <div className="delta" title={cell.meta}>{cell.warn ? 'Unavailable' : cell.meta}</div>
        </article>
      ))}
    </div>
  )
}

function Lifecycle({ requests }: { requests: DemoRequest[] }) {
  const stages: Array<[string, number]> = [['Accepted', 48], ['Encrypted', 46], ['Uploaded', 41], ['Certified', 39], ['Indexed', 37]]
  return (
    <section>
      <h2>Write lifecycle</h2>
      <p className="wa-note" title={`${requests.length} retrievals are a separate population and are not added here.`}>Demo cohort. Not live upload jobs.</p>
      {stages.map(([label, count]) => (
        <div className="wa-bar-row" key={label}>
          <span>{label}</span>
          <div className="wa-bar"><i style={{ width: `${(count / 48) * 100}%` }} /></div>
          <b>{count}</b>
        </div>
      ))}
    </section>
  )
}

function Sources({ requests }: { requests: DemoRequest[] }) {
  const counts = new Map<string, number>()
  for (const request of requests) counts.set(request.source, (counts.get(request.source) ?? 0) + 1)
  const total = requests.length || 1
  const colors: Record<string, string> = { mcp: '#7c6af7', sdk: '#5b8def', 'python-sdk': '#e36ad2', unknown: '#e6c15a' }
  let offset = 0
  const rings = [...counts.entries()].map(([source, count]) => {
    const fraction = (count / total) * 100
    const ring = { source, count, fraction, offset, color: colors[source] ?? '#8d8d8d' }
    offset += fraction
    return ring
  })
  return (
    <section>
      <h2>Integration sources</h2>
      <div className="wa-donut">
        <svg viewBox="0 0 42 42" width="120" height="120" role="img" aria-label={`Integration mix, ${requests.length} requests`}>
          {rings.map((ring) => (
            <circle key={ring.source} cx="21" cy="21" r="14" fill="none" stroke={ring.color} strokeWidth="6" strokeDasharray={`${ring.fraction} ${100 - ring.fraction}`} strokeDashoffset={25 - ring.offset} pathLength="100" />
          ))}
          <text x="21" y="23" textAnchor="middle" fill="#ededed" fontSize="7">{requests.length}</text>
        </svg>
        <div className="wa-donut-legend">
          {rings.map((ring) => (
            <button key={ring.source} type="button">
              <span><i className="wa-swatch" style={{ background: ring.color }} /> {ring.source === 'unknown' ? 'Unknown' : ring.source}</span>
              <b>{Math.round(ring.fraction)}%</b>
            </button>
          ))}
        </div>
      </div>
    </section>
  )
}

function Contributors({
  rows,
  onOpen,
}: {
  rows: Array<{ account: DemoAccount; bytes: PopulationSummary }>
  onOpen: (id: string) => void
}) {
  return (
    <section>
      <h2>Top contributors</h2>
      {rows.slice(0, 4).map((row) => (
        <button className="wa-contrib" key={row.account.id} type="button" onClick={() => onOpen(row.account.id)}>
          <span>{row.account.id}</span>
          <b>{formatBytes(row.bytes.total)}</b>
        </button>
      ))}
    </section>
  )
}

function AccountTable({
  rows,
  sort,
  onSort,
  onOpen,
  query,
  onQuery,
  showAll,
  onShowAll,
}: {
  rows: Array<{ account: DemoAccount; mine: DemoRequest[]; bytes: PopulationSummary }>
  sort: 'egress' | 'requests' | 'latency'
  onSort: (sort: 'egress' | 'requests' | 'latency') => void
  onOpen: (id: string) => void
  query: string
  onQuery: (value: string) => void
  showAll: boolean
  onShowAll: (value: boolean) => void
}) {
  return (
    <section className="wa-panel wa-table-panel">
      <h2>Account activity</h2>
      <div className="wa-top">
        <input className="wa-input wa-search" aria-label="Search accounts" placeholder="Search account or owner" value={query} onChange={(event) => onQuery(event.target.value)} />
        <label className="wa-note"><input type="checkbox" checked={showAll} onChange={(event) => onShowAll(event.target.checked)} /> All accounts, including verified zero activity</label>
      </div>
      <div className="wa-table-wrap">
        <table className="wa-table">
          <thead>
            <tr>
              <th className="pin">Account</th>
              <th>Status</th>
              <th><button type="button" onClick={() => onSort('requests')}>Requests{sort === 'requests' ? ' ↓' : ''}</button></th>
              <th><button type="button" onClick={() => onSort('egress')}>Relayer bytes{sort === 'egress' ? ' ↓' : ''}</button></th>
              <th>p99 bytes</th>
              <th><button type="button" onClick={() => onSort('latency')}>p99 latency{sort === 'latency' ? ' ↓' : ''}</button></th>
              <th>7d</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => {
              const latencyP99 = percentile(row.mine.map((request) => BigInt(request.latencyMs)), 99)
              return (
              <tr key={row.account.id} onClick={() => onOpen(row.account.id)}>
                <td className="pin"><span className="wa-id">{row.account.id}</span><span className="wa-sub">{row.account.owner.slice(0, 8)}…{row.account.owner.slice(-4)}</span></td>
                <td>{row.account.status}</td>
                <td>{row.mine.length}</td>
                <td>{formatBytes(row.bytes.total)}</td>
                <td>{row.bytes.p99 == null ? '—' : formatBytes(row.bytes.p99)}</td>
                <td>{latencyP99 == null ? '—' : `${latencyP99.toString()} ms`}</td>
                <td><Spark points={row.account.spark} /></td>
              </tr>
              )
            })}

          </tbody>
        </table>
      </div>
    </section>
  )
}

function StorageView({ accounts }: { accounts: DemoAccount[] }) {
  const plaintext = fold(accounts, 'plaintext')
  const encrypted = fold(accounts, 'encrypted')
  const encoded = fold(accounts, 'encoded')
  return (
    <section className="wa-panel">
      <h3>Three sizes</h3>
      <p className="wa-note">Inventory is labeled as of the demo snapshot, not the selected flow window. Historical day-end inventory has no snapshot ledger, so selected-day and comparison-day columns are unavailable.</p>
      <div className="wa-table-wrap">
        <table className="wa-table">
          <thead>
            <tr>
              <th>Metric</th>
              <th>Now</th>
              <th>Selected day end</th>
              <th>Comparison day end</th>
            </tr>
          </thead>
          <tbody>
            <tr><td>Plaintext</td><td>{formatMetric(plaintext)}</td><td className="wa-unavailable">Unavailable</td><td className="wa-unavailable">Unavailable</td></tr>
            <tr><td>Encrypted payload</td><td>{formatMetric(encrypted)}</td><td className="wa-unavailable">Unavailable</td><td className="wa-unavailable">Unavailable</td></tr>
            <tr><td>Encoded storage</td><td>{formatMetric(encoded)}</td><td className="wa-unavailable">Unavailable</td><td className="wa-unavailable">Unavailable</td></tr>
            <tr><td>Encryption overhead</td><td>{formatMetric(overheadPercent(encrypted, plaintext), 'points')}</td><td className="wa-unavailable">Unavailable</td><td className="wa-unavailable">Unavailable</td></tr>
            <tr><td>Encoding overhead</td><td>{formatMetric(overheadPercent(encoded, encrypted), 'points')}</td><td className="wa-unavailable">Unavailable</td><td className="wa-unavailable">Unavailable</td></tr>
          </tbody>
        </table>
      </div>
      <p className="wa-note">Shared blobs are not deduplicated here because content identity is not in the current admin API. Global totals must not be summed from these per-account figures.</p>
    </section>
  )
}

function fold(accounts: DemoAccount[], key: 'plaintext' | 'encrypted' | 'encoded'): Metric {
  const values = accounts.map((account) => account[key])
  if (values.some((metric) => metric.state === 'unavailable') && key !== 'plaintext') {
    if (values.every((metric) => metric.state === 'unavailable')) return values[0]
  }
  const measured = values.filter((metric): metric is Extract<Metric, { state: 'measured' | 'estimated' }> => metric.state !== 'unavailable')
  if (measured.length === 0) return { state: 'unavailable', reason: 'No measured rows' }
  const value = measured.reduce((total, metric) => total + metric.value, 0n)
  const coverage = measured.reduce((total, metric) => total + metric.coverage, 0) / accounts.length
  if (measured.some((metric) => metric.state === 'estimated')) {
    return { state: 'estimated', value, coverage, method: 'Sum of estimated account rows. Not a protocol measurement.' }
  }
  if (measured.length !== accounts.length) {
    return { state: 'estimated', value, coverage, method: `Known bytes only. Coverage ${measured.length}/${accounts.length} accounts.` }
  }
  return { state: 'measured', value, coverage }
}

function RetrievalView({
  requests,
  relayer,
  upstream,
  onOpen,
}: {
  requests: DemoRequest[]
  relayer: PopulationSummary
  upstream: PopulationSummary
  onOpen: (id: string) => void
}) {
  return (
    <section className="wa-panel">
      <h3>Egress by boundary</h3>
      <p className="wa-note">p50/p90/p99 are bytes per logical request, calculated on this window&apos;s population. They are not added across hops.</p>
      <div className="wa-table-wrap">
        <table className="wa-table">
          <thead>
            <tr><th>Boundary</th><th>Requests</th><th>Measured</th><th>Total</th><th>p50</th><th>p90</th><th>p99</th></tr>
          </thead>
          <tbody>
            <tr>
              <td>Relayer → client</td>
              <td>{requests.length}</td>
              <td>{relayer.samples}</td>
              <td>{formatBytes(relayer.total)}</td>
              <td>{relayer.p50 == null ? 'Unavailable' : formatBytes(relayer.p50)}</td>
              <td>{relayer.p90 == null ? 'Unavailable' : formatBytes(relayer.p90)}</td>
              <td>{relayer.p99 == null ? 'Unavailable' : formatBytes(relayer.p99)}{relayer.tailUnstable ? ' · unstable' : ''}</td>
            </tr>
            <tr>
              <td>Aggregator → relayer</td>
              <td>{requests.length}</td>
              <td>{upstream.samples}</td>
              <td>{formatBytes(upstream.total)}</td>
              <td>{upstream.p50 == null ? 'Unavailable' : formatBytes(upstream.p50)}</td>
              <td>{upstream.p90 == null ? 'Unavailable' : formatBytes(upstream.p90)}</td>
              <td>{upstream.p99 == null ? 'Unavailable' : formatBytes(upstream.p99)}</td>
            </tr>
            <tr>
              <td>Storage node</td>
              <td>{requests.length}</td>
              <td>0</td>
              <td className="wa-unavailable">Unavailable</td>
              <td className="wa-unavailable">Unavailable</td>
              <td className="wa-unavailable">Unavailable</td>
              <td className="wa-unavailable">Unavailable</td>
            </tr>
          </tbody>
        </table>
      </div>
      <h3>Requests</h3>
      <div className="wa-table-wrap">
        <table className="wa-table">
          <thead><tr><th>Request</th><th>Account</th><th>Delegate</th><th>Status</th><th>Relayer bytes</th></tr></thead>
          <tbody>
            {requests.slice(0, 25).map((request) => (
              <tr key={request.id} onClick={() => onOpen(request.id)}>
                <td className="wa-mono">{request.id}</td>
                <td>{request.accountId}</td>
                <td>{request.delegateId ?? 'owner/session'}</td>
                <td>{request.status}</td>
                <td>{formatBytes(BigInt(request.relayerBytes))}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {requests.length > 25 && <p className="wa-note">Showing 25 of {requests.length}. Export includes the account summary, not a silently complete request dump.</p>}
    </section>
  )
}


function IncidentView({
  modelStart,
  requests,
  now,
  timeZone,
}: {
  modelStart: { label: string; start: string; end: string }
  requests: DemoRequest[]
  now: Date
  timeZone: string
}) {
  const during = requests.filter((request) => request.at >= modelStart.start && request.at < modelStart.end)
  const beforeStart = new Date(Date.parse(modelStart.start) - (Date.parse(modelStart.end) - Date.parse(modelStart.start)))
  const before = requests.filter((request) => request.at >= beforeStart.toISOString() && request.at < modelStart.start)
  const duringBytes = populationSummary(bytePopulation(during, 'relayerBytes'))
  const beforeBytes = populationSummary(bytePopulation(before, 'relayerBytes'))
  return (
    <section className="wa-panel">
      <h3>Incident comparison</h3>
      <p className="wa-note">{modelStart.label} Timezone {timeZone}. Now {now.toISOString()}.</p>
      <div className="wa-table-wrap">
        <table className="wa-table">
          <thead><tr><th>Window</th><th>Requests</th><th>Relayer p50</th><th>Relayer p99</th><th>Node p99</th></tr></thead>
          <tbody>
            <tr>
              <td>Before</td>
              <td>{before.length}</td>
              <td>{beforeBytes.p50 == null ? 'No baseline' : formatBytes(beforeBytes.p50)}</td>
              <td>{beforeBytes.p99 == null ? 'No baseline' : formatBytes(beforeBytes.p99)}</td>
              <td className="wa-unavailable">Unavailable</td>
            </tr>
            <tr>
              <td>During</td>
              <td>{during.length}</td>
              <td>{duringBytes.p50 == null ? 'No baseline' : formatBytes(duringBytes.p50)}</td>
              <td>{duringBytes.p99 == null ? 'No baseline' : formatBytes(duringBytes.p99)}</td>
              <td className="wa-unavailable">Unavailable</td>
            </tr>
          </tbody>
        </table>
      </div>
    </section>
  )
}

function QualityView({ demo }: { demo: boolean }) {
  const rows = [
    ['Live memory count', 'Unavailable', 'No daily inventory snapshot'],
    ['Plaintext bytes', demo ? 'Partial demo' : 'Unavailable', 'Production rows do not store plaintext length'],
    ['Encrypted bytes', demo ? 'Demo snapshot' : 'Queryable as blob_size_bytes, not wired'],
    ['Encoded bytes', 'Unavailable', 'Walrus encoded field not verified'],
    ['Relayer egress percentiles', demo ? 'Demo population' : 'Unavailable', 'No request-byte histogram'],
    ['Node egress', 'Unavailable', 'No correlated node telemetry'],
    ['Delegate registry', 'Unavailable', 'Auth cache is not the registry'],
  ]
  return (
    <section className="wa-panel">
      <h3>Data quality</h3>
      <div className="wa-table-wrap">
        <table className="wa-table">
          <thead><tr><th>Metric</th><th>State</th><th>Why</th></tr></thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row[0]}><td>{row[0]}</td><td>{row[1]}</td><td>{row[2]}</td></tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  )
}

function RequestDrawer({ request, onClose }: { request: DemoRequest; onClose: () => void }) {
  return (
    <Drawer title={request.id} label={`Request ${request.id}`} onClose={onClose}>
      <p className="wa-mono">{request.at}</p>
      <div className="wa-split"><span>Actor</span><b>{request.delegateId ?? 'owner/session'}</b></div>
      <div className="wa-split"><span>Operation</span><b>{request.operation}</b></div>
      <div className="wa-split"><span>Source</span><b>{request.source}</b></div>
      <div className="wa-split"><span>Namespace</span><b>{request.namespace}</b></div>
      <div className="wa-split"><span>Cache</span><b>{request.cache}</b></div>
      <div className="wa-split"><span>Latency</span><b>{request.latencyMs} ms</b></div>
      <h3>Transfer attempts</h3>
      {request.attempts.map((attempt) => (
        <div className="wa-hop" key={attempt.id}>
          <strong>{attempt.hop}</strong>
          <div className="wa-note">{attempt.upstream} · {attempt.outcome}</div>
          <div>{attempt.bytes == null ? <span className="wa-unavailable">Bytes unavailable</span> : formatBytes(BigInt(attempt.bytes))}</div>
        </div>
      ))}
    </Drawer>
  )
}
