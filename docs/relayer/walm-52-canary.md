---
title: "WALM-52 Canary"
---

WALM-52 is a cost-reduction trial: run our own `walrus-upload-relay` with `tip_config: !no_tip` and measure whether it materially reduces SUI pool burn against the public Walrus team relay. This page is the operator runbook.

<Note>
Pool wallets fund only the relay tip. Gas for register/certify is sponsored by Enoki separately and is not in scope for this trial. Walrus storage / WAL is a third bucket and is also out of scope.
</Note>

## Prerequisites

- Self-hosted `walrus-upload-relay` reachable from at least one MemWal sidecar host (config: `tip_config: !no_tip`).
- Existing public-relay sidecar(s) continue running as the **control**.
- Prometheus scraping the sidecar `/metrics/walrus` endpoint (see [Observability](/relayer/observability#walm-52-upload-relay-tip-spend)).

## Canary env

On the canary sidecar instance only:

```bash
WALRUS_UPLOAD_RELAY_URL=http://<internal-relay-host>:<port>
WALRUS_UPLOAD_RELAY_SEND_TIP=false
# Optional: tighten the SDK-side max (defensive; should never trigger in no-tip mode)
# WALRUS_UPLOAD_RELAY_TIP_MAX_MIST=0
```

Restart the sidecar. The other (control) sidecars keep their existing `WALRUS_UPLOAD_RELAY_URL` and do not need `WALRUS_UPLOAD_RELAY_SEND_TIP` set — the default is `true`.

## Verify the canary is on the new path

Check the sidecar startup log for the `sidecar_ready` event — its `state` block now includes:

```json
{
  "uploadRelayHost": "<internal-relay-host>:<port>",
  "uploadRelaySendTip": false,
  "uploadRelayTipMaxMist": null
}
```

Confirm each upload is taking the no-tip path by tailing for the `register_sponsor` line:

```bash
journalctl -u memwal-sidecar -f | grep register_sponsor
```

The canary should emit `"sendTip":false,"tipRecipient":null`. The control should emit `"sendTip":true,"tipRecipient":"0x765a6ff2...086256"` on mainnet (`sidecar-server.ts` `shortAddress()` truncates the full mainnet tip-recipient `0x765a6ff2c13b47e2603416d0b5a156df498a5c51bc8085be3838e43e06086256`; testnet is `0x4b6a7439...dc52b6`). These are the current values — the Walrus team can rotate them, so confirm with `curl <relay>/v1/tip-config | jq .send_tip.address` before treating any specific prefix as canonical.

After a successful upload, the canary's `ok` log line carries `"registerTipMist":"0"`; the control's should carry a small non-zero value like `"registerTipMist":"4500000"`.

## Success criteria

Run the canary for **24-48h** before flipping the remaining instances. Compare canary vs control on:

| Signal | Canary expectation | PromQL |
| --- | --- | --- |
| Tip burn rate | drops to **0 SUI/hr** | `rate(walrus_upload_relay_tip_mist_total{send_tip="false"}[1h])` |
| Upload success rate | matches control within noise | `rate(walrus_upload_relay_uploads_total[1h])` by `host` vs sidecar error logs |
| Upload p50 / p95 latency | no material regression vs control | existing `memwal_external_request_duration_seconds{service="sidecar",operation="walrus_upload"}` |
| Self-hosted relay CPU / bandwidth | within operating budget | infra-side metrics on the relay box |

Flip the remaining instances only if **all four** hold.

## Validate the metric against on-chain truth

Before trusting the Prometheus counter for the funding decision, cross-check it against the audit script for the same window. **Always fetch the tip recipient from the live relay** — it is per-relay config, not a static constant, and the Walrus team can rotate it without warning:

```bash
# 1. Fetch the live tip recipient for the network you're auditing.
TIP_ADDR=$(curl -s https://upload-relay.mainnet.walrus.space/v1/tip-config | jq -r '.send_tip.address')
# (testnet equivalent: https://upload-relay.testnet.walrus.space/v1/tip-config)

# 2. Run the audit.
npx tsx services/server/scripts/walrus-tip-audit.ts \
  --pool-address 0x<pool-wallet-1> --pool-address 0x<pool-wallet-2> \
  --relay-tip-address "$TIP_ADDR" \
  --from <ISO> --to <ISO>
```

Current known values (as of this writing — verify with the `curl` above):

| Network | Relay tip address |
| --- | --- |
| mainnet | `0x765a6ff2c13b47e2603416d0b5a156df498a5c51bc8085be3838e43e06086256` |
| testnet | `0x4b6a7439159cf10533147fc3d678cf10b714f2bc998f6cb1f1b0b9594cdc52b6` |

Sum the `relay_tip_sui` column across pool wallets — it should match what Grafana reports for the same window (within rounding from RPC pagination boundaries).

The audit script is the figure to hand to Daniel for the funding ask; Prometheus is for ongoing monitoring.

## Rollback

Per-instance:

```bash
unset WALRUS_UPLOAD_RELAY_URL          # falls back to public mainnet/testnet defaults
unset WALRUS_UPLOAD_RELAY_SEND_TIP     # falls back to true
```

Restart the sidecar. Within one restart cycle the instance is back on the public relay path and paying tips again. No code change or redeploy is required for rollback.

## Stakeholder map

- **Trial owner**: Henry Nguyen (WALM-52).
- **Engineering**: Harry Phan.
- **Funding decision**: Daniel Lam — waiting on the trial outcome before approving (or declining) the next SUI top-up of the pool wallets.
