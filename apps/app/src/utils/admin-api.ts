import { config } from '../config'

export interface WalletBalance {
  address: string
  suiBalance: bigint
  walBalance: bigint
  thresholdPercent: number
  status: 'healthy' | 'warning' | 'critical'
}

export interface SponsorWallet {
  address: string
  suiBalance: bigint
  suiThreshold: bigint
  status: 'healthy' | 'warning' | 'critical'
}

export interface UploadError {
  timestamp: string
  owner: string
  namespace: string
  errorMessage: string
}

export interface AdminConfig {
  balanceMonitorIntervalSecs: number
  uploaderWalLowThresholdFrost: bigint
  sponsorSuiLowThresholdMist: bigint
  adminApiKeySet: boolean
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
      throw new Error('SERVER_ERROR')
    }
    const text = await resp.text()
    throw new Error(text || `HTTP ${resp.status}`)
  }

  return resp.json()
}

// Backend (snake_case, Rust) wire shapes — as actually returned by
// services/server/src/routes/admin_dashboard.rs. Kept separate from the
// camelCase UI-facing types above; the fetch* functions below map one to
// the other at this API boundary.
interface RawWalletBalance {
  sui: string
  wal: string
}

interface RawWalletsResponse {
  uploader_pool: {
    wallet: RawWalletBalance
    wal_threshold: string
    status: string
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
  wallet_wal_low_threshold_frost: number
  sponsor_sui_low_threshold_mist: number
  admin_api_key_set: boolean
}

function toBadgeStatus(status: string): 'healthy' | 'warning' | 'critical' {
  if (status === 'ok') return 'healthy'
  if (status === 'low') return 'critical'
  return 'warning'
}

export async function fetchAdminWallets(
  adminKey: string,
): Promise<AdminWalletsResponse> {
  const raw = (await makeAdminRequest('/wallets', adminKey)) as RawWalletsResponse

  return {
    uploaderPoolWallets: [
      {
        address: 'Uploader Pool',
        suiBalance: BigInt(raw.uploader_pool.wallet.sui || '0'),
        walBalance: BigInt(raw.uploader_pool.wallet.wal || '0'),
        thresholdPercent:
          Number(raw.uploader_pool.wal_threshold) > 0
            ? (Number(raw.uploader_pool.wallet.wal) /
                Number(raw.uploader_pool.wal_threshold)) *
              100
            : 0,
        status: toBadgeStatus(raw.uploader_pool.status),
      },
    ],
    sponsorWallet: {
      address: raw.sponsor_wallet.address ?? 'Not configured',
      suiBalance: BigInt(raw.sponsor_wallet.sui || '0'),
      suiThreshold: BigInt(raw.sponsor_wallet.sui_threshold || '0'),
      status: toBadgeStatus(raw.sponsor_wallet.status),
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
      timestamp: job.created_at,
      owner: job.owner,
      namespace: job.namespace,
      errorMessage: job.error_msg ?? '(no error message)',
    })),
    total: raw.total,
    limit: raw.limit,
    offset: raw.offset,
  }
}

export async function fetchAdminConfig(
  adminKey: string,
): Promise<AdminConfig> {
  const raw = (await makeAdminRequest('/config', adminKey)) as RawConfigResponse

  return {
    balanceMonitorIntervalSecs: raw.balance_monitor_interval_secs,
    uploaderWalLowThresholdFrost: BigInt(raw.wallet_wal_low_threshold_frost),
    sponsorSuiLowThresholdMist: BigInt(raw.sponsor_sui_low_threshold_mist),
    adminApiKeySet: raw.admin_api_key_set,
  }
}
