# Admin Dashboard Documentation

Complete documentation for the MemWal admin dashboard, including deployment procedures, API reference, and troubleshooting guides.

## Quick Links

- **[Deployment Guide](./DEPLOYMENT.md)** - Production deployment procedures and staging verification
- **[API Reference](./API.md)** - Complete admin API endpoint documentation
- **[Troubleshooting Runbook](./RUNBOOK.md)** - Incident response and debugging procedures
- **[Environment Variables](../.env.production.example)** - Production configuration reference

## Overview

The admin dashboard provides operational visibility into MemWal's backend services:

| Feature | Endpoint | Purpose |
|---------|----------|---------|
| **Wallet Balances** | `GET /api/admin/wallets` | Monitor uploader pool and sponsor wallet balances |
| **Upload Errors** | `GET /api/admin/upload-errors` | View failed memory upload jobs with error details |
| **Configuration** | `GET /api/admin/config` | Check admin API status and alert thresholds |
| **Balance Alerts** | Background job | Automatic Slack alerts when balances fall below thresholds |

All endpoints require authentication via the `x-admin-api-key` header (one shared API key).

## Key Components

### 1. Wallets Endpoint
- **Refreshes every**: 15 minutes (background job)
- **Metrics**: SUI balance (mist) + WAL balance (frost)
- **Wallets**: Uploader pool, Sponsor wallet
- **Alert Thresholds**: Configurable for each wallet

### 2. Upload Errors Endpoint
- **Data Source**: Database `remember_jobs` table (failed jobs)
- **Sorting**: Most recent first (by updated_at)
- **Pagination**: limit (1-1000) + offset support
- **Error Types**: Walrus timeout, out of memory, decrypt failures, etc.

### 3. Background Balance Monitor
- **Frequency**: Every 900 seconds (15 min, configurable)
- **Alert Channel**: Slack webhook
- **Deduplication**: Max 1 alert per wallet per hour
- **Thresholds**: Separate for SUI (sponsor) and WAL (uploader pool)

### 4. Admin Configuration
- **Authentication**: `ADMIN_API_KEY` environment variable (64+ char secret)
- **Authorization**: Single shared key (not per-user)
- **Scope**: Dashboard operations only (read-only, no write access)

## Deployment Phases

### Phase 1: Staging (dev.memwal.ai)

1. Set staging environment variables in Railway
2. Deploy to staging relayer service
3. Verify all 3 endpoints respond with valid data
4. Test Slack alert delivery (trigger manually or lower thresholds)
5. Verify alert deduplication (same alert not sent twice)
6. Test error scenarios (no auth, invalid key, sidecar down)

**Duration**: ~30 minutes
**Rollback**: `git checkout main` + redeploy

### Phase 2: Production (memwal.ai)

1. Ensure all staging tests passed
2. Set production environment variables (DIFFERENT from staging)
3. Deploy canary to single instance, verify working
4. Full production rollout to all instances
5. Monitor error rates, latency, Slack delivery for 10+ minutes
6. Document any issues in post-incident review

**Duration**: ~15 minutes deployment + 10 min monitoring
**Rollback**: Revert commit and redeploy if errors detected

## Admin Key Rotation

**Schedule**: Monthly (recommended)  
**Grace Period**: 24 hours (old key still works)  
**No Downtime**: Service continues operating during rotation

