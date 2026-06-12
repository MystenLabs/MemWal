import { useCallback, useEffect, useMemo, useState } from 'react'
import { AlertTriangle, ChevronLeft, ChevronRight, Rss, X } from 'lucide-react'

type StatusKind = 'operational' | 'degraded' | 'outage' | 'monitoring' | 'unknown'
type LoadState = 'loading' | 'ready' | 'error'
type PageRoute = 'current' | 'history' | 'uptime' | 'admin'

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

interface IncidentUpdate {
  id: number
  status: string
  message: string
  createdAt: string
}

interface Incident {
  id: number
  identifier: string
  title: string
  status: string
  severity: string
  component: string | null
  message: string
  startedAt: string
  resolvedAt: string | null
  createdAt: string
  updatedAt: string
  updates?: IncidentUpdate[]
}

interface IncidentList {
  active: Incident[]
  recent: Incident[]
}

interface StatusComponent {
  id: string
  name: string
  status: StatusKind
  url: string
  httpStatus: number | null
  latencyMs: number | null
  checkedAt: string
  health: HealthPayload | null
  error: string | null
}

interface StatusSnapshot {
  generatedAt: string
  service: {
    name: string
    status: StatusKind
    runtime?: string
    historyEnabled?: boolean
  }
  components: StatusComponent[]
  histories: Record<string, StatusHistory>
  incidents?: IncidentList
  database?: {
    configured: boolean
    ready: boolean
    error: string | null
  }
}

interface ComponentRow {
  name: string
  status: StatusKind
  uptimeLabel: string
  history: HistoryBucket[]
}

interface IncidentDay {
  date: string
  label: string
  status: 'none' | 'degraded' | 'outage'
  messages: string[]
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
  degraded: 'Degraded Performance',
  outage: 'Major Outage',
  monitoring: 'Monitoring',
  unknown: 'No Data',
}

