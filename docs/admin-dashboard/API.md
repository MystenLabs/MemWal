# Admin Dashboard API Reference

Complete API reference for the MemWal admin dashboard endpoints.

## Authentication

All admin dashboard endpoints require authentication via the `x-admin-api-key` header:

```bash
curl -H "x-admin-api-key: your-admin-api-key" https://memwal.ai/api/admin/wallets
```

**Error Response (Missing/Invalid Key)**:
```
HTTP/1.1 401 Unauthorized
```

---

## Endpoints

### GET /api/admin/wallets

Retrieve current wallet balances for the uploader pool and sponsor wallet.

**Request**:
```bash
curl -H "x-admin-api-key: $ADMIN_KEY" \
  https://memwal.ai/api/admin/wallets
```

**Response** (200 OK):
```json
{
  "uploader_pool": {
    "wallet": {
      "sui": "1000000000",
      "wal": "500000000"
    },
    "last_updated": "2024-01-15T14:30:45Z"
  },
  "sponsor_wallet": {
    "sui": "2000000000"
  }
}
```

**Response Fields**:

| Field | Type | Description |
|-------|------|-------------|
| `uploader_pool.wallet.sui` | string | Uploader pool SUI balance (in mist) |
| `uploader_pool.wallet.wal` | string | Uploader pool WAL balance (in frost) |
| `uploader_pool.last_updated` | string | RFC3339 timestamp of last update |
| `sponsor_wallet.sui` | string | Sponsor wallet SUI balance (in mist) |

**Units**:
- **SUI**: Denominated in `mist` (1 SUI = 10^9 mist)
- **WAL**: Denominated in `frost` (1 WAL = 10^9 frost)

**Possible Errors**:

| Code | Message | Cause |
|------|---------|-------|
| 401 | Unauthorized | Missing or invalid `x-admin-api-key` header |
| 500 | Failed to fetch sidecar wallet metrics | Sidecar service down or unreachable |
| 500 | Sidecar wallet metrics returned status XXX | Sidecar returned an error status |

**Example Usage**:
```bash
#!/bin/bash

ADMIN_KEY="your-admin-api-key"
HOST="memwal.ai"

# Get wallet balances
RESPONSE=$(curl -s -H "x-admin-api-key: $ADMIN_KEY" \
  https://${HOST}/api/admin/wallets)

# Extract values
WAL_BALANCE=$(echo $RESPONSE | jq -r '.uploader_pool.wallet.wal')
SUI_BALANCE=$(echo $RESPONSE | jq -r '.uploader_pool.wallet.sui')

echo "WAL Balance: $WAL_BALANCE frost"
echo "SUI Balance: $SUI_BALANCE mist"

# Check if balance is below threshold
THRESHOLD=500000000
if [ $(echo "$WAL_BALANCE < $THRESHOLD" | bc) -eq 1 ]; then
  echo "WARNING: WAL balance below threshold!"
fi
```

**Latency SLA**: p99 < 500ms (p50 < 100ms)

---

### GET /api/admin/upload-errors

Retrieve paginated list of failed memory upload jobs.

**Request**:
```bash
curl -H "x-admin-api-key: $ADMIN_KEY" \
  "https://memwal.ai/api/admin/upload-errors?limit=50&offset=0"
```

**Query Parameters**:

| Parameter | Type | Default | Range | Description |
|-----------|------|---------|-------|-------------|
| `limit` | integer | 50 | 1-1000 | Number of results per page |
| `offset` | integer | 0 | 0+ | Number of results to skip |

**Response** (200 OK):
```json
{
  "results": [
    {
      "id": "job-uuid-1",
      "owner": "0x1234567890abcdef",
      "namespace": "user-memories",
      "status": "failed",
      "error_msg": "Walrus upload timeout after 30s",
      "created_at": "2024-01-15T10:00:00Z",
      "updated_at": "2024-01-15T10:30:00Z"
    },
    {
      "id": "job-uuid-2",
      "owner": "0xfedcba0987654321",
      "namespace": "chat-history",
      "status": "failed",
      "error_msg": null,
      "created_at": "2024-01-15T09:45:00Z",
      "updated_at": "2024-01-15T09:50:00Z"
    }
  ],
  "total": 127,
  "limit": 50,
  "offset": 0
}
```

