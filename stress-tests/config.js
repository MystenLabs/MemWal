// K6 Stress Test Configuration
// Adjust these values based on your testing needs

export const BASE_URL = __ENV.BASE_URL || 'https://memwal.vercel.app'

// Test wallet address (use a test wallet)
export const TEST_WALLET = __ENV.TEST_WALLET || '0x1234567890abcdef1234567890abcdef12345678'

// Thresholds for performance requirements
export const THRESHOLDS = {
  // 95% of requests should complete within 2s
  http_req_duration: ['p(95)<2000', 'p(99)<5000'],
  // Error rate should be less than 5%
  http_req_failed: ['rate<0.05'],
  // At least 10 requests per second
  http_reqs: ['rate>10'],
}

// Test scenarios configuration
export const SCENARIOS = {
  // Smoke test - light load to verify system works
  smoke: {
    vus: 1,
    duration: '30s',
  },

  // Load test - normal expected load
  load: {
    stages: [
      { duration: '1m', target: 10 },   // Ramp up to 10 users
      { duration: '3m', target: 10 },   // Stay at 10 users
      { duration: '1m', target: 0 },    // Ramp down
    ],
  },

  // Stress test - find breaking point
  stress: {
    stages: [
      { duration: '1m', target: 20 },   // Ramp up to 20 users
      { duration: '2m', target: 20 },   // Stay at 20 users
      { duration: '1m', target: 50 },   // Spike to 50 users
      { duration: '2m', target: 50 },   // Stay at 50 users
      { duration: '1m', target: 100 },  // Spike to 100 users
      { duration: '2m', target: 100 },  // Stay at 100 users
      { duration: '2m', target: 0 },    // Ramp down
    ],
  },

  // Spike test - sudden traffic spike
  spike: {
    stages: [
      { duration: '30s', target: 5 },    // Normal load
      { duration: '10s', target: 100 },  // Spike!
      { duration: '1m', target: 100 },   // Stay high
      { duration: '10s', target: 5 },    // Drop
      { duration: '30s', target: 5 },    // Recovery
      { duration: '30s', target: 0 },    // Ramp down
    ],
  },

  // Soak test - sustained load over time (for memory leak detection)
  soak: {
    stages: [
      { duration: '2m', target: 20 },    // Ramp up
      { duration: '30m', target: 20 },   // Sustain for 30 minutes
      { duration: '2m', target: 0 },     // Ramp down
    ],
  },
}

// Sample test data
export const TEST_MESSAGES = [
  "What is my name?",
  "Remember that I like pizza",
  "What are my hobbies?",
  "Store in memory: I was born in 1990",
  "Tell me about my preferences",
  "Remember: My favorite color is blue",
  "What did I tell you earlier?",
  "Note that I work as a software engineer",
]

export const TEST_MEMORIES = [
  "I love hiking in the mountains",
  "My favorite programming language is TypeScript",
  "I have a cat named Whiskers",
  "I prefer dark mode in all my apps",
  "My morning routine starts at 6 AM",
]
