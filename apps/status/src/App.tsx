import { useCallback, useEffect, useMemo, useState } from 'react'
import { AlertTriangle, ChevronLeft, ChevronRight, ExternalLink, RefreshCw } from 'lucide-react'

type StatusKind = 'operational' | 'degraded' | 'outage' | 'monitoring' | 'unknown'
type LoadState = 'loading' | 'ready' | 'error'
type HistoryTab = 'incidents' | 'uptime'

interface HealthPayload {
  status?: string
  version?: string
  relayerVersion?: string
  apiVersion?: string
  mode?: string
  minSupportedSdk?: {
    typescript?: string
    python?: string
    mcp?: string
  }
  featureFlags?: Record<string, boolean>
  build?: {
    commit?: string
    buildTimestamp?: string
  }
}

interface DependencyStatus {
  name: string
  status: StatusKind
  url: string
}

interface HistoryBucket {
  date: string
  status: StatusKind
  total: number
  ok: number
  degraded: number
  outage: number
}

interface StatusHistory {
  enabled: boolean
  source: string
  days: number
  target: string
  totalChecks: number
  uptimePct: number | null
  unavailableReason: string | null
  buckets: HistoryBucket[]
}

interface StatusSnapshot {
  generatedAt: string
  service: {
    name: string
    status: StatusKind
    runtime?: string
    historyEnabled?: boolean
  }
  relayer: {
    name: string
    status: StatusKind
    url: string
    httpStatus: number | null
    latencyMs: number | null
    checkedAt: string
    health: HealthPayload | null
    error: string | null
  }
  history: StatusHistory
  database?: {
    configured: boolean
    ready: boolean
    error: string | null
  }
  dependencies: DependencyStatus[]
}

interface ComponentRow {
  name: string
  description: string
  status: StatusKind
  uptimeLabel: string
  meta: string
  history: HistoryBucket[]
}

interface IncidentDay {
  date: string
  label: string
  status: 'none' | 'degraded' | 'outage'
  message: string
}

interface CalendarDay {
  date: string
  status: StatusKind
}

interface CalendarMonth {
  key: string
  label: string
  uptimeLabel: string
  days: Array<CalendarDay | null>
}

const REFRESH_INTERVAL_MS = 60_000
const BAR_COUNT = 90

const statusLabel: Record<StatusKind, string> = {
  operational: 'Operational',
  degraded: 'Degraded',
  outage: 'Unavailable',
  monitoring: 'Monitoring',
  unknown: 'No Data',
}

function formatDateTime(value: string | null) {
  if (!value) return 'Not checked yet'
  return new Intl.DateTimeFormat(undefined, {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    timeZoneName: 'short',
  }).format(new Date(value))
}

function formatIncidentDate(value: Date) {
  return new Intl.DateTimeFormat(undefined, {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  }).format(value)
}

function formatMonthYear(value: Date) {
  return new Intl.DateTimeFormat(undefined, {
    month: 'long',
    year: 'numeric',
  }).format(value)
}

function getOverallStatus(snapshot: StatusSnapshot | null, loadState: LoadState): StatusKind {
  if (snapshot?.relayer.status) return snapshot.relayer.status
  return loadState === 'error' ? 'outage' : 'monitoring'
}

function getStatusTitle(status: StatusKind) {
  if (status === 'operational') return 'All Systems Operational'
  if (status === 'degraded') return 'Degraded Performance'
  if (status === 'outage') return 'Service Disruption'
  return 'Checking System Status'
}

function toDateKey(date: Date) {
  return date.toISOString().slice(0, 10)
}

function parseDateKey(value: string) {
  const [year, month, day] = value.split('-').map(Number)
  return new Date(Date.UTC(year, month - 1, day))
}

function startOfUtcDay(date: Date) {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()))
}

function addUtcDays(date: Date, days: number) {
  const next = new Date(date)
  next.setUTCDate(next.getUTCDate() + days)
  return next
}

function startOfUtcMonth(date: Date) {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1))
}