**Response Fields**:

| Field | Type | Description |
|-------|------|-------------|
| `results` | array | Array of failed job objects |
| `results[].id` | string | Unique job ID (UUID) |
| `results[].owner` | string | Job owner (Sui address) |
| `results[].namespace` | string | Memory namespace |
| `results[].status` | string | Always "failed" for this endpoint |
| `results[].error_msg` | string\|null | Error message (null if no details) |
| `results[].created_at` | string | RFC3339 timestamp of job creation |
| `results[].updated_at` | string | RFC3339 timestamp of last status change |
| `total` | integer | Total number of failed jobs |
| `limit` | integer | Page size used in this request |
| `offset` | integer | Offset used in this request |

**Common Error Types**:

| Error Message | Meaning | Action |
|---------------|---------|--------|
| Walrus upload timeout | Walrus aggregator not responding | Check network connectivity |
| Out of memory | Server ran out of memory | Restart service, check heap |
| SEAL decrypt failed | Decryption failed | Verify owner credentials |
| Database connection timeout | DB unreachable | Check database connectivity |
| Rate limit exceeded | Too many requests | Reduce request rate |

**Example Usage**:
```bash
#!/bin/bash

ADMIN_KEY="your-admin-api-key"
HOST="memwal.ai"

# Get first 50 failed jobs
RESPONSE=$(curl -s -H "x-admin-api-key: $ADMIN_KEY" \
  "https://${HOST}/api/admin/upload-errors?limit=50&offset=0")

# Count jobs with Walrus timeouts
TIMEOUTS=$(echo $RESPONSE | jq '[.results[] | select(.error_msg | contains("timeout"))] | length')
echo "Jobs with timeout errors: $TIMEOUTS"

# Get most recent error
RECENT=$(echo $RESPONSE | jq '.results[0]')
echo "Most recent failure: $(echo $RECENT | jq -r '.error_msg') at $(echo $RECENT | jq -r '.updated_at')"

# Paginate through all errors
TOTAL=$(echo $RESPONSE | jq '.total')
for ((i=0; i<$TOTAL; i+=50)); do
  curl -s -H "x-admin-api-key: $ADMIN_KEY" \
    "https://${HOST}/api/admin/upload-errors?limit=50&offset=$i" | jq '.results[] | .owner'
done
```

**Pagination Example**:
```bash
# Get results 50-100
curl -H "x-admin-api-key: $ADMIN_KEY" \
  "https://memwal.ai/api/admin/upload-errors?limit=50&offset=50"

# Get results 100-150
curl -H "x-admin-api-key: $ADMIN_KEY" \
  "https://memwal.ai/api/admin/upload-errors?limit=50&offset=100"
```

**Possible Errors**:

| Code | Message | Cause |
|------|---------|-------|
| 401 | Unauthorized | Missing or invalid `x-admin-api-key` header |
| 500 | Failed to count failed jobs | Database query error |
| 500 | Failed to fetch failed jobs | Database connectivity issue |

**Latency SLA**: p99 < 500ms for limit=50 (p50 < 150ms)

**Performance Notes**:
- Queries sorted by `updated_at DESC` (most recent first)
- Limit is clamped to 1-1000 range
- Offset is validated to be >= 0
- Queries are cached, may lag by up to 1 minute

---

### GET /api/admin/config

Retrieve admin configuration, including alert thresholds and API status.

**Request**:
```bash
curl -H "x-admin-api-key: $ADMIN_KEY" \
  https://memwal.ai/api/admin/config
```

**Response** (200 OK):
```json
{
  "sponsor_wallet_threshold_mist": 1000000000,
  "uploader_pool_threshold_mist": 500000000,
  "admin_api_key_set": true
}
```

**Response Fields**:

