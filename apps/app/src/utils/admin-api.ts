import { config } from '../config'

export interface WalletBalance {
  address: string
  suiBalance: bigint
  walBalance: bigint
  suiTotal: bigint
  walTotal: bigint
  status: 'ok' | 'low' | 'unknown'
}

export interface SponsorWallet {
  address: string
  suiBalance: bigint
  suiThreshold: bigint
  status: 'ok' | 'low' | 'unknown'
}

export interface UploadError {
  id: string
  /** When the job failed (last update). */
  timestamp: string
  /** When the job was queued. */
  createdAt: string
  owner: string
  namespace: string
  status: string
  /** The server's message, or null when it recorded none. */
  rawErrorMessage: string | null
  errorMessage: string
}

/** `0x5c3a...907e`: enough of both ends to tell addresses apart. */
export function shortAddress(address: string): string {
  return address.length > 14 ? `${address.slice(0, 6)}...${address.slice(-4)}` : address
}

/** The account page for an address on this deployment's Sui network. */
export function suiExplorerAccountUrl(address: string): string {
  return `https://suiscan.xyz/${config.suiNetwork}/account/${address}`
}

export interface AdminConfig {
  balanceMonitorIntervalSecs: number
  uploaderWalLowThresholdFrost: bigint
  uploaderSuiLowThresholdMist: bigint
  sponsorSuiLowThresholdMist: bigint
}

export interface AdminWalletsResponse {
  uploaderPoolWallets: WalletBalance[]
  sponsorWallet: SponsorWallet
  lastUpdated: string
}

export interface AdminErrorsResponse {
  errors: UploadError[]
  total: number
  limit: number
  offset: number
}

/**
 * Format a raw base-unit amount (mist/frost, 9 decimals) as a human-readable
 * token amount, e.g. 50026696048n -> "50.0267".
 */
export function formatTokenAmount(raw: bigint): string {
  const decimals = 9n
  const divisor = 10n ** decimals
  const negative = raw < 0n
  const abs = negative ? -raw : raw
  const whole = abs / divisor
  const frac = abs % divisor
  const fracStr = frac
    .toString()
    .padStart(Number(decimals), '0')
    .slice(0, 4)
    .replace(/0+$/, '')
  const wholeStr = whole.toLocaleString()
  const sign = negative ? '-' : ''
  return fracStr ? `${sign}${wholeStr}.${fracStr}` : `${sign}${wholeStr}`
}

async function makeAdminRequest(
  endpoint: string,
  adminKey: string,
  method: string = 'GET',
  body?: unknown,
): Promise<unknown> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'x-admin-api-key': adminKey,
  }

  const opts: RequestInit = {
    method,
    headers,
    cache: 'no-store',
  }

  if (body) {
    opts.body = JSON.stringify(body)
  }

  const baseUrl = config.memwalServerUrl.replace(/\/$/, '')
  const resp = await fetch(`${baseUrl}/api/admin${endpoint}`, opts)

  if (!resp.ok) {
    if (resp.status === 401 || resp.status === 403) {
      throw new Error('INVALID_KEY')
    }
    if (resp.status >= 500) {
      throw new Error(`SERVER_ERROR ${resp.status} ${endpoint}`)
    }
    const text = await resp.text()
    throw new Error(text || `HTTP ${resp.status} ${endpoint}`)
  }

  return resp.json()
}

// Backend (snake_case, Rust) wire shapes — as actually returned by
// services/server/src/routes/admin_dashboard.rs. Kept separate from the
// camelCase UI-facing types above; the fetch* functions below map one to
// the other at this API boundary.
interface RawWalletBalance {
  address: string
  sui: string
  wal: string
  sui_total?: string
  wal_total?: string
  status: string
}

interface RawWalletsResponse {
  uploader_pool: {
    wallets: RawWalletBalance[]
    wal_threshold: string
    sui_threshold: string
    last_updated: string
  }
  sponsor_wallet: {
    address: string | null
    sui: string
    sui_threshold: string
    status: string
  }
}

interface RawFailedJob {
  id: string
  owner: string
  namespace: string
  status: string
  error_msg: string | null
  created_at: string
  updated_at: string
}

interface RawUploadErrorsResponse {
  results: RawFailedJob[]
  total: number
  limit: number
  offset: number
}

interface RawConfigResponse {
  balance_monitor_interval_secs: number
  wallet_wal_low_threshold_frost: string
  wallet_sui_low_threshold_mist: string
  sponsor_sui_low_threshold_mist: string
}

