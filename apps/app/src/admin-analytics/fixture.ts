import { inWindow, percentiles, sum, type Metric } from './metrics'

export interface Attempt {
  id: string
  hop: 'relayer-client' | 'aggregator-relayer' | 'node'
  upstream: string
  bytes: string | null
  latencyMs: number
  outcome: 'served' | 'fallback' | 'losing-hedge' | 'error' | 'unavailable'
}

export interface DemoRequest {
  id: string
  at: string
  accountId: string
  owner: string
  delegateId: string | null
  delegateStatus: 'active' | 'revoked' | 'owner-session'
  operation: 'recall' | 'restore' | 'memory_read'
  source: 'mcp' | 'sdk' | 'python-sdk' | 'unknown'
  namespace: string
  status: 'ok' | 'error' | 'canceled'
  returned: number
  cache: 'hit' | 'miss'
  latencyMs: number
  relayerBytes: string
  upstreamBytes: string | null
  nodeBytes: null
  attempts: Attempt[]
}

export interface DemoAccount {
  id: string
  owner: string
  status: 'live' | 'deactivated'
  registeredKeys: number
  spark: number[]
  plaintext: Metric
  encrypted: Metric
  encoded: Metric
}

export interface DemoModel {
  label: 'demo-fixture'
  generatedAt: string
  definitionVersion: 'admin-analytics-demo-1'
  accounts: DemoAccount[]
  requests: DemoRequest[]
  incident: { id: string; label: string; start: string; end: string }
}

const ACCOUNTS: Array<Omit<DemoAccount, 'spark'>> = [
  {
    id: 'acc_7f3a',
    owner: '0x4f2a91c0b18e44d0a91c77e2c91e0011aa77c91e',
    status: 'live',
    registeredKeys: 3,
    plaintext: { state: 'measured', value: 1843200n, coverage: 1 },
    encrypted: { state: 'measured', value: 2411724n, coverage: 1 },
    encoded: {
      state: 'estimated',
      value: 4823448n,
      coverage: 0.72,
      method: 'Protocol estimate, encoding version unverified. Not a fixed multiplier claim.',
    },
  },
  {
    id: 'acc_12c4',
    owner: '0x91bb02aa6610de44c0e19a221122a04410bb91aa',
    status: 'live',
    registeredKeys: 2,
    plaintext: { state: 'measured', value: 962560n, coverage: 1 },
    encrypted: { state: 'measured', value: 1280400n, coverage: 1 },
    encoded: { state: 'unavailable', reason: 'Encoded size field not verified for this deployment' },
  },
  {
    id: 'acc_90de',
    owner: '0x0c77e11490aabbccddeeff001122334455667788',
    status: 'live',
    registeredKeys: 1,
    plaintext: { state: 'unavailable', reason: 'Plaintext length was not recorded at the write boundary' },
    encrypted: { state: 'measured', value: 640112n, coverage: 1 },
    encoded: { state: 'unavailable', reason: 'Encoded size field not verified for this deployment' },
  },
  {
    id: 'acc_00aa',
    owner: '0x00aa1144deadbeef00112233445566778899aabb',
    status: 'deactivated',
    registeredKeys: 1,
    plaintext: { state: 'measured', value: 0n, coverage: 1 },
    encrypted: { state: 'measured', value: 0n, coverage: 1 },
    encoded: { state: 'unavailable', reason: 'No live blob to encode' },
  },
]