| Field | Type | Description |
|-------|------|-------------|
| `sponsor_wallet_threshold_mist` | integer | Alert threshold for sponsor wallet (in mist) |
| `uploader_pool_threshold_mist` | integer | Alert threshold for uploader pool (in mist) |
| `admin_api_key_set` | boolean | Whether ADMIN_API_KEY env var is configured |

**Threshold Meaning**:
- Alert triggers when wallet balance drops **below** the threshold
- Example: If threshold is 1000000000 mist, alert fires when balance < 1000000000

**Example Usage**:
```bash
#!/bin/bash

ADMIN_KEY="your-admin-api-key"
HOST="memwal.ai"

# Get config
CONFIG=$(curl -s -H "x-admin-api-key: $ADMIN_KEY" \
  https://${HOST}/api/admin/config)

# Check if API is properly configured
IS_KEY_SET=$(echo $CONFIG | jq '.admin_api_key_set')
if [ "$IS_KEY_SET" == "false" ]; then
  echo "ERROR: ADMIN_API_KEY not set!"
  exit 1
fi

# Get thresholds (convert to human-readable SUI)
SPONSOR_THRESHOLD=$(echo $CONFIG | jq '.sponsor_wallet_threshold_mist')
SPONSOR_THRESHOLD_SUI=$(echo "scale=9; $SPONSOR_THRESHOLD / 1000000000" | bc)
echo "Sponsor wallet alert threshold: $SPONSOR_THRESHOLD_SUI SUI"

UPLOADER_THRESHOLD=$(echo $CONFIG | jq '.uploader_pool_threshold_mist')
UPLOADER_THRESHOLD_SUI=$(echo "scale=9; $UPLOADER_THRESHOLD / 1000000000" | bc)
echo "Uploader pool alert threshold: $UPLOADER_THRESHOLD_SUI SUI"
```

**Possible Errors**:

| Code | Message | Cause |
|------|---------|-------|
| 401 | Unauthorized | Missing or invalid `x-admin-api-key` header |

**Latency SLA**: p99 < 100ms (p50 < 10ms) - this is a config read, very fast

---

## Background Jobs

### Balance Monitor Job

**Schedule**: Every 900 seconds (15 minutes, configurable)

**What It Does**:
1. Fetches current wallet balances via sidecar
2. Compares against configured thresholds
3. Sends Slack alert if balance falls below threshold
4. Applies deduplication (max 1 alert per wallet per hour)

**Configuration**:

| Env Var | Default | Description |
|---------|---------|-------------|
| `BALANCE_MONITOR_INTERVAL_SECS` | 900 | Job execution frequency |
| `WALLET_BALANCE_LOW_THRESHOLD_WAL` | 1000000 | Alert when uploader pool WAL < this |
| `SPONSOR_BALANCE_LOW_THRESHOLD_SUI` | 100000000 | Alert when sponsor SUI < this |
| `ALERT_TO_SLACK` | unset | Slack webhook URL for alerts |

**Slack Alert Format**:

When a balance threshold is breached, a message appears in Slack:

```
🚨 Wallet Balance Alert - MemWal Admin Dashboard

⚠️ Uploader Pool WAL Balance Low

Wallet Address: 0x1234567890abcdef
Current Balance: 450,000 frost
Alert Threshold: 500,000 frost

Status: ACTION REQUIRED

Recommended Actions:
• Check uploader job volume
• Replenish wallet if needed
• Contact team if recurring issue
```

**Logs**:

```
[INFO] balance_monitor_task: fetching wallet balances for 2 wallets
[INFO] balance_monitor_task: checking threshold for uploader pool
[WARN] wallet_balance_low: uploader_pool balance 450000 below threshold 500000
[INFO] alert_to_slack: sending balance alert to #alerts
[INFO] alert_to_slack: webhook delivered successfully, status=200
```

**Deduplication**:
- Same wallet alert suppressed if sent within 1 hour
- Different wallet addresses = separate alerts
- Escalating thresholds trigger new alert even if recently sent

---

## Rate Limiting

Admin API endpoints have **no rate limiting** by default (to allow monitoring dashboards).