function addUtcMonths(date: Date, months: number) {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + months, 1))
}

function daysInUtcMonth(date: Date) {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0)).getUTCDate()
}

function emptyHistoryBuckets(status: StatusKind = 'unknown') {
  const today = startOfUtcDay(new Date())
  const firstDay = addUtcDays(today, -(BAR_COUNT - 1))

  return Array.from({ length: BAR_COUNT }, (_, index) => ({
    date: toDateKey(addUtcDays(firstDay, index)),
    status: index === BAR_COUNT - 1 ? status : 'unknown',
    total: 0,
    ok: 0,
    degraded: 0,
    outage: 0,
  }))
}

function buildIncidentDays(history: StatusHistory | null | undefined): IncidentDay[] {
  const buckets = history?.buckets?.length ? history.buckets : emptyHistoryBuckets()

  return buckets.slice(-7).reverse().map((bucket, index) => {
    const date = bucket.date ? parseDateKey(bucket.date) : addUtcDays(startOfUtcDay(new Date()), -index)
    const isToday = index === 0
    const status = bucket.outage > 0 ? 'outage' : bucket.degraded > 0 ? 'degraded' : 'none'
    const message = status === 'outage'
      ? 'Relayer health checks reported an outage.'
      : status === 'degraded'
        ? 'Relayer health checks reported degraded performance.'
        : isToday
          ? 'No incidents reported today.'
          : 'No incidents reported.'

    return {
      date: toDateKey(date),
      label: formatIncidentDate(date),
      status,
      message,
    }
  })
}

function buildCalendarMonths(history: HistoryBucket[], pageOffset: number): CalendarMonth[] {
  const datedBuckets = history.filter((bucket) => bucket.date)
  const latestDate = datedBuckets.at(-1)?.date ? parseDateKey(datedBuckets.at(-1)!.date) : new Date()
  const endMonth = addUtcMonths(startOfUtcMonth(latestDate), -pageOffset)
  const startMonth = addUtcMonths(endMonth, -2)
  const bucketByDate = new Map(datedBuckets.map((bucket) => [bucket.date, bucket]))

  return Array.from({ length: 3 }, (_, monthIndex) => {
    const monthStart = addUtcMonths(startMonth, monthIndex)
    const dayCount = daysInUtcMonth(monthStart)
    const leadingDays = monthStart.getUTCDay()
    const monthBuckets: HistoryBucket[] = []
    const days: Array<CalendarDay | null> = Array.from({ length: leadingDays }, () => null)

    for (let day = 1; day <= dayCount; day += 1) {
      const date = new Date(Date.UTC(monthStart.getUTCFullYear(), monthStart.getUTCMonth(), day))
      const dateKey = toDateKey(date)
      const bucket = bucketByDate.get(dateKey)
      if (bucket) monthBuckets.push(bucket)
      days.push({
        date: dateKey,
        status: bucket?.status ?? 'unknown',
      })
    }

    const totalChecks = monthBuckets.reduce((sum, bucket) => sum + bucket.total, 0)
    const upChecks = monthBuckets.reduce((sum, bucket) => sum + bucket.ok + bucket.degraded, 0)
    const uptime = totalChecks > 0 ? (upChecks / totalChecks) * 100 : null

    return {
      key: toDateKey(monthStart),
      label: formatMonthYear(monthStart),
      uptimeLabel: uptime === null ? 'No data' : `${uptime === 100 ? uptime.toFixed(0) : uptime.toFixed(2)}%`,
      days,
    }
  })
}

function calendarRangeLabel(months: CalendarMonth[]) {
  if (!months.length) return ''
  return `${months[0].label} to ${months[months.length - 1].label}`
}

function normalizeBuckets(history: StatusHistory | null | undefined, latestStatus: StatusKind) {
  if (!history?.buckets?.length) return emptyHistoryBuckets(latestStatus)

  const buckets = history.buckets.slice(-BAR_COUNT)
  if (buckets.length < BAR_COUNT) {
    return [
      ...emptyHistoryBuckets().slice(0, BAR_COUNT - buckets.length),
      ...buckets,
    ]
  }

  return buckets
}

