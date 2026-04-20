#!/usr/bin/env bash
# Poll OpenRouter credit usage every 5 min and emit one line per check.
# Run alongside a benchmark to track cost consumption in real time.
#
# Usage: ./watch_cost.sh

set -u

KEY="${OPENROUTER_API_KEY:-}"

if [ -z "$KEY" ]; then
    echo "error: set OPENROUTER_API_KEY in your environment before running" >&2
    exit 1
fi

# Record starting usage
start_data=$(curl -sf -H "Authorization: Bearer $KEY" https://openrouter.ai/api/v1/credits || true)
start_usage=$(echo "$start_data" | python3 -c "import sys,json;print(json.load(sys.stdin)['data']['total_usage'])" 2>/dev/null || echo "0")
start_total=$(echo "$start_data" | python3 -c "import sys,json;print(json.load(sys.stdin)['data']['total_credits'])" 2>/dev/null || echo "0")

echo "$(date -u +%H:%M:%S) start usage=\$${start_usage} limit=\$${start_total}"

while true; do
  data=$(curl -sf -H "Authorization: Bearer $KEY" https://openrouter.ai/api/v1/credits || true)
  if [ -z "$data" ]; then
    echo "$(date -u +%H:%M:%S) ERROR: openrouter unreachable"
  else
    usage=$(echo "$data" | python3 -c "import sys,json;print(json.load(sys.stdin)['data']['total_usage'])" 2>/dev/null || echo "0")
    delta=$(python3 -c "print(f'{float($usage) - float($start_usage):.4f}')" 2>/dev/null || echo "?")
    remaining=$(python3 -c "print(f'{float($start_total) - float($usage):.2f}')" 2>/dev/null || echo "?")
    echo "$(date -u +%H:%M:%S) usage=\$${usage} spent_this_run=\$${delta} remaining=\$${remaining}"
  fi
  sleep 60
done