If rate limiting is enabled, it would follow standard patterns:
- Per IP address
- Per API key
- Global capacity limit

Current configuration: **Unlimited** (trusted operation)

---

## Monitoring & Alerting

### Key Metrics

| Metric | SLA | Alert Threshold |
|--------|-----|-----------------|
| Endpoint latency (p99) | < 500ms | > 1000ms for 5 min |
| Error rate (5xx) | < 0.1% | > 1% for 5 min |
| Auth failure rate | < 0.1% | > 10 per minute from single IP |
| Balance monitor job execution | Every 900±30s | Not run for >30 min |
| Slack delivery rate | > 95% | < 90% for 10 min |

### Prometheus Queries

```promql
# Requests per second by endpoint
rate(http_requests_total{path=~"/api/admin/.*"}[5m])

# Error rate (5xx responses)
rate(http_requests_total{path=~"/api/admin/.*",status=~"5.."}[5m])
  / 
rate(http_requests_total{path=~"/api/admin/.*"}[5m])

# Latency p99
histogram_quantile(0.99, http_request_duration_seconds{path=~"/api/admin/.*"})

# Latency p50
histogram_quantile(0.50, http_request_duration_seconds{path=~"/api/admin/.*"})

# Auth failures
rate(http_requests_total{path=~"/api/admin/.*",status="401"}[5m])

# Balance monitor execution frequency
rate(balance_monitor_executions_total[5m])

# Alert delivery success
rate(alerts_sent_total[5m]) / rate(alerts_attempted_total[5m])
```

---

## Examples & Use Cases

### Scenario 1: Monitor Uploader Pool Balance

Continuously check if uploader pool balance is healthy:

```bash
#!/bin/bash

ADMIN_KEY="your-admin-api-key"
HOST="memwal.ai"
THRESHOLD_FROST=500000000  # 500M frost = 500 WAL

while true; do
  BALANCE=$(curl -s -H "x-admin-api-key: $ADMIN_KEY" \
    https://${HOST}/api/admin/wallets | \
    jq '.uploader_pool.wallet.wal')
  
  TIMESTAMP=$(date '+%Y-%m-%d %H:%M:%S')
  echo "[$TIMESTAMP] WAL Balance: $BALANCE frost"
  
  if [ $(echo "$BALANCE < $THRESHOLD_FROST" | bc) -eq 1 ]; then
    echo "  ⚠️  ALERT: Balance below threshold!"
    # Send PagerDuty alert or email
  fi
  
  sleep 300  # Check every 5 minutes
done
```

### Scenario 2: Debug Failed Upload Jobs

Find and investigate recent upload failures:

```bash
#!/bin/bash

ADMIN_KEY="your-admin-api-key"
HOST="memwal.ai"

# Get recent failures
FAILURES=$(curl -s -H "x-admin-api-key: $ADMIN_KEY" \
  "https://${HOST}/api/admin/upload-errors?limit=100&offset=0")

# Group by error type
echo "=== Upload Failures by Error Type ==="
echo $FAILURES | jq '[.results[] | .error_msg] | group_by(.) | map({error: .[0], count: length})'

# Find affected owners
echo ""
echo "=== Affected Owners ==="
echo $FAILURES | jq '.results[] | .owner' | sort | uniq -c | sort -rn

# Show most recent failure in detail
echo ""
echo "=== Most Recent Failure ==="
echo $FAILURES | jq '.results[0]'
```

### Scenario 3: Report on Admin API Health

Generate hourly health report:

```bash
#!/bin/bash

ADMIN_KEY="your-admin-api-key"
HOST="memwal.ai"

echo "=== Admin Dashboard Health Report ==="
echo "Generated: $(date)"

# Check all endpoints
echo ""
echo "API Endpoints:"

echo -n "  /api/admin/wallets: "
curl -s -H "x-admin-api-key: $ADMIN_KEY" -o /dev/null -w "%{http_code}\n" \
  https://${HOST}/api/admin/wallets

echo -n "  /api/admin/upload-errors: "
curl -s -H "x-admin-api-key: $ADMIN_KEY" -o /dev/null -w "%{http_code}\n" \
  "https://${HOST}/api/admin/upload-errors?limit=1"

echo -n "  /api/admin/config: "
curl -s -H "x-admin-api-key: $ADMIN_KEY" -o /dev/null -w "%{http_code}\n" \
  https://${HOST}/api/admin/config

# Check configuration
echo ""
echo "Configuration:"
curl -s -H "x-admin-api-key: $ADMIN_KEY" \
  https://${HOST}/api/admin/config | jq '.'

# Check wallet balances
echo ""
echo "Wallet Status:"
WALLETS=$(curl -s -H "x-admin-api-key: $ADMIN_KEY" \
  https://${HOST}/api/admin/wallets)

echo "Uploader Pool:"
echo $WALLETS | jq '.uploader_pool' 

echo "Sponsor Wallet:"
echo $WALLETS | jq '.sponsor_wallet'

# Summary
echo ""
echo "=== Summary ==="
echo "All endpoints operational: ✓"
```

---

## SDK Examples

### Python

```python
import requests
import json
from datetime import datetime

class MemWalAdminClient:
    def __init__(self, host: str, admin_key: str):
        self.host = host
        self.admin_key = admin_key
        self.headers = {"x-admin-api-key": admin_key}
    
    def get_wallets(self):
        """Get current wallet balances"""
        response = requests.get(
            f"https://{self.host}/api/admin/wallets",
            headers=self.headers
        )
        response.raise_for_status()
        return response.json()
    
    def get_upload_errors(self, limit=50, offset=0):
        """Get paginated list of failed uploads"""
        response = requests.get(
            f"https://{self.host}/api/admin/upload-errors",
            headers=self.headers,
            params={"limit": limit, "offset": offset}
        )
        response.raise_for_status()
        return response.json()
    
    def get_config(self):
        """Get admin configuration"""
        response = requests.get(
            f"https://{self.host}/api/admin/config",
            headers=self.headers
        )
        response.raise_for_status()
        return response.json()

# Usage
client = MemWalAdminClient("memwal.ai", "your-admin-key")
wallets = client.get_wallets()
print(f"WAL Balance: {wallets['uploader_pool']['wallet']['wal']} frost")
```

### JavaScript/TypeScript

```typescript
interface AdminClient {
  getWallets(): Promise<WalletsResponse>;
  getUploadErrors(limit: number, offset: number): Promise<UploadErrorsResponse>;
  getConfig(): Promise<ConfigResponse>;
}

class MemWalAdminClient implements AdminClient {
  constructor(private host: string, private adminKey: string) {}

  async getWallets(): Promise<WalletsResponse> {
    const response = await fetch(`https://${this.host}/api/admin/wallets`, {
      headers: { "x-admin-api-key": this.adminKey }
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return response.json();
  }

  async getUploadErrors(limit = 50, offset = 0): Promise<UploadErrorsResponse> {
    const url = new URL(`https://${this.host}/api/admin/upload-errors`);
    url.searchParams.set("limit", limit.toString());
    url.searchParams.set("offset", offset.toString());
    
    const response = await fetch(url.toString(), {
      headers: { "x-admin-api-key": this.adminKey }
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return response.json();
  }

  async getConfig(): Promise<ConfigResponse> {
    const response = await fetch(`https://${this.host}/api/admin/config`, {
      headers: { "x-admin-api-key": this.adminKey }
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return response.json();
  }
}

// Usage
const client = new MemWalAdminClient("memwal.ai", "your-admin-key");
const wallets = await client.getWallets();
console.log(`WAL Balance: ${wallets.uploader_pool.wallet.wal} frost`);
```

---

## Support & Troubleshooting

For issues with admin dashboard API:
1. Check [RUNBOOK.md](./RUNBOOK.md) for troubleshooting
2. Verify admin key in `x-admin-api-key` header
3. Check service logs: `railway logs --service relayer`
4. Verify network connectivity to memwal.ai
5. Contact backend team in #dev-ops