function formatUptime(history: StatusHistory | null | undefined, fallback = 'collecting data') {
  if (!history?.enabled) return 'history unavailable'
  if (!history.totalChecks || history.uptimePct === null) return fallback
  const decimals = history.uptimePct === 100 ? 1 : 2
  return `${history.uptimePct.toFixed(decimals)}% uptime`
}

function buildRows(snapshot: StatusSnapshot | null, loadState: LoadState): ComponentRow[] {
  const relayerStatus = getOverallStatus(snapshot, loadState)
  const health = snapshot?.relayer.health
  const history = snapshot?.history
  const relayerHistory = normalizeBuckets(history, relayerStatus)
  const serviceHistory = normalizeBuckets(history, loadState === 'error' ? 'degraded' : 'operational')
  const externalHistory = emptyHistoryBuckets('monitoring')
  const hasCompatibility = Boolean(
    health?.relayerVersion &&
    health?.apiVersion &&
    health?.minSupportedSdk,
  )
  const compatibilityStatus: StatusKind = relayerStatus === 'operational'
    ? hasCompatibility ? 'operational' : 'degraded'
    : relayerStatus
  const uptimeLabel = formatUptime(history)

  return [
    {
      name: 'Walrus Memory Status Service',
      description: 'Public status frontend and same-origin probe API',
      status: loadState === 'error' ? 'degraded' : 'operational',
      uptimeLabel,
      meta: snapshot?.service.runtime ? `${snapshot.service.runtime} runtime` : 'browser loaded',
      history: serviceHistory,
    },
    {
      name: 'Walrus Memory Relayer',
      description: 'Server-side health probe against the public relayer',
      status: relayerStatus,
      uptimeLabel,
      meta: snapshot?.relayer.latencyMs ? `${snapshot.relayer.latencyMs} ms latency` : 'awaiting check',
      history: relayerHistory,
    },
    {
      name: 'SDK Compatibility Metadata',
      description: 'Relayer version, API version, feature flags, and supported clients',
      status: compatibilityStatus,
      uptimeLabel,
      meta: health?.relayerVersion ? `relayer ${health.relayerVersion}` : 'from /health',
      history: relayerHistory,
    },
    {
      name: 'Memory API Pipeline',
      description: 'Remember, recall, analyze, restore, and MCP routes',
      status: relayerStatus === 'operational' ? 'operational' : relayerStatus,
      uptimeLabel,
      meta: health?.mode ? `${health.mode} mode` : 'relayer-backed',
      history: relayerHistory,
    },
    {
      name: 'Sui Network',
      description: 'Validators and public RPC dependency',
      status: 'monitoring',
      uptimeLabel: 'external',
      meta: 'tracked outside this service',
      history: externalHistory,
    },
    {
      name: 'Walrus Storage',
      description: 'Blob publishing, aggregation, and retrieval dependency',
      status: 'monitoring',
      uptimeLabel: 'external',
      meta: 'tracked outside this service',
      history: externalHistory,
    },
  ]
}

function StatusPill({ status }: { status: StatusKind }) {
  return <span className={`status-pill status-pill--${status}`}>{statusLabel[status]}</span>
}

function ComponentStatusRow({ row }: { row: ComponentRow }) {
  return (
    <article className="component-row">
      <div className="component-row__header">
        <div className="component-row__copy">
          <h2>{row.name}</h2>
          <p>{row.description}</p>
        </div>
        <StatusPill status={row.status} />
      </div>

      <div className="component-row__history" aria-label={`${row.name} uptime history`}>
        {row.history.map((bucket, index) => (
          <span
            key={`${row.name}-${bucket.date || index}`}
            className={`history-bar history-bar--${bucket.status}`}
            title={bucket.date ? `${bucket.date}: ${statusLabel[bucket.status]}` : statusLabel[bucket.status]}
            aria-hidden="true"
          />
        ))}
      </div>

      <div className="component-row__footer">
        <span>{BAR_COUNT} days ago</span>
        <span>{row.uptimeLabel}</span>
        <span>Today</span>
      </div>
      <p className="component-row__meta">{row.meta}</p>
    </article>
  )
}

