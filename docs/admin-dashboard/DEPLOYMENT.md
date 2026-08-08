# Admin Dashboard Production Deployment Guide

This guide covers the complete production deployment lifecycle for the MemWal admin dashboard, including staging verification, production rollout, monitoring, and incident response procedures.

## Overview

The admin dashboard provides operational visibility into:
- **Wallet Balances**: Uploader pool (SUI + WAL) and sponsor wallet (SUI) balances
- **Upload Errors**: Failed memory upload jobs with detailed error tracking
- **Configuration**: Admin API status and balance alert thresholds
- **Background Jobs**: Automated balance monitoring and Slack alerting

All admin API endpoints require authentication via the `x-admin-api-key` header.

---

## Phase 1: Staging Deployment (dev.memwal.ai)

### Prerequisites
- Railway environment set up for staging with relayer + app services
- Staging database with current schema
- Slack workspace configured for staging alerts
- Access to Railway CLI and GitHub

### Deployment Steps

#### 1.1 Prepare Environment Variables

Before deploying, set these variables in the Railway staging environment:

```bash
# Admin API Authentication
ADMIN_API_KEY=<generate-strong-random-secret-64-chars>

# Balance Monitoring (background job)
BALANCE_MONITOR_INTERVAL_SECS=900              # 15 minutes
WALLET_BALANCE_LOW_THRESHOLD_WAL=1000000       # Lower than prod (more alerts for testing)
SPONSOR_BALANCE_LOW_THRESHOLD_SUI=50000000     # Lower than prod (more alerts for testing)

# Slack Alerting
ALERT_TO_SLACK=https://hooks.slack.com/services/staging-channel-webhook-url

# Database and Network (existing, verify correctness)
SUI_NETWORK=testnet
WALRUS_PUBLISHER_URL=https://publisher.walrus-testnet.walrus.space
WALRUS_AGGREGATOR_URL=https://aggregator.walrus-testnet.walrus.space
```

**Important**: Generate a unique `ADMIN_API_KEY` for staging (not the production key).

#### 1.2 Deploy Relayer Service

Deploy the relayer with the admin dashboard routes enabled:

```bash
cd services/server
railway up --service relayer
```

Watch the deployment logs:

```bash
railway logs --service relayer -f
```

Wait for the service to report ready state. Check the application logs:

```
[INFO  memwal_server] Server listening on 0.0.0.0:8000
[INFO  memwal_server] Admin API enabled
[INFO  memwal_server] Balance monitor started
```

#### 1.3 Verify Admin API Endpoint

Test the admin API with the staging key:

```bash
ADMIN_KEY="<your-staging-ADMIN_API_KEY>"
STAGING_HOST="dev.memwal.ai"

# Test 1: Get wallet balances
curl -s -H "x-admin-api-key: $ADMIN_KEY" \
  "https://${STAGING_HOST}/api/admin/wallets" | jq .

# Expected response:
# {
#   "uploader_pool": {
#     "wallet": {
#       "sui": "1000000000",
#       "wal": "500000000"
#     },
#     "last_updated": "2024-01-01T12:30:00Z"
#   },
#   "sponsor_wallet": {
#     "sui": "2000000000"
#   }
# }

# Test 2: Get upload errors (empty initially)
curl -s -H "x-admin-api-key: $ADMIN_KEY" \
  "https://${STAGING_HOST}/api/admin/upload-errors?limit=10&offset=0" | jq .

# Expected response:
# {
#   "results": [],
#   "total": 0,
#   "limit": 10,
#   "offset": 0
# }

# Test 3: Check admin config
curl -s -H "x-admin-api-key: $ADMIN_KEY" \
  "https://${STAGING_HOST}/api/admin/config" | jq .

# Expected response:
# {
#   "sponsor_wallet_threshold_mist": 1000000000,
#   "uploader_pool_threshold_mist": 500000000,
#   "admin_api_key_set": true
# }
```

#### 1.4 Verify Slack Alerting

Send a test alert to Slack:

```bash
# Option 1: Manually trigger via curl (if balance monitoring supports debug endpoint)
curl -s -X POST -H "x-admin-api-key: $ADMIN_KEY" \
  "https://${STAGING_HOST}/api/admin/test-alert" -d '{"type":"wallet_balance"}' | jq .

# Option 2: Wait for scheduled monitor (~15 min) and check Slack
# The background job runs every BALANCE_MONITOR_INTERVAL_SECS (900s = 15 min)

# Option 3: Check relayer logs for alert attempts
railway logs --service relayer -f | grep -i "slack\|alert"
```

