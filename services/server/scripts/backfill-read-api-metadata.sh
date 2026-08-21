#!/usr/bin/env bash
# Refill agent_id / package_id on pre-migration vector_entries rows (WALM-364).
#
# Mainnet-sized (100k+ rows): one sidecar listing per owner, not per page of
# blob ids. Passing blobIds still makes the sidecar walk every owned Blob
# object, so paging by blob_id would re-scan the owner on every page.
#
# Stamping rules:
#   - HTTP / parse / sourceCapped: stamp nothing for that owner, retry later
#   - 200 with a complete listing: UPDATE matching blob_ids, then stamp the
#     owner's leftover unsynced rows (looked, not on chain)
#   - never stamps a different owner
#
# Usage:
#   DATABASE_URL=postgres://... \
#   SIDECAR_URL=http://127.0.0.1:9000 \
#   SIDECAR_SECRET=... \
#     bash services/server/scripts/backfill-read-api-metadata.sh
#
# Optional: OWNER_BATCH=10 SLEEP_SEC=1 TIMEOUT_SEC=3600
# Requires: psql, python3.

set -euo pipefail
exec python3 - "$@" <<'PY'
import json, os, subprocess, sys, time, urllib.error, urllib.request

db = os.environ.get("DATABASE_URL")
sidecar = (os.environ.get("SIDECAR_URL") or "").rstrip("/")
secret = os.environ.get("SIDECAR_SECRET") or ""
if not db or not sidecar:
    sys.exit("set DATABASE_URL and SIDECAR_URL")

owner_batch = max(1, int(os.environ.get("OWNER_BATCH") or "10"))
sleep_sec = float(os.environ.get("SLEEP_SEC") or "1")
timeout_sec = int(os.environ.get("TIMEOUT_SEC") or "3600")

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

def fetch_blobs(owner):
    body = json.dumps({"owner": owner}).encode()
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
        with urllib.request.urlopen(req, timeout=timeout_sec) as resp:
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
        raise RuntimeError(f"sidecar missing blobs key: {raw[:300]!r}")
    if data.get("sourceCapped") is True:
        raise RuntimeError("sourceCapped=true; listing incomplete, not stamping leftovers")
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

def apply_owner(owner, found):
    items = list(found.items())
    for i in range(0, len(items), 200):
        chunk = items[i:i+200]
        stmts = ["BEGIN;"]
        for blob_id, (agent, package) in chunk:
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
        print(f"  applied {min(i+200, len(items))}/{len(items)} sidecar blobs", flush=True)
    # Complete listing only: leftover unsynced rows were looked up and are
    # not on chain (or have no memwal_* keys).
    psql(
        "UPDATE vector_entries SET metadata_synced_at = NOW() "
        f"WHERE owner = {lit(owner)} AND metadata_synced_at IS NULL;"
    )

stamped_owners = 0
errors = 0
last_owner = ""

while True:
    sql = (
        "SELECT DISTINCT owner FROM vector_entries "
        "WHERE metadata_synced_at IS NULL "
        + (f"AND owner > {lit(last_owner)} " if last_owner else "")
        + "ORDER BY owner "
        + f"LIMIT {owner_batch}"
    )
    owners = [ln for ln in psql(sql).splitlines() if ln]
    if not owners:
        break
    last_owner = owners[-1]
    for owner in owners:
        leftover = psql(
            "SELECT COUNT(*) FROM vector_entries "
            f"WHERE owner = {lit(owner)} AND metadata_synced_at IS NULL"
        ).strip()
        print(f"owner={owner} unsynced={leftover}", flush=True)
        try:
            found = fetch_blobs(owner)
            apply_owner(owner, found)
            stamped_owners += 1
            print(f"  sidecar_blobs={len(found)} ok", flush=True)
        except Exception as e:
            errors += 1
            print(f"  SKIP {e}", file=sys.stderr, flush=True)
        time.sleep(sleep_sec)

print(f"done owners={stamped_owners} skipped={errors}")
sys.exit(1 if errors else 0)
PY