function IncidentHistory({ history }: { history: StatusHistory | null | undefined }) {
  const incidentDays = buildIncidentDays(history)

  return (
    <section className="incident-history" aria-label="Past incidents">
      <h2>Past Incidents</h2>
      <div className="incident-history__list">
        {incidentDays.map((day) => (
          <article key={day.date} className={`incident-day incident-day--${day.status}`}>
            <h3>{day.label}</h3>
            <p>{day.message}</p>
          </article>
        ))}
      </div>
    </section>
  )
}

function UptimeCalendar({
  rows,
  selectedName,
  calendarPage,
  onSelectComponent,
  onCalendarPageChange,
}: {
  rows: ComponentRow[]
  selectedName: string
  calendarPage: number
  onSelectComponent: (name: string) => void
  onCalendarPageChange: (page: number) => void
}) {
  const selectedRow = rows.find((row) => row.name === selectedName) ?? rows[1] ?? rows[0]
  const months = buildCalendarMonths(selectedRow?.history ?? emptyHistoryBuckets(), calendarPage)

  return (
    <section className="uptime-calendar" aria-label="Historical uptime">
      <div className="uptime-calendar__controls">
        <label className="component-select">
          <span>Component</span>
          <select
            value={selectedRow?.name ?? ''}
            onChange={(event) => onSelectComponent(event.target.value)}
          >
            {rows.map((row) => (
              <option key={row.name} value={row.name}>
                {row.name}
              </option>
            ))}
          </select>
        </label>

        <div className="month-pager" aria-label="Calendar range">
          <button
            type="button"
            onClick={() => onCalendarPageChange(calendarPage + 3)}
            aria-label="Previous uptime range"
          >
            <ChevronLeft size={24} aria-hidden="true" />
          </button>
          <strong>{calendarRangeLabel(months)}</strong>
          <button
            type="button"
            onClick={() => onCalendarPageChange(Math.max(0, calendarPage - 3))}
            disabled={calendarPage === 0}
            aria-label="Next uptime range"
          >
            <ChevronRight size={24} aria-hidden="true" />
          </button>
        </div>
      </div>

      <div className="month-grid">
        {months.map((month) => (
          <article key={month.key} className="month-panel">
            <div className="month-panel__header">
              <h3>{month.label}</h3>
              <span>{month.uptimeLabel}</span>
            </div>
            <div className="calendar-grid" aria-label={`${month.label} uptime`}>
              {month.days.map((day, index) => day ? (
                <span
                  key={day.date}
                  className={`calendar-day calendar-day--${day.status}`}
                  title={`${day.date}: ${statusLabel[day.status]}`}
                  aria-hidden="true"
                />
              ) : (
                <span key={`${month.key}-empty-${index}`} className="calendar-day calendar-day--empty" aria-hidden="true" />
              ))}
            </div>
          </article>
        ))}
      </div>
    </section>
  )
}

async function loadSnapshot(signal: AbortSignal) {
  const response = await fetch('/api/status', {
    method: 'GET',
    cache: 'no-store',
    headers: { accept: 'application/json' },
    signal,
  })

  if (!response.ok) {
    throw new Error(`Status API returned HTTP ${response.status}`)
  }

  return response.json() as Promise<StatusSnapshot>
}