See [DEPLOYMENT.md - Admin Key Rotation](./DEPLOYMENT.md#admin-key-rotation) for detailed steps.

## Monitoring & Observability

### Metrics to Watch

| Metric | SLA | Alert Threshold |
|--------|-----|-----------------|
| API latency (p99) | < 500ms | > 1000ms for 5 min |
| Error rate (5xx) | < 0.1% | > 1% for 5 min |
| Auth failures | < 10/min | > 10 from single IP in 1 min |
| Balance monitor execution | Every 900±30s | No execution for 30 min |
| Slack delivery rate | > 95% | < 90% for 10 min |

### Key Logs to Watch

```bash
# Balance monitor execution (every 15 min)
[INFO] balance_monitor_task: fetching wallet balances

# Balance alert triggered
[WARN] wallet_balance_low: uploader_pool balance 450000 below threshold 500000

# Successful Slack delivery
[INFO] alert_to_slack: webhook delivered successfully, status=200

# Auth failures (suspicious if frequent)
[WARN] auth.verify_admin_key: unauthorized request from 192.168.1.1
```

## Common Tasks

### Check Wallet Balances

```bash
ADMIN_KEY="your-production-key"
curl -H "x-admin-api-key: $ADMIN_KEY" https://memwal.ai/api/admin/wallets | jq .
```

### View Recent Upload Failures

```bash
ADMIN_KEY="your-production-key"
curl -H "x-admin-api-key: $ADMIN_KEY" \
  "https://memwal.ai/api/admin/upload-errors?limit=50&offset=0" | jq .
```

### Verify Admin API is Working

```bash
ADMIN_KEY="your-production-key"
curl -H "x-admin-api-key: $ADMIN_KEY" https://memwal.ai/api/admin/config | jq .
```

### Watch Service Logs

```bash
# Real-time logs
railway logs --service relayer -f

# Logs from last 30 minutes
railway logs --service relayer --since 30m

# Grep for errors
railway logs --service relayer | grep -i error
```

### Test Slack Webhook

```bash
WEBHOOK_URL="https://hooks.slack.com/services/..."
curl -X POST -H 'Content-type: application/json' \
  --data '{"text":"Test alert from MemWal admin"}' \
  "$WEBHOOK_URL"
```

## Troubleshooting

Quick reference for common issues:

| Problem | Solution | Details |
|---------|----------|---------|
| 401 Unauthorized on admin endpoints | Verify `x-admin-api-key` header and `ADMIN_API_KEY` env var | See [RUNBOOK.md](./RUNBOOK.md#issue-admin-api-returns-401-unauthorized) |
| 500 Internal Server Error | Check sidecar connectivity, database access | See [RUNBOOK.md](./RUNBOOK.md#issue-admin-api-returns-500-internal-server-error) |
| 503 Service Unavailable | Service may be deploying or unhealthy | See [RUNBOOK.md](./RUNBOOK.md#issue-admin-api-returns-503-service-unavailable) |
| High latency (> 500ms) | Check sidecar load, database performance | See [RUNBOOK.md](./RUNBOOK.md#issue-admin-api-latency-is-high--500ms) |
| Slack alerts not delivering | Verify webhook URL, check Slack integration | See [RUNBOOK.md](./RUNBOOK.md#issue-slack-alerts-not-being-delivered) |
| Balance monitor not running | Verify `BALANCE_MONITOR_INTERVAL_SECS` is set | See [RUNBOOK.md](./RUNBOOK.md#issue-balance-monitor-job-not-running) |

## Security Considerations

### Authentication
- **Type**: Bearer token (single shared secret)
- **Transport**: Must use HTTPS (not HTTP)
- **Storage**: Set in Railway environment variables (not in code)
- **Rotation**: Monthly (see deployment guide)

### Authorization
- **Scope**: All authorized users have same access (all endpoints, all data)
- **No per-user permissions**: Treat admin key like database password
- **Read-only**: Admin API provides visibility only, no write operations

### Secrets Management
- **Never commit `ADMIN_API_KEY` to git**
- **Never log the full key** (redact in logs)
- **Rotate immediately** if key is compromised
- **Use different keys** for staging vs production
- **Audit access** to production keys (who has it, when accessed)

### Network Security
- **HTTPS only** (enforced by Railway)
- **No CORS for browsers** (if not needed)
- **Rate limiting** can be added if needed
- **IP allowlisting** recommended (whitelist known dashboard IPs)

## Performance Characteristics

### Latency

| Endpoint | p50 | p99 | Max Recommended |
|----------|-----|-----|-----------------|
| `/api/admin/wallets` | 50-100ms | 200-500ms | < 1000ms |
| `/api/admin/upload-errors` | 150-300ms | 400-800ms | < 1000ms |
| `/api/admin/config` | 10-20ms | 50-100ms | < 500ms |

### Throughput

- **Wallets endpoint**: Can handle 100+ req/s (limited by sidecar)
- **Upload errors endpoint**: Can handle 50+ req/s (limited by database)
- **Config endpoint**: Can handle 1000+ req/s (very fast, config read)

### Resource Usage

- **Memory**: ~10-50MB for admin dashboard functionality
- **CPU**: Minimal (<5%) under normal load
- **Database connections**: 1-2 connections per instance
- **Network I/O**: <1 MB/min under normal monitoring

## Integration Examples

### Grafana Dashboard
Create a Grafana dashboard that polls the admin API every 5 minutes to display:
- Current wallet balances (gauge)
- Recent upload failures (table)
- Balance alert threshold status (alarm)

### Opsgenie/PagerDuty
Integrate Slack alerts with on-call rotations:
1. Slack webhook posts to #alerts channel
2. Slack notification triggers PagerDuty incident
3. On-call engineer is paged automatically

### Monitoring System
Scrape `/metrics` endpoint to track:
- HTTP request rate (by path)
- HTTP latency distribution (by path)
- Error rates (by status code)
- Background job execution (balance monitor)

## Deployment Checklist

Before going to production:

### Pre-Deployment
- [ ] Staging deployment tested and verified
- [ ] All team members trained on new dashboard
- [ ] Runbook reviewed and understood
- [ ] On-call team notified
- [ ] Database backups scheduled
- [ ] Rollback procedure documented
- [ ] Monitoring dashboards created
- [ ] Alert thresholds tuned

### Deployment
- [ ] Production env vars set correctly
- [ ] Canary deployment verified (single instance)
- [ ] Full deployment to all instances
- [ ] 10 minute post-deployment monitoring
- [ ] No errors in production logs

### Post-Deployment
- [ ] Verify admin API working from dashboard UI
- [ ] Check wallet balances are accurate
- [ ] Test Slack alerts manually (if supported)
- [ ] Monitor for 24 hours for stability
- [ ] Create post-incident review if any issues

## Support & Escalation

### For Deployment Issues
- **Slack**: #dev-ops
- **Escalate after**: 10 minutes if not resolved
- **To**: Backend team lead

### For Production Incidents
- **Page**: On-call engineer (via PagerDuty)
- **Escalate after**: 5 minutes if not resolved
- **To**: Backend lead + SRE team

### For Questions
- **GitHub**: File issue in MystenLabs/MemWal
- **Slack**: Ask in #backend-questions
- **Email**: backend-team@example.com

## Related Documentation

- **Server API**: See `services/server/README.md`
- **Database Schema**: See `services/server/migrations/`
- **Deployment**: See `DEPLOYMENT.md`
- **Architecture**: See `docs/architecture/`

## Version History

| Version | Date | Changes |
|---------|------|---------|
| 1.0.0 | 2024-01-15 | Initial admin dashboard release |
| 1.1.0 | 2024-02-01 | Add Slack alert deduplication |
| 1.2.0 | 2024-03-01 | Add balance monitor background job |

## Contributing

To update this documentation:

1. Edit the relevant `.md` file in `docs/admin-dashboard/`
2. Test procedures described in your environment
3. Submit PR with changes
4. Require review from backend team
5. Update version history above
6. Merge to main branch

## License

This documentation is part of the MemWal project. See LICENSE file for details.