function sourceWalletStatus(status: string): 'ok' | 'low' | 'unknown' {
  if (status === 'ok' || status === 'low') return status
  return 'unknown'
}

export async function fetchAdminWallets(
  adminKey: string,
): Promise<AdminWalletsResponse> {
  const raw = (await makeAdminRequest('/wallets', adminKey)) as RawWalletsResponse

  return {
    uploaderPoolWallets: raw.uploader_pool.wallets.map((wallet) => ({
      address: wallet.address,
      suiBalance: BigInt(wallet.sui || '0'),
      walBalance: BigInt(wallet.wal || '0'),
      suiTotal: BigInt(wallet.sui_total || wallet.sui || '0'),
      walTotal: BigInt(wallet.wal_total || wallet.wal || '0'),
      status: sourceWalletStatus(wallet.status),
    })),
    sponsorWallet: {
      address: raw.sponsor_wallet.address ?? 'Not configured',
      suiBalance: BigInt(raw.sponsor_wallet.sui || '0'),
      suiThreshold: BigInt(raw.sponsor_wallet.sui_threshold || '0'),
      status: sourceWalletStatus(raw.sponsor_wallet.status),
    },
    lastUpdated: raw.uploader_pool.last_updated,
  }
}

export async function fetchAdminErrors(
  adminKey: string,
  limit: number,
  offset: number,
): Promise<AdminErrorsResponse> {
  const params = new URLSearchParams({
    limit: limit.toString(),
    offset: offset.toString(),
  })
  const raw = (await makeAdminRequest(
    `/upload-errors?${params}`,
    adminKey,
  )) as RawUploadErrorsResponse

  return {
    errors: raw.results.map((job) => ({
      id: job.id,
      timestamp: job.updated_at,
      createdAt: job.created_at,
      owner: job.owner,
      namespace: job.namespace,
      status: job.status,
      rawErrorMessage: job.error_msg,
      errorMessage: job.error_msg ?? '(no error message)',
    })),
    total: raw.total,
    limit: raw.limit,
    offset: raw.offset,
  }
}

export type SpendPace = 'faster' | 'slower' | 'same' | 'unknown'

export function spendPace(
  comparable: boolean,
  outflow: bigint,
  priorOutflow: bigint,
): SpendPace {
  if (!comparable) return 'unknown'
  if (outflow > priorOutflow) return 'faster'
  if (outflow < priorOutflow) return 'slower'
  return 'same'
}

export interface ActivitySeriesPoint {
  at: string
  balance: bigint
}

export interface ActivityTokenWindow {
  samples: number
  comparable: boolean
  latest: bigint | null
  latestAt: string | null
  outflow: bigint
  priorOutflow: bigint
  net: bigint
  series: ActivitySeriesPoint[]
}

export interface SponsoredKindCount {
  kind: string
  count: number
  priorCount: number
}

export interface ActivityTopOwner {
  owner: string
  uploadsCompleted: number
}

export interface MemoryHour {
  /** Local clock hour, `YYYY-MM-DDTHH:00`. */
  hour: string
  count: number
}

export interface MemoryDay {
  day: string
  count: number
}

export interface AdminActivity {
  generatedAt: string
  windowHours: number
  windowStart: string | null
  windowEnd: string | null
  priorStart: string | null
  priorEnd: string | null
  clamped: boolean
  balanceMonitorIntervalSecs: number
  uploaderWal: ActivityTokenWindow
  uploaderSui: ActivityTokenWindow
  sponsorSui: ActivityTokenWindow
  actions: {
    uploadsCompleted: number
    uploadsCompletedPrior: number
    uploadsFailed: number
    uploadsFailedPrior: number
    uploadsInFlight: number
    memoryDeletes: number
    memoryDeletesPrior: number
    securityDeleteBatches: number | null
    securityDeleteBatchesPrior: number | null
    securityDeleteBlobs: number | null
    securityDeleteBlobsPrior: number | null
    sponsored: SponsoredKindCount[]
    topOwners: ActivityTopOwner[]
    memoriesByDay: MemoryDay[]
    /** Present only for windows of 24 hours or less. */
    memoriesByHour: MemoryHour[] | null
  }
}

interface RawSeriesPoint {
  at: string
  balance: string
}

interface RawTokenWindow {
  samples: number
  comparable: boolean
  latest: string | null
  latest_at: string | null
  outflow: string
  prior_outflow: string
  net: string
  series: RawSeriesPoint[]
}

