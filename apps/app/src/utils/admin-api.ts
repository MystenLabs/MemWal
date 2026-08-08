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

async function makeAdminRequest<T>(
  endpoint: string,
  adminKey: string,
  method: string = 'GET',
  body?: unknown,
): Promise<T> {
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

  const resp = await fetch(`/api/admin${endpoint}`, opts)

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

export async function fetchAdminWallets(
  adminKey: string,
): Promise<AdminWalletsResponse> {
  return makeAdminRequest<AdminWalletsResponse>(
    '/wallets',
    adminKey,
  )
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
  return makeAdminRequest<AdminErrorsResponse>(
    `/upload-errors?${params}`,
    adminKey,
  )
}

export async function fetchAdminConfig(
  adminKey: string,
): Promise<AdminConfig> {
  return makeAdminRequest<AdminConfig>(
    '/config',
    adminKey,
  )
}