When an alert fires, you should see in Slack:
```
Wallet Balance Alert
⚠️ Uploader Pool WAL Balance Low
Wallet: 0x1234...
Balance: 500,000 WAL frost
Threshold: 1,000,000 WAL frost
Status: ACTION REQUIRED
```

#### 1.5 Verify Deduplication

Send the same alert multiple times within a short window (without restarting the service):

```bash
# These should only alert once to Slack within the dedup window
curl -s -X POST -H "x-admin-api-key: $ADMIN_KEY" \
  "https://${STAGING_HOST}/api/admin/test-alert"
curl -s -X POST -H "x-admin-api-key: $ADMIN_KEY" \
  "https://${STAGING_HOST}/api/admin/test-alert"
```

Check Slack — you should see only ONE alert message, not duplicates.

#### 1.6 Verify Error Handling

Test the admin API error scenarios:

```bash
# Missing auth header (should return 401)
curl -i "https://${STAGING_HOST}/api/admin/wallets"
# Expected: HTTP/1.1 401 Unauthorized

# Invalid auth header (should return 401)
curl -i -H "x-admin-api-key: wrong-key" \
  "https://${STAGING_HOST}/api/admin/wallets"
# Expected: HTTP/1.1 401 Unauthorized

# Valid key but sidecar down (should return 500 with specific error)
# First, temporarily stop the sidecar, then:
curl -i -H "x-admin-api-key: $ADMIN_KEY" \
  "https://${STAGING_HOST}/api/admin/wallets"
# Expected: HTTP/1.1 500 with error body
```

### Staging Rollback Procedure

If staging deployment fails:

```bash
# Option 1: Revert to previous commit
git checkout main
cd services/server
railway up --service relayer

# Option 2: Redeploy from current branch with reset
railway down --service relayer
railway up --service relayer

# Option 3: Check deployment history
railway logs --service relayer -f --since 1h
```

---

## Phase 2: Production Deployment (memwal.ai)

### Prerequisites Checklist
- [ ] All staging verification tests passed
- [ ] Slack alerts tested and working in staging
- [ ] Deduplication verified in staging
- [ ] Error handling scenarios validated
- [ ] Load testing completed (see Load Testing section below)
- [ ] PR merged to `main` branch
- [ ] Database backups scheduled and verified
- [ ] On-call team notified
- [ ] Runbook reviewed by team

### Production Environment Variables

Set these in the Railway production environment **BEFORE** deploying:

```bash
# Admin API Authentication (DIFFERENT from staging)
# Generate a NEW strong random secret, 64+ characters
ADMIN_API_KEY=<generate-new-strong-random-secret-64-chars>

# Balance Monitoring (production-tuned)
BALANCE_MONITOR_INTERVAL_SECS=900              # 15 minutes (no change from staging)
WALLET_BALANCE_LOW_THRESHOLD_WAL=500000        # Production: more conservative (lower threshold)
SPONSOR_BALANCE_LOW_THRESHOLD_SUI=50000000     # Production: more conservative (lower threshold)

# Slack Alerting (production channel)
ALERT_TO_SLACK=https://hooks.slack.com/services/prod-channel-webhook-url

# Mainnet Configuration
SUI_NETWORK=mainnet
WALRUS_PUBLISHER_URL=https://publisher.walrus-mainnet.walrus.space
WALRUS_AGGREGATOR_URL=https://aggregator.walrus-mainnet.walrus.space

# Monitoring Tags (recommended)
DEPLOYMENT_ENVIRONMENT=production
DEPLOYMENT_REGION=us-east-1
DEPLOYMENT_VERSION=$(git rev-parse --short HEAD)
```

### Production Deployment Steps

#### 2.1 Pre-Deployment Verification

Before initiating deployment, verify production readiness:

```bash
# 1. Verify main branch is ready
git log --oneline -5

# 2. Verify all CI checks passed
gh pr list --state merged --limit 1
gh pr checks <PR_NUMBER>

# 3. Confirm database backup exists (check Railway backup service)
railway logs --service postgres --since 1h | grep -i backup

# 4. Verify staging was working 10 minutes ago
curl -H "x-admin-api-key: $STAGING_KEY" \
  "https://dev.memwal.ai/api/admin/config"
```

#### 2.2 Canary Deployment (Single Instance)

Deploy to a single production relayer instance first:

```bash
cd services/server

# Deploy only to the primary instance (if multiple instances exist)
railway up --service relayer-primary --env production

# Watch deployment logs carefully
railway logs --service relayer-primary -f
```