interface RawActivityResponse {
  generated_at: string
  window_hours: number
  window_start?: string
  window_end?: string
  prior_start?: string
  prior_end?: string
  clamped?: boolean
  balance_monitor_interval_secs: number
  uploader_wal: RawTokenWindow
  uploader_sui: RawTokenWindow
  sponsor_sui: RawTokenWindow
  actions: {
    uploads_completed: number
    uploads_completed_prior: number
    uploads_failed: number
    uploads_failed_prior: number
    uploads_in_flight: number
    memory_deletes: number
    memory_deletes_prior: number
    security_delete_batches: number | null
    security_delete_batches_prior: number | null
    security_delete_blobs: number | null
    security_delete_blobs_prior: number | null
    sponsored: Array<{ kind: string; count: number; prior_count: number }>
    top_owners: Array<{ owner: string; uploads_completed: number }>
    memories_by_day?: Array<{ day: string; count: number }>
    memories_by_hour?: Array<{ hour: string; count: number }>
  }
}

function mapTokenWindow(raw: RawTokenWindow): ActivityTokenWindow {
  return {
    samples: raw.samples,
    comparable: raw.comparable,
    latest: raw.latest == null ? null : BigInt(raw.latest),
    latestAt: raw.latest_at,
    outflow: BigInt(raw.outflow),
    priorOutflow: BigInt(raw.prior_outflow),
    net: BigInt(raw.net),
    series: raw.series.map((point) => ({
      at: point.at,
      balance: BigInt(point.balance),
    })),
  }
}

export async function fetchAdminActivity(
  adminKey: string,
  window: { start: Date; end: Date; priorStart?: Date | null },
): Promise<AdminActivity> {
  const utcOffsetMinutes = -new Date().getTimezoneOffset()
  const params = new URLSearchParams({
    start: window.start.toISOString(),
    end: window.end.toISOString(),
    utc_offset_minutes: String(utcOffsetMinutes),
  })
  if (window.priorStart) params.set('prior_start', window.priorStart.toISOString())
  const raw = (await makeAdminRequest(`/activity?${params}`, adminKey)) as RawActivityResponse
  return {
    generatedAt: raw.generated_at,
    windowHours: raw.window_hours,
    windowStart: raw.window_start ?? null,
    windowEnd: raw.window_end ?? null,
    priorStart: raw.prior_start ?? null,
    priorEnd: raw.prior_end ?? null,
    clamped: raw.clamped ?? false,
    balanceMonitorIntervalSecs: raw.balance_monitor_interval_secs,
    uploaderWal: mapTokenWindow(raw.uploader_wal),
    uploaderSui: mapTokenWindow(raw.uploader_sui),
    sponsorSui: mapTokenWindow(raw.sponsor_sui),
    actions: {
      uploadsCompleted: raw.actions.uploads_completed,
      uploadsCompletedPrior: raw.actions.uploads_completed_prior,
      uploadsFailed: raw.actions.uploads_failed,
      uploadsFailedPrior: raw.actions.uploads_failed_prior,
      uploadsInFlight: raw.actions.uploads_in_flight,
      memoryDeletes: raw.actions.memory_deletes,
      memoryDeletesPrior: raw.actions.memory_deletes_prior,
      securityDeleteBatches: raw.actions.security_delete_batches,
      securityDeleteBatchesPrior: raw.actions.security_delete_batches_prior,
      securityDeleteBlobs: raw.actions.security_delete_blobs,
      securityDeleteBlobsPrior: raw.actions.security_delete_blobs_prior,
      sponsored: raw.actions.sponsored.map((row) => ({
        kind: row.kind,
        count: row.count,
        priorCount: row.prior_count,
      })),
      topOwners: raw.actions.top_owners.map((row) => ({
        owner: row.owner,
        uploadsCompleted: row.uploads_completed,
      })),
      memoriesByDay: (raw.actions.memories_by_day ?? []).map((row) => ({
        day: row.day,
        count: row.count,
      })),
      memoriesByHour: raw.actions.memories_by_hour
        ? raw.actions.memories_by_hour.map((row) => ({ hour: row.hour, count: row.count }))
        : null,
    },
  }
}

export async function fetchAdminConfig(
  adminKey: string,
): Promise<AdminConfig> {
  const raw = (await makeAdminRequest('/config', adminKey)) as RawConfigResponse

  return {
    balanceMonitorIntervalSecs: raw.balance_monitor_interval_secs,
    uploaderWalLowThresholdFrost: BigInt(raw.wallet_wal_low_threshold_frost),
    uploaderSuiLowThresholdMist: BigInt(raw.wallet_sui_low_threshold_mist),
    sponsorSuiLowThresholdMist: BigInt(raw.sponsor_sui_low_threshold_mist),
  }
}

