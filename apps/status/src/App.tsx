import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  Activity,
  AlertTriangle,
  CheckCircle2,
  Clock3,
  ExternalLink,
  Info,
  RefreshCw,
  Server,
  ShieldCheck,
  Wifi,
} from 'lucide-react'

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
  prompt_versions?: {
    extract?: string
    ask?: string
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
  detail: string
  status: StatusKind
  meta: string
}

const REFRESH_INTERVAL_MS = 60_000

const statusLabel: Record<StatusKind, string> = {
  operational: 'Operational',
  degraded: 'Degraded',
  outage: 'Unavailable',
  monitoring: 'Monitoring',
}

const statusDescription: Record<StatusKind, string> = {
  operational: 'Responding normally.',
  degraded: 'Responding with degraded metadata or a non-ok health value.',
  outage: 'Health probe is failing.',
  monitoring: 'Tracked by an external status source.',
}

function formatDateTime(value: string | null) {
  if (!value) return 'Not checked yet'
  return new Intl.DateTimeFormat(undefined, {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    second: '2-digit',
    timeZoneName: 'short',
  }).format(new Date(value))
}

function formatDate(value: Date) {
  return new Intl.DateTimeFormat(undefined, {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  }).format(value)
}

function summaryTitle(status: StatusKind) {
  if (status === 'operational') return 'All Systems Operational'
  if (status === 'degraded') return 'Degraded Performance'
  if (status === 'outage') return 'Relayer Health Check Failing'
  return 'Checking System Status'
}

function summaryCopy(status: StatusKind, endpoint: string | null) {
  if (!endpoint) return 'Loading the latest status snapshot.'
  if (status === 'operational') return `The public relayer responded successfully from ${endpoint}.`
  if (status === 'degraded') return `The relayer responded from ${endpoint}, but did not report a fully healthy status.`
  if (status === 'outage') return `The status service could not complete a live health check against ${endpoint}.`
  return `Running a live health check against ${endpoint}.`
}

function iconForStatus(status: StatusKind) {
  if (status === 'operational') return <CheckCircle2 size={22} aria-hidden="true" />
  if (status === 'outage') return <AlertTriangle size={22} aria-hidden="true" />
  if (status === 'degraded') return <Info size={22} aria-hidden="true" />
  return <Activity size={22} aria-hidden="true" />
}

function buildRows(snapshot: StatusSnapshot | null, loadState: LoadState): ComponentRow[] {
  const relayerStatus = snapshot?.relayer.status ?? (loadState === 'error' ? 'outage' : 'monitoring')
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
      name: 'Status service',
      detail: 'Standalone status frontend and same-origin probe API',
      status: loadState === 'error' ? 'degraded' : 'operational',
      meta: snapshot?.service.runtime ? `${snapshot.service.runtime} runtime` : 'Browser loaded',
    },
    {
      name: 'Public relayer API',
      detail: 'Server-side GET /health probe',
      status: relayerStatus,
      meta: snapshot?.relayer.httpStatus ? `HTTP ${snapshot.relayer.httpStatus}` : 'Awaiting check',
    },
    {
      name: 'SDK compatibility metadata',
      detail: 'Relayer version, API version, and supported clients',
      status: compatibilityStatus,
      meta: health?.apiVersion ? `API ${health.apiVersion}` : 'From /health',
    },
    {
      name: 'Memory job pipeline',
      detail: 'Remember, recall, analyze, restore, and MCP routes',
      status: relayerStatus === 'operational' ? 'operational' : relayerStatus,
      meta: health?.mode ? `${health.mode} mode` : 'Relayer-backed',
    },
    {
      name: 'Sui network',
      detail: 'Validators and public RPC dependency',
      status: 'monitoring',
      meta: 'External status',
    },
    {
      name: 'Walrus storage',
      detail: 'Blob publishing, aggregation, and retrieval dependency',
      status: 'monitoring',
      meta: 'External dependency',
    },
  ]
}

