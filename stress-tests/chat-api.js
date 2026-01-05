import http from 'k6/http'
import { check, sleep, group } from 'k6'
import { Counter, Rate, Trend } from 'k6/metrics'
import { BASE_URL, TEST_WALLET, THRESHOLDS, SCENARIOS, TEST_MESSAGES } from './config.js'

// Custom metrics
const chatResponseTime = new Trend('chat_response_time', true)
const chatErrors = new Counter('chat_errors')
const chatSuccessRate = new Rate('chat_success_rate')

// Test configuration
export const options = {
  scenarios: {
    // Default: load test
    load_test: {
      executor: 'ramping-vus',
      ...SCENARIOS.load,
    },
  },
  thresholds: {
    ...THRESHOLDS,
    chat_response_time: ['p(95)<3000'], // Chat should respond within 3s
  },
}

// Override scenario via environment variable
// Usage: k6 run -e SCENARIO=stress chat-api.js
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
  group('Chat API Tests', () => {
    // Pick a random message
    const message = TEST_MESSAGES[Math.floor(Math.random() * TEST_MESSAGES.length)]

    const payload = JSON.stringify({
      messages: [
        { role: 'user', content: message }
      ],
      walletAddress: TEST_WALLET,
    })

    const params = {
      headers: {
        'Content-Type': 'application/json',
      },
      timeout: '30s',
    }

    const startTime = Date.now()
    const response = http.post(`${BASE_URL}/api/chat`, payload, params)
    const duration = Date.now() - startTime

    // Record custom metrics
    chatResponseTime.add(duration)

    // Validate response
    const success = check(response, {
      'status is 200': (r) => r.status === 200,
      'response has body': (r) => r.body && r.body.length > 0,
      'no server error': (r) => r.status < 500,
    })

    if (success) {
      chatSuccessRate.add(1)
    } else {
      chatSuccessRate.add(0)
      chatErrors.add(1)
      console.log(`❌ Chat failed: status=${response.status}, body=${response.body?.substring(0, 200)}`)
    }

    // Simulate user think time (1-3 seconds between requests)
    sleep(Math.random() * 2 + 1)
  })
}

export function handleSummary(data) {
  const summary = {
    timestamp: new Date().toISOString(),
    test: 'chat-api',
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
        count: data.metrics.chat_errors?.values?.count || 0,
      },
      chat: {
        avgResponseTime: data.metrics.chat_response_time?.values?.avg || 0,
        p95ResponseTime: data.metrics.chat_response_time?.values?.['p(95)'] || 0,
        successRate: data.metrics.chat_success_rate?.values?.rate || 0,
      },
    },
  }

  return {
    'stdout': JSON.stringify(summary, null, 2),
    './stress-tests/results/chat-api-summary.json': JSON.stringify(summary, null, 2),
  }
}
