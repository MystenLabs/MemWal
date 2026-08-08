# Admin Dashboard Troubleshooting Runbook

Quick reference for diagnosing and resolving admin dashboard issues in production.

---

## Issue: Admin API Returns 401 Unauthorized

### Symptoms
```bash
curl -H "x-admin-api-key: my-key" https://memwal.ai/api/admin/wallets
# Returns: HTTP 401 Unauthorized
```

### Root Causes

| Cause | Check | Fix |
|-------|-------|-----|
| **Invalid API Key** | Verify key matches production `ADMIN_API_KEY` | Set correct key in Railway env vars |
| **Missing Header** | Confirm request includes `x-admin-api-key` header | Add header: `-H "x-admin-api-key: $KEY"` |
| **Case Sensitivity** | Header name must be lowercase `x-admin-api-key` | Correct to lowercase (not `X-Admin-Api-Key`) |
| **Env Var Not Set** | Check if `ADMIN_API_KEY` is set at all | Run: `railway variable list | grep ADMIN_API_KEY` |
| **Service Not Redeployed** | Change to env var not picked up | Redeploy: `railway up --service relayer` |

### Diagnosis Steps

```bash
# Step 1: Verify key is set in Railway
railway variable get ADMIN_API_KEY
# Should return: ****** (redacted) if set

# Step 2: Test with hardcoded correct key
PROD_KEY=$(railway variable get ADMIN_API_KEY)
curl -H "x-admin-api-key: $PROD_KEY" https://memwal.ai/api/admin/config

# Step 3: Check request headers in logs
railway logs --service relayer | grep "verify_admin_key" | tail -5

# Step 4: Verify service has restarted with new env var
railway logs --service relayer | grep -i "loading config\|initialization" | tail -3
```

### Resolution

```bash
# If env var is missing:
railway variable set ADMIN_API_KEY="<generate-new-64-char-secret>"
railway up --service relayer

# If env var is set but requests still fail:
# Option 1: Restart service
railway restart --service relayer

# Option 2: Check if key contains special characters that need escaping
# Re-generate without special characters
openssl rand -hex 32  # Generates safe alphanumeric key
```

---

## Issue: Admin API Returns 500 Internal Server Error

### Symptoms
```bash
curl -H "x-admin-api-key: $KEY" https://memwal.ai/api/admin/wallets
# Returns: HTTP 500 Internal Server Error
```

### Root Causes

| Cause | Indicator | Fix |
|-------|-----------|-----|
| **Sidecar Down** | Logs show "sidecar connection refused" | Check sidecar service health, restart if needed |
| **Database Connection Failed** | Logs show "database connection timeout" | Verify database is accessible, check connection pool |
| **Wallet Query Timeout** | Logs show "timeout fetching wallet metrics" | Increase sidecar timeout, check network latency |
| **Out of Memory** | Logs show "allocation failed" or RSS spike | Restart service, check for memory leaks |
| **Missing Configuration** | Logs show missing env var (e.g., WALRUS_PUBLISHER_URL) | Verify all required env vars are set |

### Diagnosis Steps

```bash
# Step 1: Check relayer service logs for errors
railway logs --service relayer -f | grep -i "error\|failed\|panic"

# Step 2: Check sidecar connectivity
railway logs --service relayer | grep -i "sidecar\|wallet.*metrics"

# Step 3: Verify database connectivity
railway logs --service relayer | grep -i "database\|connection.*pool"

# Step 4: Check if service is responding at all
curl -i https://memwal.ai/health
# Should return 200 OK (this endpoint is public, no auth required)

# Step 5: Review system resources
railway run --service relayer -- ps aux | grep relayer
railway logs --service relayer | tail -50  # Last 50 lines of logs
```

### Resolution

