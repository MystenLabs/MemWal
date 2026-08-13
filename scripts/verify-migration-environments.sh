#!/usr/bin/env bash
set -euo pipefail

repo="${GITHUB_REPOSITORY:-MystenLabs/MemWal}"
# Entries are typed to prevent a team slug from being confused with a user login.
# GitHub required reviewers are one-of, so this allowlist must match exactly.
expected_reviewers_csv="${EXPECTED_MIGRATION_REVIEWERS:-user:harrymove-ctrl}"
expected_reviewers_json="$(jq -cn --arg csv "$expected_reviewers_csv" '
  $csv | split(",") | map(gsub("^\\s+|\\s+$"; "")) |
  map(select(length > 0)) | sort | unique
')"
if [[ "$(jq 'length' <<<"$expected_reviewers_json")" -eq 0 ]]; then
  echo "::error::EXPECTED_MIGRATION_REVIEWERS must not be empty"
  exit 1
fi
environments=(
  walrus-memory-migration-governance-mainnet
  walrus-memory-migration-governance-testnet
  walrus-memory-migration-funding-mainnet
  walrus-memory-migration-funding-testnet
)

failed=0
for environment in "${environments[@]}"; do
  if ! json="$(gh api "repos/${repo}/environments/${environment}")"; then
    echo "::error::Missing or unreadable GitHub Environment: ${environment}"
    failed=1
    continue
  fi

  required_reviewers="$(jq '[.protection_rules[]? | select(.type == "required_reviewers")] | length' <<<"$json")"
  self_review="$(jq '[.protection_rules[]? | select(.type == "required_reviewers") | .prevent_self_review] | any' <<<"$json")"
  actual_reviewers_json="$(jq -c '
    [.protection_rules[]? | select(.type == "required_reviewers") |
      .reviewers[]?.reviewer |
      if .type == "Team" then "team:\(.slug)" else "user:\(.login)" end
    ] | sort | unique
  ' <<<"$json")"
  reviewers_exact="$(jq -n \
    --argjson actual "$actual_reviewers_json" \
    --argjson expected "$expected_reviewers_json" \
    '$actual == $expected')"
  admins_bypass="$(jq '.can_admins_bypass' <<<"$json")"

  if [[ "$required_reviewers" -ne 1 || "$self_review" != true || "$reviewers_exact" != true || "$admins_bypass" != false ]]; then
    echo "::error::${environment} is not fail-closed: required_reviewers=${required_reviewers}, prevent_self_review=${self_review}, reviewers=${actual_reviewers_json}, expected=${expected_reviewers_json}, can_admins_bypass=${admins_bypass}"
    failed=1
  else
    echo "verified ${environment}: reviewers=${expected_reviewers_json}, self-review blocked, admin bypass disabled"
  fi
done

exit "$failed"