export interface InventoryBreakdown {
  key: string
  rows: number
  knownEncryptedBytes: bigint
}

export interface AdminInventory {
  generatedAt: string
  logicalRows: number
  sizedRows: number
  unknownSizeRows: number
  distinctBlobs: number
  uniqueEncryptedBytes: bigint
  rowSumEncryptedBytes: bigint
  plaintextBytes: bigint | null
  encodedBytes: bigint | null
  namespaces: InventoryBreakdown[]
  owners: InventoryBreakdown[]
}

interface RawInventory {
  generated_at: string
  logical_rows: number
  sized_rows: number
  unknown_size_rows: number
  distinct_blobs: number
  unique_encrypted_bytes: string
  row_sum_encrypted_bytes: string
  plaintext_bytes: string | null
  encoded_bytes: string | null
  namespaces: Array<{ key: string; rows: number; known_encrypted_bytes: string }>
  owners: Array<{ key: string; rows: number; known_encrypted_bytes: string }>
}

export async function fetchAdminInventory(adminKey: string): Promise<AdminInventory> {
  const raw = (await makeAdminRequest('/inventory', adminKey)) as RawInventory
  const mapBreakdown = (row: RawInventory['namespaces'][number]): InventoryBreakdown => ({
    key: row.key,
    rows: row.rows,
    knownEncryptedBytes: BigInt(row.known_encrypted_bytes),
  })
  return {
    generatedAt: raw.generated_at,
    logicalRows: raw.logical_rows,
    sizedRows: raw.sized_rows,
    unknownSizeRows: raw.unknown_size_rows,
    distinctBlobs: raw.distinct_blobs,
    uniqueEncryptedBytes: BigInt(raw.unique_encrypted_bytes),
    rowSumEncryptedBytes: BigInt(raw.row_sum_encrypted_bytes),
    plaintextBytes: raw.plaintext_bytes == null ? null : BigInt(raw.plaintext_bytes),
    encodedBytes: raw.encoded_bytes == null ? null : BigInt(raw.encoded_bytes),
    namespaces: raw.namespaces.map(mapBreakdown),
    owners: raw.owners.map(mapBreakdown),
  }
}

export interface UploadSummary {
  generatedAt: string
  windowStart: string
  windowEnd: string
  clamped: boolean
  queuedNow: number
  processingNow: number
  staleProcessing: number
  completed: number
  completedPrior: number
  failed: number
  failedPrior: number
  successNumerator: number
  successDenominator: number
  oldestQueuedAt: string | null
}

export async function fetchAdminUploadSummary(
  adminKey: string,
  window: { start: Date; end: Date; priorStart?: Date | null },
): Promise<UploadSummary> {
  const params = new URLSearchParams({
    start: window.start.toISOString(),
    end: window.end.toISOString(),
  })
  if (window.priorStart) params.set('prior_start', window.priorStart.toISOString())
  const raw = (await makeAdminRequest(`/upload-summary?${params}`, adminKey)) as {
    generated_at: string
    window_start: string
    window_end: string
    clamped: boolean
    queued_now: number
    processing_now: number
    stale_processing: number
    completed: number
    completed_prior: number
    failed: number
    failed_prior: number
    success_numerator: number
    success_denominator: number
    oldest_queued_at: string | null
  }
  return {
    generatedAt: raw.generated_at,
    windowStart: raw.window_start,
    windowEnd: raw.window_end,
    clamped: raw.clamped,
    queuedNow: raw.queued_now,
    processingNow: raw.processing_now,
    staleProcessing: raw.stale_processing,
    completed: raw.completed,
    completedPrior: raw.completed_prior,
    failed: raw.failed,
    failedPrior: raw.failed_prior,
    successNumerator: raw.success_numerator,
    successDenominator: raw.success_denominator,
    oldestQueuedAt: raw.oldest_queued_at,
  }
}

export interface MeasurementCoverage {
  retrievalRecords: number
  retrievalSince: string | null
  plaintextObservations: number
  plaintextSince: string | null
  snapshots: number
  auditEvents: number
}

export async function fetchAdminCoverage(adminKey: string): Promise<MeasurementCoverage> {
  const raw = (await makeAdminRequest('/coverage', adminKey)) as {
    retrieval_records: number
    retrieval_since: string | null
    plaintext_observations: number
    plaintext_since: string | null
    snapshots: number
    audit_events: number
  }
  return {
    retrievalRecords: raw.retrieval_records,
    retrievalSince: raw.retrieval_since,
    plaintextObservations: raw.plaintext_observations,
    plaintextSince: raw.plaintext_since,
    snapshots: raw.snapshots,
    auditEvents: raw.audit_events,
  }
}