```bash
# Step 1: Restart the relayer service
railway restart --service relayer

# Step 2: Wait for service to stabilize
sleep 10

# Step 3: Test again
curl -H "x-admin-api-key: $KEY" https://memwal.ai/api/admin/config

# Step 4: If still failing, check specific service dependencies

# Check sidecar is running:
curl https://memwal.ai/health  # If health endpoint is available

# Check database connectivity:
railway logs --service postgres | tail -10  # Check database is healthy

# Check logs for specific error messages:
railway logs --service relayer --since 5m | grep ERROR
```

---

## Issue: Admin API Returns 503 Service Unavailable

### Symptoms
```bash
curl -H "x-admin-api-key: $KEY" https://memwal.ai/api/admin/wallets
# Returns: HTTP 503 Service Unavailable
```

### Root Causes

| Cause | Indicator | Fix |
|-------|-----------|-----|
| **Sidecar Health Check Failing** | Logs show "sidecar watchdog triggered" | Check sidecar service, verify health endpoint |
| **Load Balancer Draining Connections** | Deployment in progress | Wait for deployment to complete |
| **Service Shutting Down** | Logs show "graceful shutdown" | Normal during redeployment, wait a few seconds |
| **All Replicas Unhealthy** | Logs from all instances show errors | Rollback to previous version immediately |

### Diagnosis Steps

```bash
# Step 1: Check if deployment is in progress
railway status

# Step 2: Check all replicas
railway logs --service relayer --replica "*" | tail -20

# Step 3: Verify sidecar is healthy
curl https://memwal.ai/health
# If this also returns 503, sidecar/infrastructure is down

# Step 4: Check recent deployments
railway logs --since 10m | grep -i "deploy\|starting\|shutdown"
```

### Resolution

```bash
# If deployment is in progress:
# Wait 2-3 minutes for deployment to complete and service to become healthy
railway status  # Check status
sleep 30
curl -H "x-admin-api-key: $KEY" https://memwal.ai/api/admin/config

# If service is stuck unhealthy after 5 minutes:
# Perform rollback
git log --oneline | head -5
git revert HEAD
cd services/server
railway up --service relayer
```

---

## Issue: Admin API Latency is High (> 500ms)

### Symptoms
```bash
time curl -H "x-admin-api-key: $KEY" https://memwal.ai/api/admin/wallets
# Returns in 1500ms instead of 50ms
```

### Root Causes

| Cause | Indicator | Fix |
|-------|-----------|-----|
| **Sidecar Slow Response** | Logs show wallet query takes 1000ms+ | Check sidecar load, check network latency to sidecar |
| **Database Query Slow** | Logs show database query takes 500ms+ | Check database indexes, run EXPLAIN ANALYZE |
| **Network Latency Spike** | DNS latency or packet loss detected | Check network route, verify Walrus endpoints responsive |
| **High CPU Usage** | Service CPU at 90%+ | Scale up container, check for expensive queries |
| **Connection Pool Exhaustion** | Logs show "unable to get connection" | Increase connection pool size or reduce load |

### Diagnosis Steps

```bash
# Step 1: Measure actual latency
for i in {1..10}; do 
  time curl -s -H "x-admin-api-key: $KEY" \
    https://memwal.ai/api/admin/wallets > /dev/null
done

# Step 2: Check service metrics
curl -s https://memwal.ai/metrics | grep "http_request_duration_seconds" | grep admin

# Step 3: Check database performance
# If you have query logging enabled:
railway logs --service postgres | grep "duration:" | tail -5

# Step 4: Check sidecar response time
# Look for wallet query timing in logs:
railway logs --service relayer | grep "wallet.*duration\|wallet.*ms" | tail -10

# Step 5: Check CPU and memory usage
railway run --service relayer -- top -b -n 1 | head -20
```

### Resolution

