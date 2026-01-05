import http from 'k6/http'
import { check, sleep, group } from 'k6'
import { Counter, Rate, Trend } from 'k6/metrics'
import { BASE_URL, TEST_WALLET, THRESHOLDS, SCENARIOS, TEST_MESSAGES, TEST_MEMORIES } from './config.js'

// Custom metrics
const fullFlowTime = new Trend('full_flow_time', true)
const indexInitTime = new Trend('index_init_time', true)
const chatTime = new Trend('chat_time', true)
const memoryTime = new Trend('memory_time', true)
const flowErrors = new Counter('flow_errors')
const flowSuccessRate = new Rate('flow_success_rate')

// Test configuration - Use soak test by default for memory leak detection
export const options = {
  scenarios: {
    soak_test: {
      executor: 'ramping-vus',
      ...SCENARIOS.soak,
    },
  },
  thresholds: {
    ...THRESHOLDS,
    full_flow_time: ['p(95)<10000'], // Full flow should complete within 10s
    index_init_time: ['p(95)<5000'], // Index init within 5s
  },
}

// Override scenario
const selectedScenario = __ENV.SCENARIO
if (selectedScenario && SCENARIOS[selectedScenario]) {
  options.scenarios = {
    [selectedScenario]: {
      executor: selectedScenario === 'smoke' ? 'constant-vus' : 'ramping-vus',
      ...SCENARIOS[selectedScenario],
    },
  }
}

export default function () {
  const flowStart = Date.now()
  let flowSuccess = true

  // Generate unique wallet for each VU to test LRU cache
  const vuWallet = `${TEST_WALLET}_vu${__VU}_iter${__ITER}`

  group('1. Index Initialization', () => {
    const payload = JSON.stringify({
      walletAddress: vuWallet,
    })

    const params = {
      headers: { 'Content-Type': 'application/json' },
      timeout: '60s',
    }

    const start = Date.now()
    const response = http.post(`${BASE_URL}/api/index/init`, payload, params)
    indexInitTime.add(Date.now() - start)

    const success = check(response, {
      'init status is 200': (r) => r.status === 200,
      'init returns success': (r) => {
        try {
          const data = JSON.parse(r.body)
          return data.success === true || data.error?.includes('already')
        } catch {
          return false
        }
      },
    })

    if (!success) {
      flowSuccess = false
      flowErrors.add(1)
      console.log(`❌ Index init failed: ${response.status} - ${response.body?.substring(0, 100)}`)
    }

    sleep(0.5)
  })

  group('2. Memory Prepare & Save', () => {
    const content = TEST_MEMORIES[Math.floor(Math.random() * TEST_MEMORIES.length)]

    const payload = JSON.stringify({
      content: content,
      walletAddress: vuWallet,
    })

    const params = {
      headers: { 'Content-Type': 'application/json' },
      timeout: '30s',
    }

    const start = Date.now()
    const response = http.post(`${BASE_URL}/api/memory/save`, payload, params)
    memoryTime.add(Date.now() - start)

    const success = check(response, {
      'memory save status 200': (r) => r.status === 200,
    })

    if (!success) {
      flowSuccess = false
      console.log(`❌ Memory save failed: ${response.status}`)
    }

    sleep(0.5)
  })

  group('3. Chat with Memory Search', () => {
    const message = TEST_MESSAGES[Math.floor(Math.random() * TEST_MESSAGES.length)]

    const payload = JSON.stringify({
      messages: [{ role: 'user', content: message }],
      walletAddress: vuWallet,
    })

    const params = {
      headers: { 'Content-Type': 'application/json' },
      timeout: '30s',
    }

    const start = Date.now()
    const response = http.post(`${BASE_URL}/api/chat`, payload, params)
    chatTime.add(Date.now() - start)

    const success = check(response, {
      'chat status 200': (r) => r.status === 200,
      'chat has response': (r) => r.body && r.body.length > 0,
    })

    if (!success) {
      flowSuccess = false
      console.log(`❌ Chat failed: ${response.status}`)
    }

    sleep(1)
  })

  group('4. Index Status Check', () => {
    const params = {
      headers: { 'Content-Type': 'application/json' },
      timeout: '10s',
    }

    const response = http.get(
      `${BASE_URL}/api/index/status?walletAddress=${encodeURIComponent(vuWallet)}`,
      params
    )

    check(response, {
      'status check returns 200': (r) => r.status === 200,
    })

    sleep(0.5)
  })

  // Record full flow metrics
  fullFlowTime.add(Date.now() - flowStart)
  flowSuccessRate.add(flowSuccess ? 1 : 0)

  // Think time between iterations
  sleep(Math.random() * 3 + 2)
}

export function handleSummary(data) {
  const summary = {
    timestamp: new Date().toISOString(),
    test: 'full-flow',
    scenario: __ENV.SCENARIO || 'soak',
    purpose: 'Memory leak detection and full flow performance',
    metrics: {
      requests: {
        total: data.metrics.http_reqs?.values?.count || 0,
        rate: data.metrics.http_reqs?.values?.rate || 0,
      },
      fullFlow: {
        avg: data.metrics.full_flow_time?.values?.avg || 0,
        p95: data.metrics.full_flow_time?.values?.['p(95)'] || 0,
        p99: data.metrics.full_flow_time?.values?.['p(99)'] || 0,
        successRate: data.metrics.flow_success_rate?.values?.rate || 0,
      },
      indexInit: {
        avg: data.metrics.index_init_time?.values?.avg || 0,
        p95: data.metrics.index_init_time?.values?.['p(95)'] || 0,
      },
      chat: {
        avg: data.metrics.chat_time?.values?.avg || 0,
        p95: data.metrics.chat_time?.values?.['p(95)'] || 0,
      },
      memory: {
        avg: data.metrics.memory_time?.values?.avg || 0,
        p95: data.metrics.memory_time?.values?.['p(95)'] || 0,
      },
      errors: {
        rate: data.metrics.http_req_failed?.values?.rate || 0,
        count: data.metrics.flow_errors?.values?.count || 0,
      },
    },
    analysis: {
      note: 'Monitor server memory usage during soak test to detect memory leaks',
      lruCacheTest: 'Each VU uses unique wallet to test LRU cache eviction',
    },
  }

  return {
    'stdout': JSON.stringify(summary, null, 2),
    './stress-tests/results/full-flow-summary.json': JSON.stringify(summary, null, 2),
  }
}