**Watch for these error patterns in logs:**

```
[ERROR] Failed to initialize admin dashboard        ← STOP, investigate
[ERROR] ADMIN_API_KEY validation failed            ← STOP, verify env vars
[ERROR] Sidecar health check failed                ← STOP, check sidecar
[INFO] Admin API initialized successfully          ← GOOD
[INFO] Balance monitor started                      ← GOOD
```

Wait **at least 5 minutes** after seeing "Admin API initialized" before proceeding.

#### 2.3 Canary Verification

Run verification tests against the canary instance:

```bash
ADMIN_KEY="<your-prod-ADMIN_API_KEY>"
PROD_HOST="memwal.ai"

# Test 1: Wallets endpoint (should succeed with real data)
curl -s -H "x-admin-api-key: $ADMIN_KEY" \
  "https://${PROD_HOST}/api/admin/wallets" | jq .

# Test 2: Error handling (should return auth error without key)
curl -i "https://${PROD_HOST}/api/admin/wallets" | grep -i "401"

# Test 3: Check config matches expected values
curl -s -H "x-admin-api-key: $ADMIN_KEY" \
  "https://${PROD_HOST}/api/admin/config" | jq .

# Test 4: Monitor service latency (p99 < 500ms)
for i in {1..100}; do 
  time curl -s -H "x-admin-api-key: $ADMIN_KEY" \
    "https://${PROD_HOST}/api/admin/wallets" > /dev/null
done | tail -10
```

If all tests pass, proceed to full rollout.

#### 2.4 Full Production Rollout

Deploy to all production instances:

```bash
cd services/server

# Deploy to all relayer replicas
railway up --service relayer

# Watch deployment progress
railway logs --service relayer -f
```

**Allow 2-3 minutes per instance** for graceful shutdown + startup.

#### 2.5 Post-Deployment Monitoring

After deployment completes, monitor these metrics for **at least 10 minutes**:

```bash
# 1. Error rate on admin routes (should be 0-0.1%)
curl -s "https://${PROD_HOST}/metrics" | grep "http_requests_total{path=\"/api/admin" | tail -5

# 2. Latency percentiles (p99 should be < 500ms)
curl -s "https://${PROD_HOST}/metrics" | grep "http_request_duration_seconds{.*admin" | grep "quantile"

# 3. Background job execution (should run every 15 min ±30s)
railway logs --service relayer -f | grep "balance_monitor_task" | head -20

# 4. Slack delivery failures (should be 0)
railway logs --service relayer -f | grep "alert.*failed\|slack.*error"
```

### Production Rollback Procedure

**Execute immediately if any of the following occur:**

- Admin API returns 500+ errors for >5 consecutive requests
- Wallet balance endpoint latency exceeds 2 seconds
- Slack alerts are spamming (>1 per minute)
- Sidecar connectivity issues detected
- Unauthorized access attempts detected (>10 per minute)

**Rollback steps:**

```bash
# 1. Identify the previous stable version
git log --oneline --grep="admin" | head -5

# 2. Revert to previous commit
git revert HEAD

# 3. Push and redeploy (or manually rollback on Railway)
cd services/server
railway up --service relayer

# 4. Verify rollback
curl -H "x-admin-api-key: $ADMIN_KEY" \
  "https://${PROD_HOST}/api/admin/config"

# 5. Post-incident: notify team and create incident report
```

---

## Admin Key Rotation

### Rotation Schedule
- **Frequency**: Monthly (recommended)
- **Notice**: 1 week advance warning to all dashboard consumers
- **Grace Period**: 24 hours overlap with old key (both keys valid)

### Rotation Procedure

#### Step 1: Generate New Key
```bash
# Generate a new 64-character random secret
openssl rand -hex 32 > /tmp/new_admin_key.txt
cat /tmp/new_admin_key.txt
```

#### Step 2: Update Production Secret
In Railway dashboard or via CLI:

```bash
# Set the new key (it becomes valid immediately alongside the old key)
railway variable set ADMIN_API_KEY="<new-64-char-key>"
```

#### Step 3: Redeploy Services
```bash
cd services/server
railway up --service relayer

# Watch the deployment
railway logs --service relayer -f
```

**Verification** (both keys should work):

```bash
OLD_KEY="<previous-ADMIN_API_KEY>"
NEW_KEY="<new-ADMIN_API_KEY>"

# Old key should still work
curl -H "x-admin-api-key: $OLD_KEY" \
  "https://memwal.ai/api/admin/config"

# New key should work immediately
curl -H "x-admin-api-key: $NEW_KEY" \
  "https://memwal.ai/api/admin/config"
```

