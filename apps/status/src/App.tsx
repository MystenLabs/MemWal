import { useCallback, useEffect, useMemo, useState } from 'react'
import { AlertTriangle, ExternalLink, RefreshCw } from 'lucide-react'

type StatusKind = 'operational' | 'degraded' | 'outage' | 'monitoring' | 'unknown'
type LoadState = 'loading' | 'ready' | 'error'

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

function formatDate(value: Date) {
  return new Intl.DateTimeFormat(undefined, {
    month: 'long',
    day: 'numeric',
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

function emptyHistoryBuckets(status: StatusKind = 'unknown') {
  return Array.from({ length: BAR_COUNT }, (_, index) => ({
    date: '',
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
  const storedChecks = snapshot?.history.totalChecks ?? 0
  const outageDays = snapshot?.history.buckets.filter((bucket) => bucket.status === 'outage').length ?? 0
  const degradedDays = snapshot?.history.buckets.filter((bucket) => bucket.status === 'degraded').length ?? 0
  const incidentTitle = overallStatus === 'outage'
    ? 'Live health check is failing'
    : outageDays > 0
      ? `${outageDays} outage day${outageDays === 1 ? '' : 's'} in stored checks`
      : degradedDays > 0
        ? `${degradedDays} degraded day${degradedDays === 1 ? '' : 's'} in stored checks`
        : 'No incidents reported in stored checks'
  const incidentCopy = snapshot?.history.enabled
    ? storedChecks > 0
      ? `Based on ${storedChecks} stored relayer health checks.`
      : 'Postgres history is connected and waiting for scheduled checks.'
    : 'Set DATABASE_URL to retain historical uptime checks.'

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
            <span>{historyLabel}</span>
          </div>
          <div className="component-list">
            {rows.map((row) => (
              <ComponentStatusRow key={row.name} row={row} />
            ))}
          </div>
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

        <section className="incident-section" aria-label="Incidents">
          <h2>Past Incidents</h2>
          <article>
            <time>{formatDate(new Date())}</time>
            <strong>{incidentTitle}</strong>
            <p>{incidentCopy}</p>
          </article>
        </section>

        <footer className="page-footer">
          <span>Auto-refresh every {REFRESH_INTERVAL_MS / 1000}s</span>
          <span>Manual refreshes {manualRefreshes}</span>
        </footer>
      </main>
    </div>
  )
}