```bash
# Option 1: Scale up the relayer service (if CPU/memory bound)
railway scale --service relayer --cpu 2000 --memory 1024

# Option 2: Increase connection pool size
railway variable set SQLX_MAX_CONNECTIONS=20
railway up --service relayer

# Option 3: Optimize database queries
# Add indexes if needed:
# CREATE INDEX idx_remember_jobs_status ON remember_jobs(status);
# CREATE INDEX idx_remember_jobs_updated ON remember_jobs(updated_at DESC);

# Option 4: Monitor for stuck connections
railway logs --service relayer | grep "pool\|connection" | tail -20

# Option 5: If latency is from external Walrus calls:
# Check network latency to Walrus endpoints
curl -w "@curl-format.txt" -o /dev/null -s https://aggregator.walrus-mainnet.walrus.space/health
```

---

## Issue: Slack Alerts Not Being Delivered

### Symptoms
- Balance monitor executes (logs show "fetching wallet balances")
- No Slack messages appear in #alerts channel
- No errors in logs about Slack

### Root Causes

| Cause | Indicator | Fix |
|-------|-----------|-----|
| **Webhook URL Invalid** | Logs show "webhook request failed" with 404/401 | Verify webhook URL in `ALERT_TO_SLACK` env var |
| **Webhook Expired** | Logs show 410 Gone | Regenerate webhook in Slack integration settings |
| **Rate Limited** | Logs show 429 Too Many Requests | Reduce alert frequency or create separate webhook |
| **Alert Not Reaching Threshold** | Wallet balance is above threshold | Lower threshold or add test funds |
| **Deduplication Active** | Alert was recently sent | Wait for dedup window to expire (usually 1 hour) |

### Diagnosis Steps

```bash
# Step 1: Verify webhook URL is set
railway variable get ALERT_TO_SLACK
# Should return something like: https://hooks.slack.com/services/...

# Step 2: Test webhook directly
WEBHOOK_URL=$(railway variable get ALERT_TO_SLACK)
curl -X POST -H 'Content-type: application/json' \
  --data '{"text":"Test from MemWal admin dashboard"}' \
  "$WEBHOOK_URL"

# Step 3: Check if balance is below threshold
curl -H "x-admin-api-key: $KEY" https://memwal.ai/api/admin/config | jq .

# Step 4: Manually trigger alert (if supported)
# Or wait for next scheduled run (every 15 minutes)

# Step 5: Check logs for alert attempts
railway logs --service relayer | grep -i "alert\|slack" | tail -20
```

### Resolution

```bash
# If webhook URL is wrong:
railway variable set ALERT_TO_SLACK="https://hooks.slack.com/services/YOUR/CORRECT/URL"
railway up --service relayer

# If webhook is expired, regenerate in Slack:
# 1. Go to #alerts channel settings → Integrations → Incoming Webhooks
# 2. Click your webhook → Regenerate webhook URL
# 3. Copy new URL
# 4. Update ALERT_TO_SLACK env var
railway variable set ALERT_TO_SLACK="<new-webhook-url>"
railway up --service relayer

# If being rate limited:
# Option 1: Increase time between alerts
railway variable set BALANCE_MONITOR_INTERVAL_SECS=1800  # 30 minutes instead of 15
railway up --service relayer

# Option 2: Create separate webhook for alerts channel
# Follow steps in Slack integration setup

# To test Slack delivery in production:
# 1. Temporarily lower thresholds
railway variable set WALLET_BALANCE_LOW_THRESHOLD_WAL=9999999999  # Very high
railway up --service relayer

# 2. Wait for next scheduled run (watch logs)
railway logs --service relayer -f | grep -i "balance_monitor\|slack"

# 3. Check Slack for alert
# 4. Restore original thresholds
railway variable set WALLET_BALANCE_LOW_THRESHOLD_WAL=500000
railway up --service relayer
```

---

## Issue: Balance Monitor Job Not Running

### Symptoms
- No "balance_monitor_task" logs appearing every 15 minutes
- Wallet balance never updates
- No alerts ever trigger (even if balance is low)

### Root Causes