#### Step 4: Notify Consumers
Send notification to all teams using the admin dashboard:

> Subject: Admin API Key Rotated - New Key Required
>
> The admin API key was rotated on [DATE].
> Your old key will continue to work for the next 24 hours.
> Please update to the new key immediately.
> Contact [on-call] if you have questions.

#### Step 5: Monitor for Issues
For 24 hours, watch for:
- Old key still being used (check logs for patterns)
- New key adoption by all consumers
- No authentication failures

```bash
# Check for auth failures in logs
railway logs --service relayer | grep -i "unauthorized\|auth.*failed" | wc -l
```

#### Step 6: Remove Old Key (After 24-hour grace period)
```bash
# Remove the old key from the history
# NOTE: This is typically done via Railway's variable deletion UI
# There is no automated way to delete a specific old version from logs
```

---

## Monitoring & Observability

### Key Metrics to Watch

#### 1. API Latency
```
Path: /api/admin/wallets, /api/admin/upload-errors, /api/admin/config
Alert if: p99 latency > 500ms for >5 minutes
Action: Check sidecar health, database query performance
```

#### 2. Error Rate
```
Path: /api/admin/*
Alert if: Error rate (5xx) > 1% for >5 minutes
Action: Check service logs, verify auth key setup
```

#### 3. Balance Monitor Job Execution
```
Metric: balance_monitor_task execution count
Alert if: No execution for >30 minutes
Action: Check job scheduler, verify BALANCE_MONITOR_INTERVAL_SECS
```

#### 4. Slack Delivery Rate
```
Metric: alerts_sent / alerts_attempted
Alert if: Delivery rate < 90%
Action: Verify webhook URL, check Slack API status
```

### Prometheus Dashboard Setup

Add these queries to your monitoring dashboard:

```promql
# Admin API Request Rate
rate(http_requests_total{path=~"/api/admin/.*"}[5m])

# Admin API Error Rate
rate(http_requests_total{path=~"/api/admin/.*",status=~"5.."}[5m])

# Admin API Latency (p99)
histogram_quantile(0.99, http_request_duration_seconds{path=~"/api/admin/.*"})

# Balance Monitor Execution Frequency
rate(balance_monitor_executions_total[5m])

# Alert Delivery Success Rate
rate(alerts_sent_total[5m]) / rate(alerts_attempted_total[5m])
```

### Alert Rules

Create these alert rules in your Prometheus/AlertManager:

```yaml
# Alert 1: High Latency on Admin Endpoints
- alert: HighLatencyAdminAPI
  expr: histogram_quantile(0.99, http_request_duration_seconds{path=~"/api/admin/.*"}) > 0.5
  for: 5m
  annotations:
    summary: "Admin API latency above 500ms"
    runbook: "docs/admin-dashboard/RUNBOOK.md#high-latency"

# Alert 2: High Error Rate on Admin Endpoints
- alert: HighErrorRateAdminAPI
  expr: rate(http_requests_total{path=~"/api/admin/.*",status=~"5.."}[5m]) > 0.01
  for: 5m
  annotations:
    summary: "Admin API error rate above 1%"
    runbook: "docs/admin-dashboard/RUNBOOK.md#high-error-rate"

# Alert 3: Balance Monitor Not Executing
- alert: BalanceMonitorNotExecuting
  expr: rate(balance_monitor_executions_total[30m]) == 0
  for: 30m
  annotations:
    summary: "Balance monitor has not executed in 30 minutes"
    runbook: "docs/admin-dashboard/RUNBOOK.md#no-job-execution"

# Alert 4: Slack Alerts Not Delivering
- alert: SlackAlertDeliveryFailure
  expr: rate(alerts_sent_total[5m]) / rate(alerts_attempted_total[5m]) < 0.9
  for: 10m
  annotations:
    summary: "Slack alert delivery rate below 90%"
    runbook: "docs/admin-dashboard/RUNBOOK.md#slack-delivery-failure"
```

### Logs to Watch

Monitor these log patterns in production:

