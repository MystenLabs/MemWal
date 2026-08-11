#!/usr/bin/env bash
set -euo pipefail

repo="${GITHUB_REPOSITORY:-MystenLabs/MemWal}"
expected_reviewer="${EXPECTED_MIGRATION_REVIEWER:-harrymove-ctrl}"
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
  reviewer_present="$(jq --arg login "$expected_reviewer" '[.protection_rules[]? | select(.type == "required_reviewers") | .reviewers[]?.reviewer.login] | any(. == $login)' <<<"$json")"
  admins_bypass="$(jq '.can_admins_bypass' <<<"$json")"

  if [[ "$required_reviewers" -lt 1 || "$self_review" != true || "$reviewer_present" != true || "$admins_bypass" != false ]]; then
    echo "::error::${environment} is not fail-closed: required_reviewers=${required_reviewers}, prevent_self_review=${self_review}, reviewer=${reviewer_present}, can_admins_bypass=${admins_bypass}"
    failed=1
  else
    echo "verified ${environment}: reviewer=${expected_reviewer}, self-review blocked, admin bypass disabled"
  fi
done

exit "$failed"
