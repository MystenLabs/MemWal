#!/usr/bin/env bash
# Refill agent_id / package_id on pre-migration vector_entries rows (WALM-364).
#
# Safe for large mainnet sets (100k+ rows):
#   - pages unsynced (owner, blob_id) from Postgres
#   - asks the sidecar for THAT page only (blobIds), not the whole owner
#   - stamps metadata_synced_at only on blob_ids requested in this page
#   - never marks the rest of an owner "done"
#   - HTTP / parse failures skip the page and leave rows NULL to retry
#
# Usage:
#   DATABASE_URL=postgres://... \
#   SIDECAR_URL=http://127.0.0.1:9000 \
#   SIDECAR_SECRET=... \
#     bash services/server/scripts/backfill-read-api-metadata.sh
#
# Optional: PAGE=100 SLEEP_SEC=0.25
# Requires: psql, python3, curl.

set -euo pipefail
exec python3 - "$@" <<'PY'
import json, os, subprocess, sys, time, urllib.error, urllib.request

db = os.environ.get("DATABASE_URL")
sidecar = (os.environ.get("SIDECAR_URL") or "").rstrip("/")
secret = os.environ.get("SIDECAR_SECRET") or ""
if not db or not sidecar:
    sys.exit("set DATABASE_URL and SIDECAR_URL")

page = int(os.environ.get("PAGE") or "100")
sleep_sec = float(os.environ.get("SLEEP_SEC") or "0.25")
page = max(1, min(page, 200))

def psql(sql: str) -> str:
    r = subprocess.run(
        ["psql", db, "-v", "ON_ERROR_STOP=1", "-At", "-c", sql],
        check=True,
        capture_output=True,
        text=True,
    )
    return r.stdout

def lit(value):
    if value is None or value == "":
        return "NULL"
    return "'" + str(value).replace("'", "''") + "'"

def fetch_blobs(owner, blob_ids):
    body = json.dumps({"owner": owner, "blobIds": blob_ids}).encode()
    headers = {"content-type": "application/json"}
    if secret:
        headers["authorization"] = f"Bearer {secret}"
    req = urllib.request.Request(
        f"{sidecar}/walrus/query-blobs",
        data=body,
        headers=headers,
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=120) as resp:
            raw = resp.read().decode()
            status = resp.status
    except urllib.error.HTTPError as e:
        raise RuntimeError(f"sidecar HTTP {e.code}: {e.read()[:300]!r}") from e
    except urllib.error.URLError as e:
        raise RuntimeError(f"sidecar transport: {e}") from e
    if status < 200 or status >= 300:
        raise RuntimeError(f"sidecar HTTP {status}: {raw[:300]!r}")
    try:
        data = json.loads(raw)
    except json.JSONDecodeError as e:
        raise RuntimeError(f"sidecar non-json: {raw[:300]!r}") from e
    if not isinstance(data, dict) or "blobs" not in data:
        raise RuntimeError(f"sidecar missing blobs: {raw[:300]!r}")
    if data.get("sourceCapped") is True:
        raise RuntimeError("sidecar sourceCapped=true; not stamping this page")
    by_id = {}
    for blob in data.get("blobs") or []:
        blob_id = blob.get("blobId") or blob.get("blob_id")
        if not blob_id:
            continue
        by_id[blob_id] = (
            blob.get("agentId") or blob.get("agent_id") or None,
            blob.get("packageId") or blob.get("package_id") or None,
        )
    return by_id

updated = 0
pages = 0
errors = 0
last_owner = ""
last_blob = ""

while True:
    sql = (
        "SELECT owner, blob_id FROM vector_entries "
        "WHERE metadata_synced_at IS NULL "
        f"AND (owner, blob_id) > ({lit(last_owner)}, {lit(last_blob)}) "
        "ORDER BY owner, blob_id "
        f"LIMIT {page}"
    )
    # First page: no cursor.
    if pages == 0 and not last_owner:
        sql = (
            "SELECT owner, blob_id FROM vector_entries "
            "WHERE metadata_synced_at IS NULL "
            "ORDER BY owner, blob_id "
            f"LIMIT {page}"
        )
    rows = [ln.split("|", 1) for ln in psql(sql).splitlines() if ln]
    if not rows:
        break
    pages += 1
    by_owner = {}
    for owner, blob_id in rows:
        by_owner.setdefault(owner, []).append(blob_id)
    last_owner, last_blob = rows[-1]

    for owner, blob_ids in by_owner.items():
        try:
            found = fetch_blobs(owner, blob_ids)
        except Exception as e:
            errors += 1
            print(f"SKIP owner={owner} n={len(blob_ids)} err={e}", file=sys.stderr)
            continue
        stmts = ["BEGIN;"]
        for blob_id in blob_ids:
            agent, package = found.get(blob_id, (None, None))
            stmts.append(
                "UPDATE vector_entries SET "
                f"agent_id = COALESCE(agent_id, {lit(agent)}), "
                f"package_id = COALESCE(package_id, {lit(package)}), "
                "metadata_synced_at = NOW() "
                f"WHERE owner = {lit(owner)} AND blob_id = {lit(blob_id)} "
                "AND metadata_synced_at IS NULL;"
            )
        stmts.append("COMMIT;")
        psql("\n".join(stmts))
        updated += len(blob_ids)
        print(
            f"page={pages} owner={owner} requested={len(blob_ids)} "
            f"sidecar_hits={len(found)} total_stamped={updated}"
        )
        time.sleep(sleep_sec)

print(f"done pages={pages} stamped={updated} skipped_pages={errors}")
sys.exit(1 if errors else 0)
PY