| Cause | Indicator | Fix |
|-------|-----------|-----|
| **Background Job Disabled** | No logs for balance_monitor_task | Check if job is explicitly disabled in code |
| **Interval Too Long** | Runs but very infrequently | Check BALANCE_MONITOR_INTERVAL_SECS setting |
| **Job Crashed** | Logs show panic or error in balance_monitor | Fix the error, restart service |
| **Service Doesn't Have Time** | Service restarted frequently | Ensure service is stable for >interval duration |
| **Interval Not Set** | Uses default but maybe unintended | Explicitly set BALANCE_MONITOR_INTERVAL_SECS |

### Diagnosis Steps

```bash
# Step 1: Check if balance monitor is running
railway logs --service relayer | grep -i "balance_monitor" | tail -20

# Step 2: Check interval setting
railway variable get BALANCE_MONITOR_INTERVAL_SECS

# Step 3: Verify service uptime (should be >15 min)
railway logs --service relayer | grep -i "initialized\|startup" | tail -1

# Step 4: Check for crashes or restarts
railway logs --service relayer --since 30m | grep -i "panic\|crash\|exit"

# Step 5: Manually check wallet balances endpoint
curl -H "x-admin-api-key: $KEY" https://memwal.ai/api/admin/wallets | jq .
```

### Resolution

```bash
# Step 1: Ensure interval is set and reasonable
railway variable set BALANCE_MONITOR_INTERVAL_SECS=900  # 15 minutes
railway up --service relayer

# Step 2: Wait for next run (up to 15 min) and check logs
railway logs --service relayer -f | grep "balance_monitor"

# If still not running after 20 minutes:

# Step 3: Restart service
railway restart --service relayer

# Step 4: Check again
railway logs --service relayer -f | grep -i "balance_monitor" | head -5

# If there's a panic in balance_monitor task:
# Step 5: Check error message in logs
railway logs --service relayer | grep -i "balance_monitor.*error\|balance_monitor.*panic" | tail -5

# Step 6: Fix the underlying issue (usually related to sidecar connectivity)
# and redeploy
cd services/server
cargo test  # Run tests locally
railway up --service relayer
```

---

## Issue: Wallet Balance Data is Stale

### Symptoms
- `/api/admin/wallets` returns data with `last_updated` timestamp from hours ago
- Balance numbers haven't changed

### Root Causes

| Cause | Indicator | Fix |
|-------|-----------|-----|
| **Sidecar Caching** | Sidecar returns cached wallet data | Wait for cache expiry or restart sidecar |
| **Balance Monitor Not Running** | No updates in the update timestamp | See "Balance Monitor Job Not Running" section |
| **Network Issue to Walrus** | Logs show timeouts fetching balances | Check network connectivity to Walrus |
| **Wallet Transaction Pending** | Blockchain hasn't confirmed transaction yet | Wait for confirmation (1-2 minutes on Sui) |

### Diagnosis Steps

```bash
# Step 1: Check last update timestamp
curl -s -H "x-admin-api-key: $KEY" https://memwal.ai/api/admin/wallets | \
  jq '.uploader_pool.last_updated'

# Step 2: Calculate how old the data is
LAST_UPDATE=$(curl -s -H "x-admin-api-key: $KEY" \
  https://memwal.ai/api/admin/wallets | jq -r '.uploader_pool.last_updated')
NOW=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
echo "Last updated: $LAST_UPDATE, Current time: $NOW"

# Step 3: Check if balance monitor is running regularly
railway logs --service relayer | grep "balance_monitor" | tail -5

# Step 4: Check for network timeouts
railway logs --service relayer | grep -i "timeout.*wallet\|wallet.*timeout"
```

### Resolution

```bash
# Option 1: Force a balance update by triggering balance monitor
# (if manual trigger endpoint exists)
curl -X POST -H "x-admin-api-key: $KEY" \
  https://memwal.ai/api/admin/refresh-wallets

# Option 2: Restart the relayer to clear any stuck state
railway restart --service relayer

# Wait a few seconds, then check again
sleep 5
curl -H "x-admin-api-key: $KEY" https://memwal.ai/api/admin/wallets | \
  jq '.uploader_pool.last_updated'

# Option 3: If data is consistently stale, check balance monitor logs
railway logs --service relayer -f | grep "balance_monitor"
# Look for errors like "timeout", "refused", "sidecar"

# Option 4: Verify sidecar is healthy
curl -s https://memwal.ai/health | jq .  # Check if /health is accessible
```