function pathToRoute(pathname: string): PageRoute {
  if (pathname.startsWith('/admin')) return 'admin'
  if (pathname.startsWith('/uptime')) return 'uptime'
  if (pathname.startsWith('/history')) return 'history'
  return 'current'
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
  if (loadState === 'error') return 'outage'
  const components = snapshot?.components ?? []
  if (components.length === 0) return 'monitoring'
  if (components.some((c) => c.status === 'outage')) return 'outage'
  if (components.some((c) => c.status === 'degraded')) return 'degraded'
  if (components.every((c) => c.status === 'operational')) return 'operational'
  return 'monitoring'
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

function formatUptime(history: StatusHistory | null | undefined) {
  if (!history?.enabled || !history.totalChecks || history.uptimePct === null) return 'history unavailable'
  const decimals = history.uptimePct === 100 ? 1 : 2
  return `${history.uptimePct.toFixed(decimals)} % uptime`
}

function buildRows(snapshot: StatusSnapshot | null, loadState: LoadState): ComponentRow[] {
  const components = snapshot?.components ?? []
  if (components.length === 0 && loadState === 'error') {
    return [
      {
        name: 'Walrus Memory Relayer production (mainnet)',
        status: 'outage',
        uptimeLabel: 'history unavailable',
        history: normalizeBuckets(null, 'outage'),
      },
    ]
  }

  return components.map((component) => {
    const history = snapshot?.histories?.[component.id]
    return {
      name: component.name,
      status: component.status,
      uptimeLabel: formatUptime(history),
      history: normalizeBuckets(history, component.status),
    }
  })
}

function buildIncidentDays(history: StatusHistory | null | undefined, incidents: IncidentList | null | undefined, count = 10): IncidentDay[] {
  const allIncidents = [
    ...(incidents?.active ?? []),
    ...(incidents?.recent ?? []),
  ]

  const incidentsByDate = new Map<string, Incident[]>()
  for (const incident of allIncidents) {
    const date = incident.startedAt.slice(0, 10)
    const list = incidentsByDate.get(date) ?? []
    list.push(incident)
    incidentsByDate.set(date, list)
  }

  const bucketByDate = new Map<string, HistoryBucket>()
  if (history?.buckets) {
    for (const bucket of history.buckets) {
      bucketByDate.set(bucket.date, bucket)
    }
  }

  const today = startOfUtcDay(new Date())
  const days: IncidentDay[] = []

  for (let i = 0; i < count; i++) {
    const date = addUtcDays(today, -i)
    const dateKey = toDateKey(date)
    const dayIncidents = incidentsByDate.get(dateKey)
    const bucket = bucketByDate.get(dateKey)
    const isToday = i === 0

    if (dayIncidents && dayIncidents.length > 0) {
      const messages: string[] = []
      for (const inc of dayIncidents) {
        const statusText = inc.status === 'resolved' ? '' : ` — ${inc.status}`
        messages.push(`${inc.identifier}: ${inc.title}${statusText}`)
        if (inc.updates && inc.updates.length > 0) {
          for (const u of inc.updates) {
            const time = new Date(u.createdAt).toLocaleTimeString('en-US', {
              hour: 'numeric',
              minute: '2-digit',
            })
            messages.push(`  ${time} — ${u.status} — ${u.message}`)
          }
        }
      }
      const allResolved = dayIncidents.every((inc) => inc.status === 'resolved')
      const severity = dayIncidents.some((inc) => inc.severity === 'critical' || inc.severity === 'major')
        ? 'outage'
        : 'degraded'
      days.push({
        date: dateKey,
        label: formatIncidentDate(date),
        status: allResolved ? 'none' : severity,
        messages,
      })
    } else if (bucket) {
      const outagePct = bucket.total ? bucket.outage / bucket.total : 0
      const degradedPct = bucket.total ? bucket.degraded / bucket.total : 0
      let status: 'outage' | 'degraded' | 'none'
      if (outagePct > 0.05) {
        status = 'outage'
      } else if (outagePct > 0 || degradedPct > 0.05) {
        status = 'degraded'
      } else {
        status = 'none'
      }
      const msg = status === 'outage'
        ? 'Relayer health checks reported a major outage.'
        : status === 'degraded'
          ? 'Relayer health checks reported degraded performance.'
          : isToday
            ? 'No incidents reported today.'
            : 'No incidents reported.'
      days.push({
        date: dateKey,
        label: formatIncidentDate(date),
        status,
        messages: [msg],
      })
    } else {
      days.push({
        date: dateKey,
        label: formatIncidentDate(date),
        status: 'none',
        messages: [isToday ? 'No incidents reported today.' : 'No incidents reported.'],
      })
    }
  }

  return days
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

function StatusPill({ status }: { status: StatusKind }) {
  return <span className={`status-pill status-pill--${status}`}>{statusLabel[status]}</span>
}

function Header({
  subscribeOpen,
  onSubscribeToggle,
  onSubscribeClose,
  onNavigate,
}: {
  subscribeOpen: boolean
  onSubscribeToggle: () => void
  onSubscribeClose: () => void
  onNavigate: (href: string) => void
}) {
  return (
    <header className="page-header">
      <a
        className="brand-mark"
        href="/"
        aria-label="Walrus Memory Status"
        onClick={(event) => {
          event.preventDefault()
          onNavigate('/')
        }}
      >
        <img src="/memwal-icon.svg" alt="" aria-hidden="true" />
        <span>Walrus Memory</span>
      </a>

      <div className="updates-dropdown-container">
        <button
          type="button"
          className="subscribe-cta"
          aria-expanded={subscribeOpen}
          aria-haspopup="dialog"
          onClick={onSubscribeToggle}
        >
          Subscribe to Updates
        </button>

        {subscribeOpen && (
          <div className="updates-dropdown" role="dialog" aria-label="Subscribe to updates">
            <div className="updates-dropdown__nav" role="tablist" aria-label="Subscribe to updates">
              <span className="updates-dropdown__tab" role="tab" aria-selected="true">
                <Rss size={18} aria-hidden="true" />
              </span>
              <button type="button" className="updates-dropdown__close" onClick={onSubscribeClose} aria-label="Close subscribe form">
                <X size={16} aria-hidden="true" />
              </button>
            </div>
            <div className="updates-dropdown__body">
              Get the <a href="/history.atom" target="_blank" rel="noreferrer">Atom Feed</a> or{' '}
              <a href="/history.rss" target="_blank" rel="noreferrer">RSS Feed</a>.
            </div>
          </div>
        )}
      </div>
    </header>
  )
}

function ComponentStatusRow({ row }: { row: ComponentRow }) {
  return (
    <article className="component-row">
      <div className="component-row__header">
        <h2>{row.name}</h2>
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
    </article>
  )
}

function IncidentHistory({
  history,
  incidents,
  count,
}: {
  history: StatusHistory | null | undefined
  incidents: IncidentList | null | undefined
  count: number
}) {
  const incidentDays = buildIncidentDays(history, incidents, count)

  return (
    <section className="incident-history" aria-label="Past incidents">
      <h1>Past Incidents</h1>
      <div className="incident-history__list">
        {incidentDays.map((day) => (
          <article key={day.date} className={`incident-day incident-day--${day.status}`}>
            <h2>{day.label}</h2>
            {day.messages.map((msg, idx) => (
              <p key={idx} className={idx === 0 ? 'incident-day__primary' : 'incident-day__update'}>
                {msg}
              </p>
            ))}
          </article>
        ))}
      </div>
    </section>
  )
}

function HistoryTabs({
  route,
  onNavigate,
}: {
  route: PageRoute
  onNavigate: (href: string) => void
}) {
  return (
    <nav className="history-tabs" aria-label="Historical status tabs">
      <a
        className={route === 'history' ? 'history-tab history-tab--active' : 'history-tab'}
        href="/history"
        aria-current={route === 'history' ? 'page' : undefined}
        onClick={(event) => {
          event.preventDefault()
          onNavigate('/history')
        }}
      >
        Incidents
      </a>
      <a
        className={route === 'uptime' ? 'history-tab history-tab--active' : 'history-tab'}
        href="/uptime"
        aria-current={route === 'uptime' ? 'page' : undefined}
        onClick={(event) => {
          event.preventDefault()
          onNavigate('/uptime')
        }}
      >
        Uptime
      </a>
    </nav>
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
            <ChevronLeft size={26} aria-hidden="true" />
          </button>
          <strong>{calendarRangeLabel(months)}</strong>
          <button
            type="button"
            onClick={() => onCalendarPageChange(Math.max(0, calendarPage - 3))}
            disabled={calendarPage === 0}
            aria-label="Next uptime range"
          >
            <ChevronRight size={26} aria-hidden="true" />
          </button>
        </div>
      </div>

      <div className="month-grid">
        {months.map((month) => (
          <article key={month.key} className="month-panel">
            <div className="month-panel__header">
              <h2>{month.label}</h2>
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

function StatusFooter({
  route,
  onNavigate,
}: {
  route: PageRoute
  onNavigate: (href: string) => void
}) {
  const links = []
  if (route !== 'current') links.push({ href: '/', label: 'Current Status' })
  if (route !== 'history') links.push({ href: '/history', label: 'Incident History' })
  if (route !== 'uptime') links.push({ href: '/uptime', label: 'Uptime' })

  return (
    <footer className="status-footer">
      <div className="status-footer__links">
        {links.map((link) => (
          <a
            key={link.href}
            href={link.href}
            onClick={(event) => {
              event.preventDefault()
              onNavigate(link.href)
            }}
          >
            {link.label}
          </a>
        ))}
      </div>
      <span>Powered by Walrus Memory</span>
    </footer>
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

async function loadIncidents(): Promise<Incident[]> {
  const response = await fetch('/api/incidents', {
    method: 'GET',
    cache: 'no-store',
    headers: { accept: 'application/json' },
  })
  if (!response.ok) throw new Error(`Incidents API returned HTTP ${response.status}`)
  const data = await response.json()
  return data.incidents ?? []
}

async function createIncidentApi(payload: Record<string, unknown>, apiKey: string): Promise<Incident> {
  const response = await fetch('/api/incidents', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Admin-API-Key': apiKey,
    },
    body: JSON.stringify(payload),
  })
  if (!response.ok) {
    const err = await response.json().catch(() => ({ error: 'Unknown error' }))
    throw new Error(err.error || `HTTP ${response.status}`)
  }
  return response.json()
}

async function addIncidentUpdateApi(incidentId: number, payload: Record<string, unknown>, apiKey: string): Promise<Incident> {
  const response = await fetch(`/api/incidents/${incidentId}/updates`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Admin-API-Key': apiKey,
    },
    body: JSON.stringify(payload),
  })
  if (!response.ok) {
    const err = await response.json().catch(() => ({ error: 'Unknown error' }))
    throw new Error(err.error || `HTTP ${response.status}`)
  }
  return response.json()
}

async function resolveIncidentApi(incidentId: number, apiKey: string): Promise<Incident> {
  const response = await fetch(`/api/incidents/${incidentId}`, {
    method: 'PATCH',
    headers: {
      'Content-Type': 'application/json',
      'X-Admin-API-Key': apiKey,
    },
    body: JSON.stringify({ status: 'resolved', resolvedAt: new Date().toISOString() }),
  })
  if (!response.ok) {
    const err = await response.json().catch(() => ({ error: 'Unknown error' }))
    throw new Error(err.error || `HTTP ${response.status}`)
  }
  return response.json()
}

async function deleteIncidentApi(incidentId: number, apiKey: string): Promise<void> {
  const response = await fetch(`/api/incidents/${incidentId}`, {
    method: 'DELETE',
    headers: {
      'X-Admin-API-Key': apiKey,
    },
  })
  if (!response.ok) {
    const err = await response.json().catch(() => ({ error: 'Unknown error' }))
    throw new Error(err.error || `HTTP ${response.status}`)
  }
}

function AdminPanel({
  apiKey,
  onApiKeyChange,
  onMutate,
  componentNames,
}: {
  apiKey: string
  onApiKeyChange: (key: string) => void
  onMutate?: () => void
  componentNames: string[]
}) {
  const [incidents, setIncidents] = useState<Incident[]>([])
  const [loadState, setLoadState] = useState<LoadState>('loading')
  const [error, setError] = useState<string | null>(null)
  const [formError, setFormError] = useState<string | null>(null)
  const [formSuccess, setFormSuccess] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    setLoadState('loading')
    try {
      const data = await loadIncidents()
      setIncidents(data)
      setLoadState('ready')
      setError(null)
    } catch (e) {
      setLoadState('error')
      setError(e instanceof Error ? e.message : String(e))
    }
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const handleCreate = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    setFormError(null)
    setFormSuccess(null)
    const form = event.currentTarget
    const formData = new FormData(form)
    const payload = {
      title: String(formData.get('title') || ''),
      status: String(formData.get('status') || 'investigating'),
      severity: String(formData.get('severity') || 'minor'),
      component: String(formData.get('component') || ''),
      message: String(formData.get('message') || ''),
      startedAt: new Date().toISOString(),
    }
    if (!payload.title || !payload.message) {
      setFormError('Title and message are required.')
      return
    }
    try {
      await createIncidentApi(payload, apiKey)
      setFormSuccess('Incident created.')
      form.reset()
      void refresh()
      onMutate?.()
    } catch (e) {
      setFormError(e instanceof Error ? e.message : String(e))
    }
  }

  const handleUpdate = async (incidentId: number, event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    setFormError(null)
    setFormSuccess(null)
    const form = event.currentTarget
    const formData = new FormData(form)
    const payload = {
      status: String(formData.get('status') || ''),
      message: String(formData.get('message') || ''),
    }
    if (!payload.message) {
      setFormError('Message is required.')
      return
    }
    try {
      await addIncidentUpdateApi(incidentId, payload, apiKey)
      setFormSuccess('Update posted.')
      form.reset()
      void refresh()
      onMutate?.()
    } catch (e) {
      setFormError(e instanceof Error ? e.message : String(e))
    }
  }

  const handleResolve = async (incidentId: number) => {
    setFormError(null)
    setFormSuccess(null)
    try {
      await resolveIncidentApi(incidentId, apiKey)
      setFormSuccess('Incident resolved.')
      void refresh()
      onMutate?.()
    } catch (e) {
      setFormError(e instanceof Error ? e.message : String(e))
    }
  }

  const handleDelete = async (incidentId: number) => {
    if (!window.confirm('Delete this incident permanently?')) return
    setFormError(null)
    setFormSuccess(null)
    try {
      await deleteIncidentApi(incidentId, apiKey)
      setFormSuccess('Incident deleted.')
      void refresh()
      onMutate?.()
    } catch (e) {
      setFormError(e instanceof Error ? e.message : String(e))
    }
  }

  return (
    <section className="admin-panel" aria-label="Incident administration">
      <h1>Incident Administration</h1>

      <div className="admin-api-key">
        <label>
          Admin API Key
          <input
            type="password"
            value={apiKey}
            onChange={(e) => onApiKeyChange(e.target.value)}
            placeholder="Enter STATUS_ADMIN_API_KEY"
          />
        </label>
      </div>

      {(formError || formSuccess) && (
        <div className={`admin-alert ${formError ? 'admin-alert--error' : 'admin-alert--success'}`}>
          {formError || formSuccess}
        </div>
      )}

      <div className="admin-section">
        <h2>Create Incident</h2>
        <form onSubmit={handleCreate} className="admin-form">
          <label>
            Title
            <input name="title" type="text" placeholder="e.g., Degraded API performance" required />
          </label>
          <label>
            Status
            <select name="status" defaultValue="investigating">
              <option value="investigating">Investigating</option>
              <option value="identified">Identified</option>
              <option value="monitoring">Monitoring</option>
              <option value="resolved">Resolved</option>
            </select>
          </label>
          <label>
            Severity
            <select name="severity" defaultValue="minor">
              <option value="minor">Minor</option>
              <option value="major">Major</option>
              <option value="critical">Critical</option>
            </select>
          </label>
          <label>
            Component
            <select name="component" defaultValue={componentNames[0] ?? ''}>
              {componentNames.map((name) => (
                <option key={name} value={name}>{name}</option>
              ))}
            </select>
          </label>

          <label>
            Message
            <textarea name="message" rows={3} placeholder="Initial incident message" required />
          </label>
          <button type="submit" disabled={!apiKey}>Create Incident</button>
        </form>
      </div>

      <div className="admin-section">
        <h2>Existing Incidents</h2>
        {loadState === 'loading' && <p>Loading incidents…</p>}
        {loadState === 'error' && <p className="admin-alert admin-alert--error">{error}</p>}
        {loadState === 'ready' && incidents.length === 0 && <p>No incidents yet.</p>}
        {loadState === 'ready' && incidents.length > 0 && (
          <div className="admin-incident-list">
            {incidents.map((incident) => (
              <article key={incident.id} className={`admin-incident admin-incident--${incident.status}`}>
                <div className="admin-incident__header">
                  <strong>{incident.identifier}</strong>
                  <span>{incident.title}</span>
                  <span className={`status-pill status-pill--${incident.status === 'resolved' ? 'operational' : 'outage'}`}>
                    {incident.status}
                  </span>
                </div>
                <p>{incident.message}</p>
                {incident.updates && incident.updates.length > 0 && (
                  <div className="admin-incident__updates">
                    {incident.updates.map((u) => (
                      <div key={u.id}>
                        <strong>{u.status}</strong> — {u.message}
                        <em>{new Date(u.createdAt).toLocaleString()}</em>
                      </div>
                    ))}
                  </div>
                )}
                {incident.status !== 'resolved' && (
                  <form onSubmit={(e) => handleUpdate(incident.id, e)} className="admin-form admin-form--inline">
                    <select name="status" defaultValue={incident.status}>
                      <option value="investigating">Investigating</option>
                      <option value="identified">Identified</option>
                      <option value="monitoring">Monitoring</option>
                      <option value="resolved">Resolved</option>
                    </select>
                    <input name="message" type="text" placeholder="Update message" required />
                    <button type="submit" disabled={!apiKey}>Post Update</button>
                    <button type="button" disabled={!apiKey} onClick={() => handleResolve(incident.id)}>Resolve</button>
                  </form>
                )}
                <button type="button" className="admin-delete-btn" disabled={!apiKey} onClick={() => handleDelete(incident.id)}>
                  Delete
                </button>
              </article>
            ))}
          </div>
        )}
      </div>
    </section>
  )
}

export default function App() {
  const [route, setRoute] = useState<PageRoute>(() => pathToRoute(window.location.pathname))
  const [snapshot, setSnapshot] = useState<StatusSnapshot | null>(null)
  const [loadState, setLoadState] = useState<LoadState>('loading')
  const [error, setError] = useState<string | null>(null)
  const [selectedComponentName, setSelectedComponentName] = useState('Walrus Memory Relayer production (mainnet)')
  const [calendarPage, setCalendarPage] = useState(0)
  const [subscribeOpen, setSubscribeOpen] = useState(false)
  const [adminApiKey, setAdminApiKey] = useState(() => {
    try {
      return sessionStorage.getItem('statusAdminKey') || ''
    } catch {
      return ''
    }
  })

  const navigate = useCallback((href: string) => {
    window.history.pushState(null, '', href)
    setRoute(pathToRoute(href))
    setSubscribeOpen(false)
    window.scrollTo({ top: 0, behavior: 'auto' })
  }, [])

  const handleApiKeyChange = useCallback((key: string) => {
    setAdminApiKey(key)
    try {
      sessionStorage.setItem('statusAdminKey', key)
    } catch {
      // ignore
    }
  }, [])

  const refresh = useCallback(async () => {
    const controller = new AbortController()
    const timeoutId = window.setTimeout(() => controller.abort(), 10_000)
    setLoadState((current) => (current === 'ready' ? current : 'loading'))

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
    const onPopState = () => setRoute(pathToRoute(window.location.pathname))
    window.addEventListener('popstate', onPopState)
    return () => window.removeEventListener('popstate', onPopState)
  }, [])

  useEffect(() => {
    void refresh()
    const intervalId = window.setInterval(() => {
      void refresh()
    }, REFRESH_INTERVAL_MS)

    return () => window.clearInterval(intervalId)
  }, [refresh])

  const overallStatus = getOverallStatus(snapshot, loadState)
  const rows = useMemo(() => buildRows(snapshot, loadState), [snapshot, loadState])
  const uptimeRows = useMemo(() => rows.filter((row) => row.status !== 'monitoring'), [rows])
  const productionHistory = snapshot?.histories?.['relayer-production']
  const historyDays = productionHistory?.days ?? BAR_COUNT
  const componentError = snapshot?.components?.find((c) => c.error)?.error

  return (
    <div className={`status-page status-page--${route}`}>
      <main className="status-shell">
        <Header
          subscribeOpen={subscribeOpen}
          onSubscribeToggle={() => setSubscribeOpen((open) => !open)}
          onSubscribeClose={() => setSubscribeOpen(false)}
          onNavigate={navigate}
        />

        {route === 'current' && (
          <>
            <section className={`summary-banner summary-banner--${overallStatus}`} aria-live="polite">
              <h1>{getStatusTitle(overallStatus)}</h1>
            </section>

            {(error || componentError || snapshot?.database?.error) && (
              <section className="status-alert" role="alert">
                <AlertTriangle size={20} aria-hidden="true" />
                <div>
                  <strong>
                    {error
                      ? 'Status service error'
                      : componentError
                        ? 'Relayer health check error'
                        : 'History storage error'}
                  </strong>
                  <span>{error ?? componentError ?? snapshot?.database?.error}</span>
                </div>
              </section>
            )}

            <section className="component-section" aria-label="Service components">
              <div className="component-section__intro">
                <p>Uptime over the past {historyDays} days.</p>
                <a
                  href="/uptime"
                  onClick={(event) => {
                    event.preventDefault()
                    navigate('/uptime')
                  }}
                >
                  View historical uptime.
                </a>
              </div>
              <div className="component-list">
                {rows.map((row) => (
                  <ComponentStatusRow key={row.name} row={row} />
                ))}
              </div>
            </section>

            <IncidentHistory history={productionHistory} incidents={snapshot?.incidents} count={10} />
          </>
        )}

        {route === 'history' && (
          <>
            <HistoryTabs route={route} onNavigate={navigate} />
            <IncidentHistory history={productionHistory} incidents={snapshot?.incidents} count={30} />
          </>
        )}

        {route === 'admin' && (
          <AdminPanel
            apiKey={adminApiKey}
            onApiKeyChange={handleApiKeyChange}
            onMutate={refresh}
            componentNames={snapshot?.components?.map((c) => c.name) ?? [
              'Walrus Memory Relayer production (mainnet)',
              'Walrus Memory Relayer staging (testnet)',
            ]}
          />
        )}

        {route === 'uptime' && (
          <>
            <HistoryTabs route={route} onNavigate={navigate} />
            <UptimeCalendar
              rows={uptimeRows}
              selectedName={selectedComponentName}
              calendarPage={calendarPage}
              onSelectComponent={setSelectedComponentName}
              onCalendarPageChange={setCalendarPage}
            />
          </>
        )}

        <StatusFooter route={route} onNavigate={navigate} />
      </main>
    </div>
  )
}