```bash
# 1. Successful admin API calls (info level, every request)
[INFO] admin.wallets - duration=45ms status=200
[INFO] admin.upload_errors - duration=120ms status=200 limit=50 offset=0

# 2. Auth failures (warn level, suspicious)
[WARN] auth.verify_admin_key - unauthorized request from 192.168.1.1

# 3. Balance monitor execution (info level, every 15 min)
[INFO] balance_monitor_task - fetching wallet balances
[INFO] balance_monitor_task - WAL balance: 750000 frost

# 4. Wallet balance alerts (warn level, when threshold hit)
[WARN] wallet_balance_low - address=0x1234... balance=450000 threshold=500000

# 5. Slack delivery (info on success, error on failure)
[INFO] alert_to_slack - webhook delivered, status=200
[ERROR] alert_to_slack - webhook failed, status=429 (rate limited)
```

---

## Load Testing

### Test Setup

Before production deployment, run load tests against staging:

```bash
# Install load testing tool (vegeta)
brew install vegeta

# Create targets file (requests.txt)
cat > /tmp/admin_targets.txt << 'EOF'
GET https://dev.memwal.ai/api/admin/wallets
GET https://dev.memwal.ai/api/admin/upload-errors?limit=50
GET https://dev.memwal.ai/api/admin/config
EOF

# Add auth header (create vegeta attack with headers)
cat > /tmp/attack.txt << 'EOF'
GET https://dev.memwal.ai/api/admin/wallets
X-Admin-Api-Key: <staging-ADMIN_API_KEY>

GET https://dev.memwal.ai/api/admin/upload-errors
X-Admin-Api-Key: <staging-ADMIN_API_KEY>

GET https://dev.memwal.ai/api/admin/config
X-Admin-Api-Key: <staging-ADMIN_API_KEY>
EOF
```

### Load Test Scenarios

#### Scenario 1: Steady State (100 req/s)
```bash
vegeta attack -targets=/tmp/attack.txt -rate=100 -duration=60s | \
vegeta report -type=text
```

Expected results:
- Latency p50: <100ms
- Latency p99: <500ms
- Error rate: 0%

#### Scenario 2: Spike (500 req/s for 10s)
```bash
vegeta attack -targets=/tmp/attack.txt -rate=500 -duration=10s | \
vegeta report -type=text
```

Expected results:
- Latency p99: <1000ms
- Error rate: <1%
- No timeouts

#### Scenario 3: Sustained (200 req/s for 5min)
```bash
vegeta attack -targets=/tmp/attack.txt -rate=200 -duration=300s | \
vegeta report -type=text
```

Expected results:
- Latency p99: <500ms
- Error rate: 0%
- Consistent performance over time

### Pass/Fail Criteria

✅ **PASS**: Proceed to production if:
- All scenarios complete without timeout
- p99 latency stays under 500ms in steady state
- Error rate remains 0% under normal load
- No memory leaks (check RSS growth)

❌ **FAIL**: Do not proceed to production if:
- p99 latency exceeds 1 second
- Error rate exceeds 2% under any scenario
- Connection timeouts occur
- Memory grows unbounded

---

## Troubleshooting

See [RUNBOOK.md](./RUNBOOK.md) for detailed troubleshooting procedures and common issues.

---

## Appendix: Environment Variable Reference

| Variable | Staging | Production | Purpose |
|----------|---------|------------|---------|
| `ADMIN_API_KEY` | Unique to staging | Unique to prod | API authentication |
| `BALANCE_MONITOR_INTERVAL_SECS` | 900 | 900 | Background job frequency (15 min) |
| `WALLET_BALANCE_LOW_THRESHOLD_WAL` | 1,000,000 | 500,000 | Alert when uploader pool WAL falls below this |
| `SPONSOR_BALANCE_LOW_THRESHOLD_SUI` | 50,000,000 | 50,000,000 | Alert when sponsor SUI falls below this |
| `ALERT_TO_SLACK` | Staging webhook | Prod webhook | Slack incoming webhook URL |
| `SUI_NETWORK` | testnet | mainnet | Which Sui network to use |
| `WALRUS_PUBLISHER_URL` | testnet endpoint | mainnet endpoint | Walrus publisher endpoint |
| `WALRUS_AGGREGATOR_URL` | testnet endpoint | mainnet endpoint | Walrus aggregator endpoint |

---

## Support & Escalation

### For Issues During Deployment:
1. **Staging issues**: Post in #dev-ops Slack channel
2. **Production issues**: Page on-call via PagerDuty
3. **Questions**: File a GitHub issue in MystenLabs/MemWal

### On-Call Escalation Path:
1. On-call engineer (first response)
2. Backend team lead (for complex issues)
3. SRE team (for infrastructure issues)

### Contact
- **Team**: Backend Infrastructure (@backend-team)
- **Slack**: #dev-ops #production-incidents
- **GitHub Issues**: https://github.com/MystenLabs/MemWal/issues