export interface AuditEvent {
  id: string
  createdAt: string
  actor: string
  action: string
  target: string | null
  outcome: string
  summary: string | null
}

export async function fetchAdminAudit(adminKey: string, limit: number, offset: number): Promise<{ events: AuditEvent[]; total: number; limit: number; offset: number }> {
  const params = new URLSearchParams({ limit: String(limit), offset: String(offset) })
  const raw = (await makeAdminRequest(`/audit?${params}`, adminKey)) as {
    results: Array<{ id: string; created_at: string; actor: string; action: string; target: string | null; outcome: string; summary: string | null }>
    total: number
    limit: number
    offset: number
  }
  return {
    events: raw.results.map((event) => ({
      id: event.id,
      createdAt: event.created_at,
      actor: event.actor,
      action: event.action,
      target: event.target,
      outcome: event.outcome,
      summary: event.summary,
    })),
    total: raw.total,
    limit: raw.limit,
    offset: raw.offset,
  }
}


export interface RetrievalPercentiles {
  samples: number
  p50: number | null
  p90: number | null
  p99: number | null
}

export interface RetrievalSummary {
  generatedAt: string
  windowStart: string
  windowEnd: string
  requests: number
  population: string
  method: string
  latencyMs: RetrievalPercentiles
  relayerBodyBytes: RetrievalPercentiles
  upstreamBytes: RetrievalPercentiles
  nodeBytes: RetrievalPercentiles
  nodeReason: string
  bodyDefinition: string
}

export async function fetchAdminRetrieval(adminKey: string, start: Date, end: Date): Promise<RetrievalSummary> {
  const raw = (await makeAdminRequest(`/retrieval?start=${encodeURIComponent(start.toISOString())}&end=${encodeURIComponent(end.toISOString())}`, adminKey)) as {
    generated_at: string
    window_start: string
    window_end: string
    requests: number
    population: string
    method: string
    latency_ms: RetrievalPercentiles
    relayer_body_bytes: RetrievalPercentiles
    upstream_bytes: RetrievalPercentiles
    node_bytes: RetrievalPercentiles
    node_reason: string
    body_definition: string
  }
  return {
    generatedAt: raw.generated_at,
    windowStart: raw.window_start,
    windowEnd: raw.window_end,
    requests: raw.requests,
    population: raw.population,
    method: raw.method,
    latencyMs: raw.latency_ms,
    relayerBodyBytes: raw.relayer_body_bytes,
    upstreamBytes: raw.upstream_bytes,
    nodeBytes: raw.node_bytes,
    nodeReason: raw.node_reason,
    bodyDefinition: raw.body_definition,
  }
}

export interface QualitySource {
  id: string
  name: string
  capability: string
  health: string
  coverage: string
  classification: string
  population: string
  observed: number | null
  expected: number | null
  coveragePercent: number | null
  since: string | null
  lastSuccess: string | null
  limitation: string
  detail: string
  view: string | null
}

export interface QualityInventory {
  generatedAt: string
  checkedAt: string
  commonCompleteness: string | null
  oldestHealthyUpdate: string | null
  sources: QualitySource[]
}

export async function fetchAdminQuality(adminKey: string): Promise<QualityInventory> {
  const raw = (await makeAdminRequest('/quality', adminKey)) as {
    generated_at: string
    checked_at: string
    common_completeness: string | null
    oldest_healthy_update: string | null
    sources: Array<{
      id: string
      name: string
      capability: string
      health: string
      coverage: string
      classification: string
      population: string
      observed: number | null
      expected: number | null
      coverage_percent: number | null
      since: string | null
      last_success: string | null
      limitation: string
      detail: string
      view: string | null
    }>
  }
  return {
    generatedAt: raw.generated_at,
    checkedAt: raw.checked_at,
    commonCompleteness: raw.common_completeness,
    oldestHealthyUpdate: raw.oldest_healthy_update,
    sources: raw.sources.map((source) => ({
      id: source.id,
      name: source.name,
      capability: source.capability,
      health: source.health,
      coverage: source.coverage,
      classification: source.classification,
      population: source.population,
      observed: source.observed,
      expected: source.expected,
      coveragePercent: source.coverage_percent,
      since: source.since,
      lastSuccess: source.last_success,
      limitation: source.limitation,
      detail: source.detail,
      view: source.view,
    })),
  }
}