function StatusBadge({ status }: { status: StatusKind }) {
  return (
    <span className={`status-badge status-badge--${status}`}>
      <span aria-hidden="true" />
      {statusLabel[status]}
    </span>
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

  const overallStatus = snapshot?.relayer.status ?? (loadState === 'error' ? 'outage' : 'monitoring')
  const rows = useMemo(() => buildRows(snapshot, loadState), [snapshot, loadState])
  const activeFeatureFlags = Object.entries(snapshot?.relayer.health?.featureFlags ?? {})
    .filter(([, enabled]) => enabled)
  const buildCommit = snapshot?.relayer.health?.build?.commit?.slice(0, 12) ?? null
  const dependencies = snapshot?.dependencies ?? []
  const endpoint = snapshot?.relayer.url ?? null
  const checkedAt = snapshot?.relayer.checkedAt ?? null
  const relayerVersion = snapshot?.relayer.health?.relayerVersion ??
    snapshot?.relayer.health?.version ??
    'Unknown'

  return (
    <div className="status-page">
      <header className="status-nav">
        <a className="status-brand" href="/" aria-label="Walrus Memory Status">
          <img src="/memwal-icon.svg" alt="" aria-hidden="true" />
          <span>
            <strong>Walrus Memory</strong>
            <em>Status</em>
          </span>
        </a>
        <nav className="status-nav-actions" aria-label="External status links">
          {dependencies.map((dependency) => (
            <a key={dependency.name} href={dependency.url} target="_blank" rel="noopener noreferrer">
              {dependency.name}
              <ExternalLink size={14} aria-hidden="true" />
            </a>
          ))}
        </nav>
      </header>

      <main className="status-shell">
        <section className={`status-hero status-hero--${overallStatus}`}>
          <div className="status-hero-copy">
            <p className="status-eyebrow">Standalone monitoring service</p>
            <div className="status-title-row">
              <span className="status-title-icon">{iconForStatus(overallStatus)}</span>
              <h1>{summaryTitle(overallStatus)}</h1>
            </div>
            <p>{summaryCopy(overallStatus, endpoint)}</p>
          </div>

          <aside className="status-hero-panel" aria-label="Current status summary">
            <StatusBadge status={overallStatus} />
            <dl>
              <div>
                <dt>Last checked</dt>
                <dd>{formatDateTime(checkedAt)}</dd>
              </div>
              <div>
                <dt>Latency</dt>
                <dd>{snapshot?.relayer.latencyMs ? `${snapshot.relayer.latencyMs} ms` : 'Pending'}</dd>
              </div>
              <div>
                <dt>Relayer version</dt>
                <dd>{relayerVersion}</dd>
              </div>
            </dl>
            <button
              type="button"
              className="status-refresh-button"
              onClick={() => {
                setManualRefreshes((count) => count + 1)
                void refresh('manual')
              }}
              disabled={loadState === 'loading'}
              title="Refresh status"
            >
              <RefreshCw
                size={18}
                aria-hidden="true"
                className={loadState === 'loading' ? 'status-spin' : undefined}
              />
              <span>{loadState === 'loading' ? 'Checking' : 'Refresh'}</span>
            </button>
          </aside>
        </section>

        {(error || snapshot?.relayer.error) && (
          <section className="status-alert" role="alert">
            <AlertTriangle size={18} aria-hidden="true" />
            <div>
              <strong>{error ? 'Status service error' : 'Relayer health check error'}</strong>
              <span>{error ?? snapshot?.relayer.error}</span>
            </div>
          </section>
        )}

        <section className="status-grid" aria-label="Service components">
          {rows.map((row) => (
            <article className="status-component-card" key={row.name}>
              <div className="status-component-head">
                <div>
                  <h2>{row.name}</h2>
                  <p>{row.detail}</p>
                </div>
                <StatusBadge status={row.status} />
              </div>
              <div className="status-component-foot">
                <span>{row.meta}</span>
                <span>{statusDescription[row.status]}</span>
              </div>
            </article>
          ))}
        </section>

        <section className="status-detail-grid">
          <article className="status-panel">
            <div className="status-panel-title">
              <Server size={19} aria-hidden="true" />
              <h2>Relayer Details</h2>
            </div>
            <dl className="status-detail-list">
              <div>
                <dt>Endpoint</dt>
                <dd>{endpoint ?? 'Loading'}</dd>
              </div>
              <div>
                <dt>HTTP status</dt>
                <dd>{snapshot?.relayer.httpStatus ? `HTTP ${snapshot.relayer.httpStatus}` : 'Pending'}</dd>
              </div>
              <div>
                <dt>Runtime mode</dt>
                <dd>{snapshot?.relayer.health?.mode ?? 'Unknown'}</dd>
              </div>
              <div>
                <dt>API version</dt>
                <dd>{snapshot?.relayer.health?.apiVersion ?? 'Unknown'}</dd>
              </div>
              <div>
                <dt>Build</dt>
                <dd>{buildCommit ?? 'Not reported'}</dd>
              </div>
            </dl>
          </article>

          <article className="status-panel">
            <div className="status-panel-title">
              <ShieldCheck size={19} aria-hidden="true" />
              <h2>Supported Clients</h2>
            </div>
            <dl className="status-detail-list status-detail-list--compact">
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
            <div className="status-feature-flags">
              {activeFeatureFlags.length ? (
                activeFeatureFlags.slice(0, 5).map(([flag]) => (
                  <span key={flag}>{flag}</span>
                ))
              ) : (
                <span>No feature flags reported</span>
              )}
            </div>
          </article>

          <article className="status-panel">
            <div className="status-panel-title">
              <Wifi size={19} aria-hidden="true" />
              <h2>External Dependencies</h2>
            </div>
            <div className="status-links">
              {dependencies.map((dependency) => (
                <a key={dependency.name} href={dependency.url} target="_blank" rel="noopener noreferrer">
                  <span>{dependency.name}</span>
                  <ExternalLink size={15} aria-hidden="true" />
                </a>
              ))}
            </div>
          </article>

          <article className="status-panel">
            <div className="status-panel-title">
              <Clock3 size={19} aria-hidden="true" />
              <h2>Incidents</h2>
            </div>
            <div className="status-incident">
              <span>{formatDate(new Date())}</span>
              <strong>
                {overallStatus === 'outage'
                  ? 'Live health check is failing'
                  : 'No active incident reported here'}
              </strong>
              <p>
                {overallStatus === 'outage'
                  ? 'The status service detected a failed relayer probe. Check deployment logs and upstream providers.'
                  : 'This service currently exposes live health only; historical incident storage is not configured.'}
              </p>
            </div>
          </article>
        </section>

        <footer className="status-footer">
          <span>Auto-refreshes every {REFRESH_INTERVAL_MS / 1000}s</span>
          <span aria-hidden="true">/</span>
          <span>Manual refreshes {manualRefreshes}</span>
        </footer>
      </main>
    </div>
  )
}
