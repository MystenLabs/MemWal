import http from 'k6/http'
import { check, sleep, group } from 'k6'
import { Counter, Rate, Trend } from 'k6/metrics'
import { BASE_URL, TEST_WALLET, THRESHOLDS, SCENARIOS, TEST_MEMORIES } from './config.js'

// Custom metrics
const memoryPrepareTime = new Trend('memory_prepare_time', true)
const embeddingTime = new Trend('embedding_time', true)
const memoryErrors = new Counter('memory_errors')
const memorySuccessRate = new Rate('memory_success_rate')

// Test configuration
export const options = {
  scenarios: {
    load_test: {
      executor: 'ramping-vus',
      ...SCENARIOS.load,
    },
  },
  thresholds: {
    ...THRESHOLDS,
    memory_prepare_time: ['p(95)<2000'], // Memory prep should complete within 2s
    embedding_time: ['p(95)<1000'],      // Embedding should complete within 1s
  },
}

// Override scenario via environment variable
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
  group('Memory Prepare API Tests', () => {
    // Pick a random memory content
    const content = TEST_MEMORIES[Math.floor(Math.random() * TEST_MEMORIES.length)]

    const payload = JSON.stringify({
      content: content,
      walletAddress: TEST_WALLET,
    })

    const params = {
      headers: {
        'Content-Type': 'application/json',
      },
      timeout: '30s',
    }

    // Test memory prepare endpoint
    const startTime = Date.now()
    const response = http.post(`${BASE_URL}/api/memory/prepare`, payload, params)
    const duration = Date.now() - startTime

    // Record metrics
    memoryPrepareTime.add(duration)

    // Validate response
    const success = check(response, {
      'status is 200': (r) => r.status === 200,
      'response is JSON': (r) => {
        try {
          JSON.parse(r.body)
          return true
        } catch {
          return false
        }
      },
      'has success flag': (r) => {
        try {
          const data = JSON.parse(r.body)
          return data.success === true
        } catch {
          return false
        }
      },
      'has embedding': (r) => {
        try {
          const data = JSON.parse(r.body)
          return data.prepared?.embedding?.length > 0
        } catch {
          return false
        }
      },
    })

    if (success) {
      memorySuccessRate.add(1)

      // Parse response to check embedding
      try {
        const data = JSON.parse(response.body)
        if (data.prepared?.embedding) {
          console.log(`✅ Embedding: ${data.prepared.embedding.length} dimensions`)
        }
      } catch (e) {
        // ignore
      }
    } else {
      memorySuccessRate.add(0)
      memoryErrors.add(1)
      console.log(`❌ Memory prepare failed: status=${response.status}, body=${response.body?.substring(0, 200)}`)
    }

    // Think time
    sleep(Math.random() * 2 + 1)
  })

  group('Memory Save API Tests', () => {
    const content = TEST_MEMORIES[Math.floor(Math.random() * TEST_MEMORIES.length)]

    const payload = JSON.stringify({
      content: content,
      walletAddress: TEST_WALLET,
    })

    const params = {
      headers: {
        'Content-Type': 'application/json',
      },
      timeout: '30s',
    }

    const response = http.post(`${BASE_URL}/api/memory/save`, payload, params)

    check(response, {
      'save status is 200': (r) => r.status === 200,
      'save has success': (r) => {
        try {
          return JSON.parse(r.body).success === true
        } catch {
          return false
        }
      },
    })

    sleep(Math.random() * 2 + 1)
  })
}

export function handleSummary(data) {
  const summary = {
    timestamp: new Date().toISOString(),
    test: 'memory-api',
    scenario: __ENV.SCENARIO || 'load',
    metrics: {
      requests: {
        total: data.metrics.http_reqs?.values?.count || 0,
        rate: data.metrics.http_reqs?.values?.rate || 0,
      },
      duration: {
        avg: data.metrics.http_req_duration?.values?.avg || 0,
        p95: data.metrics.http_req_duration?.values?.['p(95)'] || 0,
        p99: data.metrics.http_req_duration?.values?.['p(99)'] || 0,
      },
      errors: {
        rate: data.metrics.http_req_failed?.values?.rate || 0,
        count: data.metrics.memory_errors?.values?.count || 0,
      },
      memory: {
        avgPrepareTime: data.metrics.memory_prepare_time?.values?.avg || 0,
        p95PrepareTime: data.metrics.memory_prepare_time?.values?.['p(95)'] || 0,
        successRate: data.metrics.memory_success_rate?.values?.rate || 0,
      },
    },
  }

  return {
    'stdout': JSON.stringify(summary, null, 2),
    './stress-tests/results/memory-api-summary.json': JSON.stringify(summary, null, 2),
  }
}
