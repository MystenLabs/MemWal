#!/usr/bin/env bash
# Refill agent_id / package_id on pre-migration vector_entries rows (WALM-364).
#
# New writes already dual-write those columns. Rows created before migration
# 014 stay NULL forever unless this job runs. Batched, resumable, and never
# on the read hot path.
#
# For each owner that still has unsynced rows, POST /walrus/query-blobs on the
# sidecar (that payload already includes memwal_agent_id / memwal_package_id).
# Matching blob_id stamps the columns and metadata_synced_at. Blobs with no
# on-chain agent id stay NULL but still get metadata_synced_at so they are
# not retried.
#
# Usage:
#   DATABASE_URL=postgres://... \
#   SIDECAR_URL=http://127.0.0.1:3001 \
#   SIDECAR_SECRET=... \
#     bash services/server/scripts/backfill-read-api-metadata.sh
#
# Requires: psql, python3, curl.

set -euo pipefail

: "${DATABASE_URL:?set DATABASE_URL}"
: "${SIDECAR_URL:?set SIDECAR_URL}"
SIDECAR_SECRET="${SIDECAR_SECRET:-}"
BATCH="${BATCH:-50}"

owners="$(psql "$DATABASE_URL" -Atqc "
  SELECT DISTINCT owner
  FROM vector_entries
  WHERE metadata_synced_at IS NULL
  ORDER BY owner
  LIMIT ${BATCH};
")"

if [ -z "$owners" ]; then
  echo "nothing to backfill"
  exit 0
fi

auth_args=()
if [ -n "$SIDECAR_SECRET" ]; then
  auth_args=(-H "X-Sidecar-Secret: ${SIDECAR_SECRET}")
fi

sql_escape() {
  python3 -c 'import sys; print(sys.stdin.read().replace("'\''", "'\'\''"))' <<<"$1"
}

while IFS= read -r owner; do
  [ -z "$owner" ] && continue
  echo "owner ${owner}"
  payload="$(python3 -c 'import json,sys; print(json.dumps({"owner": sys.argv[1]}))' "$owner")"
  blobs_json="$(curl -sS "${SIDECAR_URL%/}/walrus/query-blobs" \
    -H "content-type: application/json" \
    "${auth_args[@]}" \
    -d "$payload")"

  python3 - "$DATABASE_URL" "$owner" "$blobs_json" <<'PY'
import json, subprocess, sys

db, owner, raw = sys.argv[1], sys.argv[2], sys.argv[3]

def lit(value):
    if value is None or value == "":
        return "NULL"
    return "'" + str(value).replace("'", "''") + "'"

try:
    data = json.loads(raw)
except json.JSONDecodeError:
    print("sidecar returned non-json, skipping", owner, file=sys.stderr)
    sys.exit(0)

blobs = data.get("blobs") or []
stmts = []
seen = 0
for blob in blobs:
    blob_id = blob.get("blobId") or blob.get("blob_id")
    if not blob_id:
        continue
    seen += 1
    agent = blob.get("agentId") or blob.get("agent_id")
    package = blob.get("packageId") or blob.get("package_id")
    stmts.append(
        "UPDATE vector_entries SET "
        f"agent_id = COALESCE(agent_id, {lit(agent)}), "
        f"package_id = COALESCE(package_id, {lit(package)}), "
        "metadata_synced_at = NOW() "
        f"WHERE owner = {lit(owner)} AND blob_id = {lit(blob_id)} "
        "AND metadata_synced_at IS NULL;"
    )
stmts.append(
    "UPDATE vector_entries SET metadata_synced_at = NOW() "
    f"WHERE owner = {lit(owner)} AND metadata_synced_at IS NULL;"
)
subprocess.check_call(["psql", db, "-v", "ON_ERROR_STOP=1", "-c", "\n".join(stmts)])
print(f"  applied {seen} on-chain blob rows")
PY
done <<< "$owners"
