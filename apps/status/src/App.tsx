import { useCallback, useEffect, useMemo, useState } from 'react'
import { AlertTriangle, ExternalLink, RefreshCw } from 'lucide-react'

type StatusKind = 'operational' | 'degraded' | 'outage' | 'monitoring'
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

interface StatusSnapshot {
  generatedAt: string
  service: {
    name: string
    status: StatusKind
    runtime?: string
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
  dependencies: DependencyStatus[]
}

interface ComponentRow {
  name: string
  description: string
  status: StatusKind
  uptimeLabel: string
  meta: string
}

const REFRESH_INTERVAL_MS = 60_000
const BAR_COUNT = 90

const statusLabel: Record<StatusKind, string> = {
  operational: 'Operational',
  degraded: 'Degraded',
  outage: 'Unavailable',
  monitoring: 'Monitoring',
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

function buildRows(snapshot: StatusSnapshot | null, loadState: LoadState): ComponentRow[] {
  const relayerStatus = getOverallStatus(snapshot, loadState)
  const health = snapshot?.relayer.health
  const hasCompatibility = Boolean(
    health?.relayerVersion &&
    health?.apiVersion &&
    health?.minSupportedSdk,
  )
  const compatibilityStatus: StatusKind = relayerStatus === 'operational'
    ? hasCompatibility ? 'operational' : 'degraded'
    : relayerStatus

  return [
    {
      name: 'Walrus Memory Status Service',
      description: 'Public status frontend and same-origin probe API',
      status: loadState === 'error' ? 'degraded' : 'operational',
      uptimeLabel: 'live',
      meta: snapshot?.service.runtime ? `${snapshot.service.runtime} runtime` : 'browser loaded',
    },
    {
      name: 'Walrus Memory Relayer',
      description: 'Server-side health probe against the public relayer',
      status: relayerStatus,
      uptimeLabel: snapshot?.relayer.httpStatus ? `HTTP ${snapshot.relayer.httpStatus}` : 'pending',
      meta: snapshot?.relayer.latencyMs ? `${snapshot.relayer.latencyMs} ms latency` : 'awaiting check',
    },
    {
      name: 'SDK Compatibility Metadata',
      description: 'Relayer version, API version, feature flags, and supported clients',
      status: compatibilityStatus,
      uptimeLabel: health?.apiVersion ? `API ${health.apiVersion}` : 'metadata pending',
      meta: health?.relayerVersion ? `relayer ${health.relayerVersion}` : 'from /health',
    },
    {
      name: 'Memory API Pipeline',
      description: 'Remember, recall, analyze, restore, and MCP routes',
      status: relayerStatus === 'operational' ? 'operational' : relayerStatus,
      uptimeLabel: health?.mode ? `${health.mode} mode` : 'relayer-backed',
      meta: 'covered by relayer liveness',
    },
    {
      name: 'Sui Network',
      description: 'Validators and public RPC dependency',
      status: 'monitoring',
      uptimeLabel: 'external',
      meta: 'tracked outside this service',
    },
    {
      name: 'Walrus Storage',
      description: 'Blob publishing, aggregation, and retrieval dependency',
      status: 'monitoring',
      uptimeLabel: 'external',
      meta: 'tracked outside this service',
    },
  ]
}

function historyBars(status: StatusKind) {
  return Array.from({ length: BAR_COUNT }, (_, index) => {
    if (status === 'outage') return index > BAR_COUNT - 8 ? 'outage' : 'operational'
    if (status === 'degraded') return index > BAR_COUNT - 8 ? 'degraded' : 'operational'
    if (status === 'monitoring') return 'monitoring'
    return 'operational'
  })
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

      <div className="component-row__history" aria-label={`${row.name} current status timeline`}>
        {historyBars(row.status).map((barStatus, index) => (
          <span
            key={`${row.name}-${index}`}
            className={`history-bar history-bar--${barStatus}`}
            aria-hidden="true"
          />
        ))}
      </div>

      <div className="component-row__footer">
        <span>live snapshot</span>
        <span>{row.uptimeLabel}</span>
        <span>now</span>
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

        {(error || snapshot?.relayer.error) && (
          <section className="status-alert" role="alert">
            <AlertTriangle size={20} aria-hidden="true" />
            <div>
              <strong>{error ? 'Status service error' : 'Relayer health check error'}</strong>
              <span>{error ?? snapshot?.relayer.error}</span>
            </div>
          </section>
        )}

        <section className="component-section" aria-label="Service components">
          <div className="component-section__intro">
            <p>Component status</p>
            <span>Live checks only. Historical uptime storage is not connected yet.</span>
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
            <strong>
              {overallStatus === 'outage'
                ? 'Live health check is failing'
                : 'No active incident reported'}
            </strong>
            <p>
              {overallStatus === 'outage'
                ? 'The status service detected a failed relayer probe. Check Railway logs and upstream providers.'
                : 'This page currently reports live probe status. Incident history will appear here after a history backend is connected.'}
            </p>
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