function mulberry32(seed: number) {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

export function buildDemo(now: Date): DemoModel {
  const rand = mulberry32(20261011)
  const requests: DemoRequest[] = []
  const active = ACCOUNTS.filter((account) => account.status === 'live')
  const delegates = [
    { id: 'fp_a1b2c3', status: 'active' as const },
    { id: 'fp_c3d4e5', status: 'revoked' as const },
    { id: null, status: 'owner-session' as const },
  ]
  const sources = ['mcp', 'sdk', 'python-sdk', 'unknown'] as const
  const operations = ['recall', 'restore', 'memory_read'] as const
  for (let i = 0; i < 72; i += 1) {
    const account = active[i % active.length]
    const hoursAgo = Math.floor(rand() * 24 * 8)
    const at = new Date(now.getTime() - hoursAgo * 3600_000 - Math.floor(rand() * 3600_000))
    const delegate = delegates[i % delegates.length]
    const cache = rand() > 0.35 ? 'miss' : 'hit'
    const status = rand() > 0.92 ? 'error' : rand() > 0.97 ? 'canceled' : 'ok'
    const relayer = cache === 'hit' && status === 'ok' ? 420 + Math.floor(rand() * 800) : 18_000 + Math.floor(rand() * 220_000)
    const upstream = cache === 'hit' ? 0 : 24_000 + Math.floor(rand() * 260_000)
    const requestId = `req_${String(i + 1).padStart(3, '0')}`
    requests.push({
      id: requestId,
      at: at.toISOString(),
      accountId: account.id,
      owner: account.owner,
      delegateId: delegate.id,
      delegateStatus: delegate.status,
      operation: operations[i % operations.length],
      source: sources[i % sources.length],
      namespace: i % 4 === 0 ? 'default' : i % 4 === 1 ? 'research' : 'agent',
      status,
      returned: status === 'ok' ? 1 + Math.floor(rand() * 6) : 0,
      cache,
      latencyMs: 40 + Math.floor(rand() * 900),
      relayerBytes: String(relayer),
      upstreamBytes: String(upstream),
      nodeBytes: null,
      attempts: [
        {
          id: `${requestId}_a1`,
          hop: 'relayer-client',
          upstream: 'relayer',
          bytes: String(relayer),
          latencyMs: 12 + Math.floor(rand() * 40),
          outcome: status === 'ok' ? 'served' : status,
        },
        {
          id: `${requestId}_a2`,
          hop: 'aggregator-relayer',
          upstream: cache === 'hit' ? 'cache' : 'aggregator-a',
          bytes: String(upstream),
          latencyMs: cache === 'hit' ? 0 : 80 + Math.floor(rand() * 400),
          outcome: cache === 'hit' ? 'served' : rand() > 0.85 ? 'fallback' : 'served',
        },
        {
          id: `${requestId}_a3`,
          hop: 'node',
          upstream: 'walrus-storage-node',
          bytes: null,
          latencyMs: 0,
          outcome: 'unavailable',
        },
      ],
    })
  }
  const sparkFor = (accountId: string) => {
    const points: number[] = []
    for (let day = 6; day >= 0; day -= 1) {
      const start = new Date(now.getTime() - (day + 1) * 86400_000)
      const end = new Date(now.getTime() - day * 86400_000)
      points.push(requests.filter((request) => request.accountId === accountId && inWindow(request.at, start, end)).length)
    }
    return points
  }
  const incidentEnd = new Date(now.getTime() - 36 * 3600_000)
  const incidentStart = new Date(incidentEnd.getTime() - 6 * 3600_000)
  return {
    label: 'demo-fixture',
    generatedAt: now.toISOString(),
    definitionVersion: 'admin-analytics-demo-1',
    accounts: ACCOUNTS.map((account) => ({ ...account, spark: sparkFor(account.id) })),
    requests,
    incident: {
      id: 'demo-incident',
      label: 'Demo annotation. Incident year is not verified. This is not an April/May preset.',
      start: incidentStart.toISOString(),
      end: incidentEnd.toISOString(),
    },
  }
}

export interface PopulationSummary {
  total: bigint
  p50: bigint | null
  p90: bigint | null
  p99: bigint | null
  samples: number
  tailUnstable: boolean
}

export function requestsInRange(model: DemoModel, start: Date, end: Date, accountId?: string) {
  return model.requests.filter((request) => {
    if (accountId && request.accountId !== accountId) return false
    return inWindow(request.at, start, end)
  })
}

export function bytePopulation(requests: DemoRequest[], field: 'relayerBytes' | 'upstreamBytes'): bigint[] {
  return requests
    .map((request) => request[field])
    .filter((value): value is string => value != null)
    .map((value) => BigInt(value))
}

export function populationSummary(values: bigint[]): PopulationSummary {
  return {
    total: sum(values),
    ...percentiles(values),
  }
}