---

## Issue: Database Query Errors in Admin API

### Symptoms
```bash
curl -H "x-admin-api-key: $KEY" https://memwal.ai/api/admin/upload-errors
# Returns: HTTP 500 - Failed to fetch failed jobs
```

### Root Causes

| Cause | Indicator | Fix |
|-------|-----------|-----|
| **Table Doesn't Exist** | Logs show "relation 'remember_jobs' does not exist" | Run database migrations |
| **Column Missing** | Logs show "column 'error_msg' does not exist" | Apply latest migration |
| **Connection Pool Exhausted** | Logs show "unable to acquire connection" | Increase pool size or reduce load |
| **Query Timeout** | Logs show "query timeout after 30s" | Increase timeout or optimize indexes |
| **Large Result Set** | Fetching 10,000 rows causes memory spike | Reduce default limit or paginate better |

### Diagnosis Steps

```bash
# Step 1: Check if migrations have run
railway run --service postgres -- \
  psql -U memwal -d memwal -c "\dt remember_jobs"
# Should show remember_jobs table

# Step 2: Check what columns exist
railway run --service postgres -- \
  psql -U memwal -d memwal -c "\d remember_jobs"

# Step 3: Check database connection pool status
railway logs --service relayer | grep -i "pool\|connection" | tail -10

# Step 4: Run the failing query directly
railway run --service postgres -- \
  psql -U memwal -d memwal -c \
  "SELECT COUNT(*) FROM remember_jobs WHERE status = 'failed';"
```

### Resolution

```bash
# If migrations haven't run:
cd services/server
sqlx migrate run --database-url postgresql://...
railway up --service relayer

# If table schema changed:
# Check migrations/ directory for the latest migration
ls -la services/server/migrations/ | tail -5

# If it hasn't been applied, run:
sqlx migrate run

# Then restart service:
railway up --service relayer

# If connection pool is exhausted:
railway variable set SQLX_MAX_CONNECTIONS=30
railway up --service relayer

# If query is slow:
# Add indexes to remember_jobs table:
railway run --service postgres -- psql -U memwal -d memwal << EOF
CREATE INDEX IF NOT EXISTS idx_remember_jobs_status ON remember_jobs(status);
CREATE INDEX IF NOT EXISTS idx_remember_jobs_updated ON remember_jobs(updated_at DESC);
EOF
```

---

## Issue: Unauthorized Access Attempts Spike

### Symptoms
```bash
# Large number of 401 responses in logs
railway logs --service relayer | grep "401\|unauthorized" | wc -l
# Returns: 150+ in last 5 minutes
```

### Root Causes

| Cause | Indicator | Fix |
|-------|-----------|-----|
| **Key Leaked** | Unauthorized requests from external IPs | Rotate key immediately, investigate source |
| **Key Guessing Attack** | Many failed attempts with different keys | Implement rate limiting, alert on failures |
| **Test Suite Running** | Internal tests with wrong key | Verify test key, update and re-run |
| **Old Client Still Using Old Key** | Requests with old rotated key | Notify teams to update their keys |

### Diagnosis Steps

```bash
# Step 1: Count 401 errors in last 5 minutes
railway logs --service relayer --since 5m | grep "401\|unauthorized" | wc -l

# Step 2: Check source IPs of failed requests (if available)
railway logs --service relayer --since 5m | grep "unauthorized" | grep -oE '[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+'

# Step 3: Check if it's a known internal IP
# Compare against list of known testing IPs

# Step 4: Check if key was recently rotated
git log --all --grep="rotate\|key" --oneline | head -5

# Step 5: Alert threshold
# If >50 unauthorized in 5 min, this is suspicious
```