export default function App() {
  const [snapshot, setSnapshot] = useState<StatusSnapshot | null>(null)
  const [loadState, setLoadState] = useState<LoadState>('loading')
  const [error, setError] = useState<string | null>(null)
  const [manualRefreshes, setManualRefreshes] = useState(0)
  const [activeHistoryTab, setActiveHistoryTab] = useState<HistoryTab>('incidents')
  const [selectedComponentName, setSelectedComponentName] = useState('Walrus Memory Relayer')
  const [calendarPage, setCalendarPage] = useState(0)

  const refresh = useCallback(async (source: 'initial' | 'auto' | 'manual') => {
    const controller = new AbortController()
    const timeoutId = window.setTimeout(() => controller.abort(), 10_000)
    if (source !== 'auto') setLoadState((current) => (current === 'ready' ? current : 'loading'))

    try {
      const nextSnapshot = await loadSnapshot(controller.signal)
      setSnapshot(nextSnapshot)
      setLoadState('ready')
      setError(null)
    } catch (refreshError) {
      const message = refreshError instanceof Error ? refreshError.message : String(refreshError)
      setLoadState('error')
      setError(message)
    } finally {
      window.clearTimeout(timeoutId)
    }
  }, [])

  useEffect(() => {
    void refresh('initial')
    const intervalId = window.setInterval(() => {
      void refresh('auto')
    }, REFRESH_INTERVAL_MS)

    return () => window.clearInterval(intervalId)
  }, [refresh])

  const overallStatus = getOverallStatus(snapshot, loadState)
  const rows = useMemo(() => buildRows(snapshot, loadState), [snapshot, loadState])
  const uptimeRows = useMemo(() => rows.filter((row) => row.status !== 'monitoring'), [rows])
  const dependencies = snapshot?.dependencies ?? []
  const activeFeatureFlags = Object.entries(snapshot?.relayer.health?.featureFlags ?? {})
    .filter(([, enabled]) => enabled)
  const checkedAt = snapshot?.relayer.checkedAt ?? null
  const endpoint = snapshot?.relayer.url ?? 'Loading'
  const relayerVersion = snapshot?.relayer.health?.relayerVersion ??
    snapshot?.relayer.health?.version ??
    'Unknown'
  const buildCommit = snapshot?.relayer.health?.build?.commit?.slice(0, 12) ?? 'Not reported'
  const historyDays = snapshot?.history.days ?? BAR_COUNT
  const historyLabel = snapshot?.history.enabled
    ? snapshot.history.totalChecks > 0
      ? 'View historical uptime.'
      : 'Collecting historical uptime.'
    : 'History storage unavailable.'

  return (
    <div className="status-page">
      <main className="status-shell">
        <header className="page-header">
          <a className="brand-mark" href="/" aria-label="Walrus Memory Status">
            <img src="/memwal-icon.svg" alt="" aria-hidden="true" />
            <span>Walrus Memory</span>
          </a>

          <button
            type="button"
            className="refresh-cta"
            onClick={() => {
              setManualRefreshes((count) => count + 1)
              void refresh('manual')
            }}
            disabled={loadState === 'loading'}
          >
            <RefreshCw
              size={18}
              aria-hidden="true"
              className={loadState === 'loading' ? 'status-spin' : undefined}
            />
            {loadState === 'loading' ? 'Checking' : 'Refresh Status'}
          </button>
        </header>

        <section className={`summary-banner summary-banner--${overallStatus}`} aria-live="polite">
          <h1>{getStatusTitle(overallStatus)}</h1>
        </section>

        <section className="snapshot-note" aria-label="Current status snapshot">
          <div>
            <strong>Last checked</strong>
            <span>{formatDateTime(checkedAt)}</span>
          </div>
          <div>
            <strong>Relayer</strong>
            <span>{relayerVersion}</span>
          </div>
          <div>
            <strong>Endpoint</strong>
            <span>{endpoint}</span>
          </div>
        </section>

        {(error || snapshot?.relayer.error || snapshot?.database?.error) && (
          <section className="status-alert" role="alert">
            <AlertTriangle size={20} aria-hidden="true" />
            <div>
              <strong>
                {error
                  ? 'Status service error'
                  : snapshot?.relayer.error
                    ? 'Relayer health check error'
                    : 'History storage error'}
              </strong>
              <span>{error ?? snapshot?.relayer.error ?? snapshot?.database?.error}</span>
            </div>
          </section>
        )}

        <section className="component-section" aria-label="Service components">
          <div className="component-section__intro">
            <p>Uptime over the past {historyDays} days.</p>
            <button
              type="button"
              className="history-link"
              onClick={() => setActiveHistoryTab('uptime')}
            >
              {historyLabel}
            </button>
          </div>
          <div className="component-list">
            {rows.map((row) => (
              <ComponentStatusRow key={row.name} row={row} />
            ))}
          </div>
        </section>

        <section className="history-section" aria-label="Historical status">
          <div className="history-tabs" role="tablist" aria-label="Historical status tabs">
            <button
              type="button"
              role="tab"
              aria-selected={activeHistoryTab === 'incidents'}
              className={activeHistoryTab === 'incidents' ? 'history-tab history-tab--active' : 'history-tab'}
              onClick={() => setActiveHistoryTab('incidents')}
            >
              Incidents
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={activeHistoryTab === 'uptime'}
              className={activeHistoryTab === 'uptime' ? 'history-tab history-tab--active' : 'history-tab'}
              onClick={() => setActiveHistoryTab('uptime')}
            >
              Uptime
            </button>
          </div>

          {activeHistoryTab === 'incidents' ? (
            <IncidentHistory history={snapshot?.history} />
          ) : (
            <UptimeCalendar
              rows={uptimeRows}
              selectedName={selectedComponentName}
              calendarPage={calendarPage}
              onSelectComponent={setSelectedComponentName}
              onCalendarPageChange={setCalendarPage}
            />
          )}
        </section>

        <section className="detail-section" aria-label="Status details">
          <article>
            <h2>Relayer Details</h2>
            <dl>
              <div>
                <dt>HTTP status</dt>
                <dd>{snapshot?.relayer.httpStatus ? `HTTP ${snapshot.relayer.httpStatus}` : 'Pending'}</dd>
              </div>
              <div>
                <dt>Latency</dt>
                <dd>{snapshot?.relayer.latencyMs ? `${snapshot.relayer.latencyMs} ms` : 'Pending'}</dd>
              </div>
              <div>
                <dt>Mode</dt>
                <dd>{snapshot?.relayer.health?.mode ?? 'Unknown'}</dd>
              </div>
              <div>
                <dt>Build</dt>
                <dd>{buildCommit}</dd>
              </div>
            </dl>
          </article>

          <article>
            <h2>Supported Clients</h2>
            <dl>
              <div>
                <dt>TypeScript SDK</dt>
                <dd>{snapshot?.relayer.health?.minSupportedSdk?.typescript ?? 'Unknown'}</dd>
              </div>
              <div>
                <dt>Python SDK</dt>
                <dd>{snapshot?.relayer.health?.minSupportedSdk?.python ?? 'Unknown'}</dd>
              </div>
              <div>
                <dt>MCP package</dt>
                <dd>{snapshot?.relayer.health?.minSupportedSdk?.mcp ?? 'Unknown'}</dd>
              </div>
            </dl>
            <div className="feature-flags">
              {activeFeatureFlags.length ? (
                activeFeatureFlags.slice(0, 6).map(([flag]) => (
                  <span key={flag}>{flag}</span>
                ))
              ) : (
                <span>No feature flags reported</span>
              )}
            </div>
          </article>
        </section>

        <section className="dependency-section" aria-label="External dependencies">
          <h2>External Dependencies</h2>
          <div>
            {dependencies.map((dependency) => (
              <a key={dependency.name} href={dependency.url} target="_blank" rel="noopener noreferrer">
                <span>{dependency.name}</span>
                <ExternalLink size={16} aria-hidden="true" />
              </a>
            ))}
          </div>
        </section>

        <footer className="page-footer">
          <span>Auto-refresh every {REFRESH_INTERVAL_MS / 1000}s</span>
          <span>Manual refreshes {manualRefreshes}</span>
        </footer>
      </main>
    </div>
  )
}