### Resolution

```bash
# IMMEDIATE: Rotate the admin key
NEW_KEY=$(openssl rand -hex 32)
echo "New key: $NEW_KEY"
railway variable set ADMIN_API_KEY="$NEW_KEY"
railway up --service relayer

# INVESTIGATION: Identify the source
# Check logs for patterns
railway logs --service relayer --since 30m | grep "unauthorized" | head -20

# Determine if it's:
# - Random guessing (many different User-Agents)
# - Specific attacker (repeated from same IP)
# - Internal test suite (known IPs, known patterns)

# If specific attacker:
# 1. Block the IP at WAF/load balancer level
# 2. Enable additional logging
# 3. File security incident

# If internal test suite:
# 1. Notify team of key rotation
# 2. Wait for them to update
# 3. Monitor for proper key usage
# 4. Disable old key after grace period

# PREVENTION: Implement alerting
# In your monitoring system, add:
# - Alert if >50 unauthorized in 5 minutes
# - Alert if >10 unauthorized from single IP in 1 minute
# - Alert if key validation failures spike
```

---

## Quick Reference: Command Cheat Sheet

```bash
# Check service status
railway status

# View recent logs (streaming)
railway logs --service relayer -f

# View logs from specific time
railway logs --service relayer --since 30m

# Get all environment variables
railway variable list

# Set/update environment variable
railway variable set KEY=value

# Get specific variable
railway variable get ADMIN_API_KEY

# Restart service
railway restart --service relayer

# Redeploy service
railway up --service relayer

# Rollback to previous deployment
git revert HEAD
cd services/server
railway up --service relayer

# Test admin API
ADMIN_KEY="<key>"
curl -H "x-admin-api-key: $ADMIN_KEY" https://memwal.ai/api/admin/wallets

# Load test admin API
for i in {1..100}; do
  curl -s -H "x-admin-api-key: $ADMIN_KEY" \
    https://memwal.ai/api/admin/wallets > /dev/null
done

# Monitor error rate
railway logs --service relayer | grep -c "ERROR"

# Check service resource usage
railway run --service relayer -- ps aux | grep relayer

# Execute database query
railway run --service postgres -- psql -U memwal -d memwal \
  -c "SELECT COUNT(*) FROM remember_jobs WHERE status = 'failed';"
```

---

## Escalation Matrix

| Issue | Severity | First Contact | Escalate After | Escalation To |
|-------|----------|---------------|-----------------|---------------|
| High latency (>1s) | Medium | On-call engineer | 10 min | Backend lead |
| Service 500 errors | High | Page on-call | 5 min | Backend lead + SRE |
| All replicas down | Critical | Page on-call + team | Immediate | VP Engineering |
| Unauthorized access spike | Critical | Page security | Immediate | Security team |
| Database connection failed | High | On-call engineer | 5 min | DBA + SRE |
| Slack alerts not sending | Low | Post in Slack | 30 min | On-call engineer |
| API slow (p99 > 500ms) | Medium | File ticket | 20 min | Performance engineer |

---

## Recovery Checklist

After resolving a production incident:

- [ ] Root cause identified and documented
- [ ] Fix deployed and verified working
- [ ] Monitoring alerts checked and working
- [ ] Logs reviewed for similar issues
- [ ] Team notified via Slack
- [ ] Post-incident review scheduled (for severity High/Critical)
- [ ] Update this runbook if new patterns discovered
- [ ] Monitor for 1 hour to ensure stability

---

## Additional Resources

- **Deployment Guide**: [DEPLOYMENT.md](./DEPLOYMENT.md)
- **API Documentation**: See `/api/admin/*` routes in server code
- **Source Code**: `services/server/src/routes/admin_dashboard.rs`
- **Database Schema**: `services/server/migrations/`
- **Monitoring Dashboards**: Railway dashboard → Observability section
