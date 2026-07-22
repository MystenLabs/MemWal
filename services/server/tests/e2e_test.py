#!/usr/bin/env python3
"""
E2E test for memwal Server — Ed25519 auth + current API contract.

What this covers:
  1. GET /health is reachable without auth
  2. Unsigned requests to protected routes are rejected (401)
  3. Valid-format but wrong-key signatures are rejected (401)
  4. Expired timestamps are rejected (401)
  5. Opt-in: signed /api/remember + /api/recall happy path with a
     pre-registered delegate key (requires TEST_DELEGATE_KEY + real backend)

The happy-path flow needs a pre-registered on-chain MemWalAccount delegate
key, a real Walrus publisher, SEAL key servers, Sui RPC, and a funded
server wallet. This matches the existing pattern in
`test_rate_limit_redis.py` / `test_analyze_rate_limit.py`. CI runs the
contract + auth checks by default; setting TEST_DELEGATE_KEY (+ secrets)
upgrades the run to include the happy path.

Env vars:
  TEST_BASE_URL        default "http://localhost:8000"
  TEST_DELEGATE_KEY    hex-encoded Ed25519 secret (32 bytes → 64 hex chars)
                       of a delegate key registered on-chain. If unset,
                       remember/recall is skipped.
  TEST_ACCOUNT_ID      Walrus Memory account object ID (0x... Sui address). Only
                       used informationally; auth middleware resolves the
                       account from the delegate key.

Exit status: 0 if all *executed* checks pass, 1 on any failure. Skipped
checks do not cause failure.
"""

from __future__ import annotations

import hashlib
import json
import os
import sys
import time
import urllib.error
import urllib.request
import uuid

from nacl.encoding import RawEncoder
from nacl.signing import SigningKey

BASE_URL = os.environ.get("TEST_BASE_URL", "http://localhost:8000").rstrip("/")


def _sign(
    signing_key: SigningKey,
    method: str,
    path: str,
    body_bytes: bytes,
    timestamp: str,
    nonce: str,
    account_id: str,
) -> str:
    """Return the hex-encoded Ed25519 signature over the canonical message.

    Server-side payload format (services/server/src/auth.rs):
        "{timestamp}.{method}.{path}.{body_hash}.{nonce}.{account_id}"

    Empty account_id is signed as the empty string when no x-account-id is sent.
    """
    body_hash = hashlib.sha256(body_bytes).hexdigest()
    message = f"{timestamp}.{method}.{path}.{body_hash}.{nonce}.{account_id}".encode()
    signed = signing_key.sign(message, encoder=RawEncoder)
    return signed.signature.hex()


def make_signed_request(
    method: str,
    path: str,
    body: dict | None,
    signing_key: SigningKey,
    account_id: str | None = None,
) -> dict:
    """Send a signed JSON request and return the decoded JSON response."""
    body_bytes = b"" if method == "GET" else json.dumps(body or {}).encode()
    timestamp = str(int(time.time()))
    nonce = str(uuid.uuid4())
    signature_hex = _sign(
        signing_key, method, path, body_bytes, timestamp, nonce, account_id or ""
    )
    public_key_hex = signing_key.verify_key.encode().hex()

    headers = {
        "Content-Type": "application/json",
        "x-public-key": public_key_hex,
        "x-signature": signature_hex,
        "x-timestamp": timestamp,
        "x-nonce": nonce,
    }
    if account_id:
        headers["x-account-id"] = account_id

    data = None if method == "GET" else body_bytes
    req = urllib.request.Request(f"{BASE_URL}{path}", data=data, headers=headers, method=method)
    with urllib.request.urlopen(req) as resp:
        return json.loads(resp.read())


def wait_for_remember_job(
    signing_key: SigningKey,
    account_id: str | None,
    job_id: str,
    timeout_s: int = 120,
) -> dict:
    deadline = time.time() + timeout_s
    while time.time() < deadline:
        status = make_signed_request(
            "GET", f"/api/remember/{job_id}", None, signing_key, account_id=account_id
        )
        if status.get("status") == "done":
            return status
        if status.get("status") == "failed":
            raise AssertionError(f"remember job failed: {status}")
        time.sleep(2)
    raise AssertionError(f"remember job timed out after {timeout_s}s: {job_id}")


def _load_delegate_key() -> SigningKey | None:
    """Load TEST_DELEGATE_KEY as a SigningKey, or return None if unset/invalid."""
    hex_key = os.environ.get("TEST_DELEGATE_KEY", "").strip()
    if not hex_key:
        return None
    try:
        raw = bytes.fromhex(hex_key)
    except ValueError:
        print(f"[warn] TEST_DELEGATE_KEY is not valid hex; skipping happy-path checks")
        return None
    if len(raw) != 32:
        print(f"[warn] TEST_DELEGATE_KEY must be 32 bytes (got {len(raw)}); skipping happy-path checks")
        return None
    return SigningKey(raw, encoder=RawEncoder)


def _load_delegate_key_2() -> tuple[SigningKey | None, str | None]:
    """Optional SECOND owner (TEST_DELEGATE_KEY_2 + TEST_ACCOUNT_ID_2) for the
    cross-owner isolation test. Returns (key, account_id) or (None, None)
    if not configured — the cross-owner test is then skipped (documented gap)."""
    hex_key = os.environ.get("TEST_DELEGATE_KEY_2", "").strip()
    if not hex_key:
        return None, None
    try:
        raw = bytes.fromhex(hex_key)
    except ValueError:
        print("[warn] TEST_DELEGATE_KEY_2 is not valid hex; skipping cross-owner check")
        return None, None
    if len(raw) != 32:
        print(f"[warn] TEST_DELEGATE_KEY_2 must be 32 bytes (got {len(raw)}); skipping cross-owner check")
        return None, None
    return SigningKey(raw, encoder=RawEncoder), (os.environ.get("TEST_ACCOUNT_ID_2") or None)


def test_health() -> None:
    req = urllib.request.Request(f"{BASE_URL}/health")
    with urllib.request.urlopen(req) as resp:
        data = json.loads(resp.read())
        assert data["status"] == "ok", f"Expected status=ok, got {data}"
        assert data["apiVersion"], f"Expected apiVersion in health metadata, got {data}"
        assert data["minSupportedSdk"]["typescript"], f"Expected SDK matrix in health, got {data}"
        print(f"[pass] GET /health → {data}")


def test_version() -> None:
    req = urllib.request.Request(f"{BASE_URL}/version")
    with urllib.request.urlopen(req) as resp:
        data = json.loads(resp.read())
        assert data["relayerVersion"], f"Expected relayerVersion, got {data}"
        assert data["apiVersion"], f"Expected apiVersion, got {data}"
        assert data["minSupportedSdk"]["python"], f"Expected SDK matrix, got {data}"
        assert data["featureFlags"]["runtime.versionEndpoint"] is True, (
            f"Expected runtime.versionEndpoint feature flag, got {data}"
        )
        print(f"[pass] GET /version → {data}")


def test_unsigned_rejected() -> None:
    body = json.dumps({"text": "hello", "namespace": "default"}).encode()
    req = urllib.request.Request(
        f"{BASE_URL}/api/remember",
        data=body,
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    try:
        urllib.request.urlopen(req)
    except urllib.error.HTTPError as e:
        assert e.code == 401, f"Expected 401, got {e.code}"
        print(f"[pass] unsigned POST /api/remember → {e.code}")
        return
    raise AssertionError("Expected 401, request succeeded")


def test_wrong_signature_rejected() -> None:
    key_a = SigningKey.generate()
    key_b = SigningKey.generate()

    body = {"text": "evil", "namespace": "default"}
    body_bytes = json.dumps(body).encode()
    timestamp = str(int(time.time()))
    nonce = str(uuid.uuid4())
    signature_hex = _sign(
        key_a, "POST", "/api/remember", body_bytes, timestamp, nonce, ""
    )

    req = urllib.request.Request(
        f"{BASE_URL}/api/remember",
        data=body_bytes,
        headers={
            "Content-Type": "application/json",
            "x-public-key": key_b.verify_key.encode().hex(),  # mismatched key
            "x-signature": signature_hex,
            "x-timestamp": timestamp,
            "x-nonce": nonce,
        },
        method="POST",
    )
    try:
        urllib.request.urlopen(req)
    except urllib.error.HTTPError as e:
        assert e.code == 401, f"Expected 401, got {e.code}"
        print(f"[pass] mismatched public-key POST /api/remember → {e.code}")
        return
    raise AssertionError("Expected 401, request succeeded")


def test_expired_timestamp_rejected() -> None:
    # Use a fresh random key — the request is expected to die at the
    # timestamp check, which runs BEFORE onchain delegate verification.
    signing_key = SigningKey.generate()
    body = {"text": "old", "namespace": "default"}
    body_bytes = json.dumps(body).encode()
    timestamp = str(int(time.time()) - 600)  # 10 min past
    nonce = str(uuid.uuid4())
    signature_hex = _sign(
        signing_key, "POST", "/api/remember", body_bytes, timestamp, nonce, ""
    )

    req = urllib.request.Request(
        f"{BASE_URL}/api/remember",
        data=body_bytes,
        headers={
            "Content-Type": "application/json",
            "x-public-key": signing_key.verify_key.encode().hex(),
            "x-signature": signature_hex,
            "x-timestamp": timestamp,
            "x-nonce": nonce,
        },
        method="POST",
    )
    try:
        urllib.request.urlopen(req)
    except urllib.error.HTTPError as e:
        assert e.code == 401, f"Expected 401, got {e.code}"
        print(f"[pass] expired-timestamp POST /api/remember → {e.code}")
        return
    raise AssertionError("Expected 401, request succeeded")


def test_remember_recall_happy_path(signing_key: SigningKey, account_id: str | None) -> None:
    """Signed /api/remember → /api/recall with a pre-registered delegate key.

    Requires real Walrus + SEAL + Sui + funded server wallet + delegate key
    registered on-chain in the Walrus Memory account identified by account_id.
    """
    remember_body = {
        "text": "The capital of France is Paris.",
        "namespace": "e2e-test",
    }
    result = make_signed_request(
        "POST", "/api/remember", remember_body, signing_key, account_id=account_id
    )
    assert "job_id" in result, f"Expected 'job_id' in remember response, got {result}"
    assert result["status"] in ("pending", "running"), f"Unexpected status: {result}"
    print(f"[pass] POST /api/remember → job_id={result['job_id']}, status={result['status']}")

    completed = wait_for_remember_job(signing_key, account_id, result["job_id"])
    assert completed["namespace"] == "e2e-test", f"Unexpected namespace: {completed}"
    assert "blob_id" in completed, f"Expected completed job blob_id, got {completed}"
    print(f"[pass] GET /api/remember/{result['job_id']} → blob_id={completed['blob_id']}")

    recall_body = {
        "query": "What is the capital of France?",
        "limit": 5,
        "namespace": "e2e-test",
    }
    recall_result = make_signed_request(
        "POST", "/api/recall", recall_body, signing_key, account_id=account_id
    )
    assert "results" in recall_result, f"Expected 'results' in recall response, got {recall_result}"
    assert recall_result["total"] >= 1, f"Expected ≥1 result, got {recall_result['total']}"
    top = recall_result["results"][0]
    for k in ("text", "blob_id", "distance"):
        assert k in top, f"Missing '{k}' in recall result: {top}"
    print(f"[pass] POST /api/recall → {recall_result['total']} hits, top distance={top['distance']:.4f}")


def test_clear_namespace_soft_delete(
    signing_key: SigningKey, account_id: str | None
) -> None:
    """remember → recall (present) → clearNamespace → recall (absent).

    Verifies the soft-delete contract end-to-end: a cleared namespace stops
    surfacing in recall, and an unrelated namespace is untouched (owner+ns
    scoping). Shares the Walrus/SEAL/Sui prerequisites with the happy path.
    """
    ns = "e2e-clear-test"
    sibling = "e2e-clear-keep"

    # 1. Remember one memory in each namespace.
    for namespace, text in ((ns, "The sky is blue."), (sibling, "Grass is green.")):
        r = make_signed_request(
            "POST", "/api/remember", {"text": text, "namespace": namespace},
            signing_key, account_id=account_id,
        )
        wait_for_remember_job(signing_key, account_id, r["job_id"])
    print(f"[pass] seeded memories in {ns} + {sibling}")

    # 2. Recall — the target memory is present.
    before = make_signed_request(
        "POST", "/api/recall",
        {"query": "What colour is the sky?", "limit": 5, "namespace": ns},
        signing_key, account_id=account_id,
    )
    assert before["total"] >= 1, f"Expected ≥1 hit before clear, got {before['total']}"
    print(f"[pass] recall before clear → {before['total']} hit(s)")

    # 3. clearNamespace (soft-delete).
    cleared = make_signed_request(
        "POST", "/api/clear-namespace", {"namespace": ns},
        signing_key, account_id=account_id,
    )
    assert cleared["cleared"] >= 1, f"Expected ≥1 cleared, got {cleared}"
    print(f"[pass] POST /api/clear-namespace → cleared={cleared['cleared']}")

    # 4. Recall again — the cleared namespace returns nothing.
    after = make_signed_request(
        "POST", "/api/recall",
        {"query": "What colour is the sky?", "limit": 5, "namespace": ns},
        signing_key, account_id=account_id,
    )
    assert after["total"] == 0, f"Expected 0 hits after clear, got {after['total']}"
    print(f"[pass] recall after clear → {after['total']} hits (soft-deleted)")

    # 5. Sibling namespace is untouched (owner+namespace scoping).
    keep = make_signed_request(
        "POST", "/api/recall",
        {"query": "What colour is grass?", "limit": 5, "namespace": sibling},
        signing_key, account_id=account_id,
    )
    assert keep["total"] >= 1, f"Sibling namespace wrongly cleared, got {keep['total']}"
    print(f"[pass] sibling namespace intact → {keep['total']} hit(s)")

    # 6. Re-clear is idempotent — already-cleared rows are skipped (0).
    again = make_signed_request(
        "POST", "/api/clear-namespace", {"namespace": ns},
        signing_key, account_id=account_id,
    )
    assert again["cleared"] == 0, f"Expected 0 on re-clear, got {again}"
    print(f"[pass] re-clear idempotent → cleared={again['cleared']}")


def test_list_and_forget_by_id(
    signing_key: SigningKey, account_id: str | None
) -> None:
    """list() exposes per-row ids; forget(id) is per-row.

    Stores two DISTINCT memories, lists to get their ids, forgets one, and
    asserts: the forgotten one is gone from recall + list, the other survives.
    Then verifies forget is owner/id-scoped (a bogus id → forgotten=0).
    Shares the Walrus/SEAL/Sui prerequisites with the happy path.
    """
    ns = "e2e-forget-test"

    # Seed two distinct memories.
    for text in ("Alice plays the violin.", "Bob coaches soccer."):
        r = make_signed_request(
            "POST", "/api/remember", {"text": text, "namespace": ns},
            signing_key, account_id=account_id,
        )
        wait_for_remember_job(signing_key, account_id, r["job_id"])
    print(f"[pass] seeded 2 memories in {ns}")

    # list() returns per-row ids (metadata only — no text field).
    listing = make_signed_request(
        "POST", "/api/list", {"namespace": ns, "limit": 50},
        signing_key, account_id=account_id,
    )
    assert listing["returned"] >= 2, f"Expected ≥2 listed, got {listing['returned']}"
    for m in listing["memories"]:
        assert "id" in m and m["id"], f"list item missing id: {m}"
        assert "text" not in m, f"list must be metadata-only, leaked text: {m}"
    target_id = listing["memories"][0]["id"]
    print(f"[pass] POST /api/list → {listing['returned']} items, ids present, no text")

    # forget one by id.
    forgot = make_signed_request(
        "POST", "/api/memories/forget", {"id": target_id},
        signing_key, account_id=account_id,
    )
    assert forgot["forgotten"] == 1, f"Expected forgotten=1, got {forgot}"
    print(f"[pass] POST /api/memories/forget id={target_id[:8]}… → forgotten=1")

    # The forgotten id no longer appears in list; the other remains.
    after = make_signed_request(
        "POST", "/api/list", {"namespace": ns, "limit": 50},
        signing_key, account_id=account_id,
    )
    remaining_ids = {m["id"] for m in after["memories"]}
    assert target_id not in remaining_ids, "Forgotten id still listed"
    assert after["returned"] == listing["returned"] - 1, (
        f"Expected one fewer after forget: {listing['returned']} → {after['returned']}"
    )
    print(f"[pass] list after forget → {after['returned']} (forgotten id absent)")

    # forget is id/owner-scoped: a bogus id is a no-op, not an error.
    noop = make_signed_request(
        "POST", "/api/memories/forget", {"id": "00000000-0000-0000-0000-000000000000"},
        signing_key, account_id=account_id,
    )
    assert noop["forgotten"] == 0, f"Expected forgotten=0 for bogus id, got {noop}"
    print(f"[pass] forget bogus id → forgotten=0 (no-op, scoped)")

    # Double-forget the SAME real id is idempotent — the second call hits the
    # already-tombstoned branch (deleted_at NOT NULL), distinct from not-found,
    # and must also return 0.
    redo = make_signed_request(
        "POST", "/api/memories/forget", {"id": target_id},
        signing_key, account_id=account_id,
    )
    assert redo["forgotten"] == 0, f"Expected forgotten=0 on re-forget, got {redo}"
    print(f"[pass] re-forget same id → forgotten=0 (idempotent)")


def test_list_pagination(signing_key: SigningKey, account_id: str | None) -> None:
    """list() cursor pagination enumerates every live memory once — no skips,
    no duplicates, stable across pages, has_more/next_cursor correct.

    Seeds N memories, pages through with limit < N using next_cursor, and
    asserts the union of pages == the full set with no repeats and the last
    page reports has_more=false.
    """
    ns = "e2e-paging-test"
    n = 7
    page = 3  # < n, so we get 3 + 3 + 1 across three pages

    for i in range(n):
        r = make_signed_request(
            "POST", "/api/remember", {"text": f"paging memory number {i}", "namespace": ns},
            signing_key, account_id=account_id,
        )
        wait_for_remember_job(signing_key, account_id, r["job_id"])
    print(f"[pass] seeded {n} memories in {ns}")

    seen: list[str] = []
    cursor = None
    pages = 0
    while True:
        body = {"namespace": ns, "limit": page}
        if cursor is not None:
            body["cursor"] = cursor
        resp = make_signed_request("POST", "/api/list", body, signing_key, account_id=account_id)
        pages += 1
        got = [m["id"] for m in resp["memories"]]
        assert len(got) == resp["returned"], "returned must equal len(memories)"
        assert resp["returned"] <= page, f"page exceeded limit: {resp['returned']} > {page}"
        seen.extend(got)
        if resp["has_more"]:
            assert resp.get("next_cursor"), "has_more=true must carry a next_cursor"
            cursor = resp["next_cursor"]
        else:
            assert not resp.get("next_cursor"), "last page must not carry a next_cursor"
            break
        assert pages <= n + 2, "pagination did not terminate (cursor not advancing)"

    # Every memory seen exactly once across the pages.
    assert len(seen) == n, f"expected {n} memories across pages, saw {len(seen)}"
    assert len(set(seen)) == n, f"duplicate ids across pages: {len(seen)} seen, {len(set(seen))} unique"
    print(f"[pass] paginated {n} memories over {pages} pages: no skips, no dups, has_more correct")

    # An invalid cursor is a 400, not a silent first-page reset.
    bad = None
    try:
        make_signed_request(
            "POST", "/api/list", {"namespace": ns, "limit": page, "cursor": "not-a-valid-cursor"},
            signing_key, account_id=account_id,
        )
    except urllib.error.HTTPError as e:
        bad = e.code
    assert bad == 400, f"invalid cursor should 400, got {bad}"
    print(f"[pass] invalid cursor → 400 (no silent reset)")

    make_signed_request("POST", "/api/clear-namespace", {"namespace": ns}, signing_key, account_id=account_id)


def test_forget_is_per_row_not_per_blob(
    signing_key: SigningKey, account_id: str | None
) -> None:
    """forget(id) is keyed on the per-row id, NOT the blob_id.

    Stores TWO memories with IDENTICAL text. SEAL ciphertext is deterministic
    (same plaintext → same blob_id — the content-addressed dedup property), so
    the two rows share a blob_id but have distinct row `id`s. Forgetting ONE by
    its id must leave the other recallable. A buggy blob_id-keyed delete would
    tombstone BOTH rows (shared blob_id) and this test would catch it — which
    the prior distinct-text test could not.
    """
    ns = "e2e-perrow-test"
    text = "The mitochondria is the powerhouse of the cell."

    for _ in range(2):
        r = make_signed_request(
            "POST", "/api/remember", {"text": text, "namespace": ns},
            signing_key, account_id=account_id,
        )
        wait_for_remember_job(signing_key, account_id, r["job_id"])

    listing = make_signed_request(
        "POST", "/api/list", {"namespace": ns, "limit": 50},
        signing_key, account_id=account_id,
    )
    ids = [m["id"] for m in listing["memories"]]
    assert len(ids) >= 2, f"Expected ≥2 identical-text rows, got {len(ids)}"
    # If determinism holds they share one blob_id; assert distinct row ids regardless.
    assert len(set(ids)) == len(ids), "row ids must be unique even for identical text"
    print(f"[pass] 2 identical-text memories stored as {len(ids)} distinct rows")

    # Forget exactly one by its row id.
    forgot = make_signed_request(
        "POST", "/api/memories/forget", {"id": ids[0]},
        signing_key, account_id=account_id,
    )
    assert forgot["forgotten"] == 1, (
        f"Expected forgotten=1 (per-row), got {forgot} — "
        "a blob_id-keyed delete would tombstone all siblings"
    )

    # The sibling (same text, different row id) must survive.
    after = make_signed_request(
        "POST", "/api/list", {"namespace": ns, "limit": 50},
        signing_key, account_id=account_id,
    )
    remaining = {m["id"] for m in after["memories"]}
    assert ids[0] not in remaining, "forgotten row still listed"
    assert ids[1] in remaining, (
        "identical-text sibling was wrongly removed — forget appears to be "
        "blob_id-keyed, not per-row"
    )
    print(f"[pass] forget one of two identical-text rows → sibling survives (per-row id-keyed)")


def test_cross_owner_isolation(
    owner_a: SigningKey, account_a: str | None,
    owner_b: SigningKey, account_b: str | None,
) -> None:
    """owner B cannot clear/list/forget owner A's memories.

    The privacy-floor assertion that matters most: every delete/list path is
    owner-scoped by the auth-derived owner, so a second tenant sees nothing of
    A's data and their delete attempts are clean no-ops. Requires a SECOND
    delegate key (TEST_DELEGATE_KEY_2 / TEST_ACCOUNT_ID_2); skipped otherwise.
    """
    ns = "e2e-xowner-test"

    # A seeds a memory.
    r = make_signed_request(
        "POST", "/api/remember", {"text": "A's private note.", "namespace": ns},
        owner_a, account_id=account_a,
    )
    wait_for_remember_job(owner_a, account_a, r["job_id"])
    a_list = make_signed_request(
        "POST", "/api/list", {"namespace": ns, "limit": 50}, owner_a, account_id=account_a
    )
    assert a_list["returned"] >= 1, "A's own memory should be listed"
    a_id = a_list["memories"][0]["id"]
    print(f"[pass] owner A seeded + lists own memory (id={a_id[:8]}…)")

    # B sees nothing of A's namespace (B's own rows there = none).
    b_list = make_signed_request(
        "POST", "/api/list", {"namespace": ns, "limit": 50}, owner_b, account_id=account_b
    )
    assert b_list["returned"] == 0, f"owner B must not see A's memories, got {b_list['returned']}"
    print(f"[pass] owner B list of A's namespace → 0 (isolated)")

    # B's clear of the shared namespace string clears only B's rows (none).
    b_clear = make_signed_request(
        "POST", "/api/clear-namespace", {"namespace": ns}, owner_b, account_id=account_b
    )
    assert b_clear["cleared"] == 0, f"owner B clear must touch nothing of A's, got {b_clear}"

    # B's forget of A's real id is a no-op (owner-scoped, not just id-scoped).
    b_forget = make_signed_request(
        "POST", "/api/memories/forget", {"id": a_id}, owner_b, account_id=account_b
    )
    assert b_forget["forgotten"] == 0, (
        f"owner B forgetting A's id must be a no-op (IDOR guard), got {b_forget}"
    )
    print(f"[pass] owner B clear + forget of A's data → no-ops (owner-scoped)")

    # A's memory survived all of B's attempts.
    a_after = make_signed_request(
        "POST", "/api/list", {"namespace": ns, "limit": 50}, owner_a, account_id=account_a
    )
    assert a_id in {m["id"] for m in a_after["memories"]}, (
        "A's memory was wrongly affected by B — cross-owner isolation broken"
    )
    print(f"[pass] owner A's memory intact after B's attempts (isolation holds)")

    # Cleanup A's namespace so reruns start clean.
    make_signed_request(
        "POST", "/api/clear-namespace", {"namespace": ns}, owner_a, account_id=account_a
    )


MAX_REMEMBER_TEXT_BYTES = 1024 * 1024  # mirrors src/routes.rs constant
# Largest plaintext we exercise in the e2e test. Smaller than the route
# ceiling — bigger payloads work too (see scripts/bench-remember-sizes.ts)
# but at 1 MiB the summarize path fans out to 16 parallel LLM calls, which
# multiplies any upstream flake into a per-request failure. 512 KiB still
# exercises the chunked map-reduce path (8 chunks) without that risk.
LARGE_TEXT_BYTES = 512 * 1024


def _send_remember_raw(
    text: str,
    signing_key: SigningKey,
    account_id: str | None,
) -> tuple[int, str]:
    """Send a signed /api/remember and return (status_code, response_body).

    Used for negative tests where we expect a 4xx — make_signed_request would
    raise on non-2xx, so we drop down to urllib here to inspect the status.
    """
    body = {"text": text, "namespace": "e2e-size-test"}
    body_bytes = json.dumps(body).encode()
    timestamp = str(int(time.time()))
    nonce = str(uuid.uuid4())
    signature_hex = _sign(
        signing_key, "POST", "/api/remember", body_bytes, timestamp, nonce, account_id or ""
    )
    public_key_hex = signing_key.verify_key.encode().hex()
    headers = {
        "Content-Type": "application/json",
        "x-public-key": public_key_hex,
        "x-signature": signature_hex,
        "x-timestamp": timestamp,
        "x-nonce": nonce,
    }
    if account_id:
        headers["x-account-id"] = account_id
    req = urllib.request.Request(
        f"{BASE_URL}/api/remember", data=body_bytes, headers=headers, method="POST"
    )
    try:
        with urllib.request.urlopen(req) as resp:
            return resp.status, resp.read().decode("utf-8", errors="replace")
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode("utf-8", errors="replace")


def test_remember_size_64kb_summarized(
    signing_key: SigningKey, account_id: str | None
) -> None:
    """64 KiB plaintext: must succeed via the new summarize path.

    On the pre-PR baseline this size errors out at the embedding API token
    limit. PR routes text > SUMMARIZE_THRESHOLD_BYTES through gpt-4o-mini
    summarization first; this is the regression test that proves the path
    works end-to-end against real Walrus + SEAL.
    """
    text = ("The quick brown fox jumps over the lazy dog. " * (64 * 1024 // 45 + 1))[:64 * 1024]
    assert len(text) == 64 * 1024
    body = {"text": text, "namespace": "e2e-size-test"}
    result = make_signed_request("POST", "/api/remember", body, signing_key, account_id)
    assert "id" in result, f"64 KiB remember failed: {result}"
    print(f"[pass] POST /api/remember 64 KiB → id={result['id']} (summarize path)")


def test_remember_size_large_accepted(
    signing_key: SigningKey, account_id: str | None
) -> None:
    """`LARGE_TEXT_BYTES` plaintext: must succeed end-to-end.

    Exercises the chunked map-reduce path (8 chunks at this size), the
    auth body cap, the sidecar `/seal/encrypt` body limit, SEAL encrypt
    on the full plaintext, and the Walrus upload. If any of those caps is
    too tight, this returns 400 (auth/route layer) or 500 (sidecar).
    """
    text = ("The quick brown fox jumps over the lazy dog. " * (LARGE_TEXT_BYTES // 45 + 1))[:LARGE_TEXT_BYTES]
    assert len(text) == LARGE_TEXT_BYTES
    body = {"text": text, "namespace": "e2e-size-test"}
    result = make_signed_request("POST", "/api/remember", body, signing_key, account_id)
    assert "id" in result, f"large-size remember failed: {result}"
    print(f"[pass] POST /api/remember {LARGE_TEXT_BYTES} bytes → id={result['id']}")


def test_remember_size_over_limit_rejected(
    signing_key: SigningKey, account_id: str | None
) -> None:
    """`MAX_REMEMBER_TEXT_BYTES + 1`: must return 400 from the handler size check.

    Should fail with HTTP 400 and a body that names the byte ceiling — not
    the empty 400 you'd see if upstream auth/body limits were too tight.
    """
    text = "x" * (MAX_REMEMBER_TEXT_BYTES + 1)
    status, body = _send_remember_raw(text, signing_key, account_id)
    assert status == 400, f"expected 400 over limit, got {status}: {body[:200]}"
    assert "exceeds maximum length" in body, (
        f"expected handler-level rejection message, got: {body[:200]}"
    )
    print(f"[pass] POST /api/remember {len(text)} bytes → 400 (handler-level reject)")


def main() -> int:
    print("=" * 60)
    print(f"  memwal Server E2E — target {BASE_URL}")
    delegate_key = _load_delegate_key()
    account_id = os.environ.get("TEST_ACCOUNT_ID") or None
    if delegate_key:
        print("  happy-path: enabled (TEST_DELEGATE_KEY provided)")
    else:
        print("  happy-path: skipped (set TEST_DELEGATE_KEY to enable)")
    print("=" * 60)

    failures: list[str] = []

    contract_checks = (
        ("health", test_health),
        ("version", test_version),
        ("unsigned_rejected", test_unsigned_rejected),
        ("wrong_signature_rejected", test_wrong_signature_rejected),
        ("expired_timestamp_rejected", test_expired_timestamp_rejected),
    )
    for name, fn in contract_checks:
        try:
            fn()
        except (AssertionError, urllib.error.URLError, urllib.error.HTTPError) as e:
            failures.append(f"{name}: {e}")
            print(f"[FAIL] {name}: {e}")

    if delegate_key:
        try:
            test_remember_recall_happy_path(delegate_key, account_id)
        except (AssertionError, urllib.error.URLError, urllib.error.HTTPError) as e:
            failures.append(f"remember_recall_happy_path: {e}")
            print(f"[FAIL] remember_recall_happy_path: {e}")

        # parametric size cases that the prior tiny-payload tests
        # missed. Share the same Walrus + SEAL prerequisites as the happy
        # path, so they run together.
        size_checks = (
            ("size_64kb_summarized", test_remember_size_64kb_summarized),
            ("size_large_accepted", test_remember_size_large_accepted),
            ("size_over_limit_rejected", test_remember_size_over_limit_rejected),
            ("clear_namespace_soft_delete", test_clear_namespace_soft_delete),
            ("list_and_forget_by_id", test_list_and_forget_by_id),
            ("list_pagination", test_list_pagination),
            ("forget_is_per_row_not_per_blob", test_forget_is_per_row_not_per_blob),
        )
        for name, fn in size_checks:
            try:
                fn(delegate_key, account_id)
            except (AssertionError, urllib.error.URLError, urllib.error.HTTPError) as e:
                failures.append(f"{name}: {e}")
                print(f"[FAIL] {name}: {e}")

        # cross-owner isolation — needs a SECOND delegate key.
        owner_b, account_b = _load_delegate_key_2()
        if owner_b:
            try:
                test_cross_owner_isolation(delegate_key, account_id, owner_b, account_b)
            except (AssertionError, urllib.error.URLError, urllib.error.HTTPError) as e:
                failures.append(f"cross_owner_isolation: {e}")
                print(f"[FAIL] cross_owner_isolation: {e}")
        else:
            # Without a second key, cross-OWNER isolation
            # is unverified by E2E. The owner-scoping is pinned at the SQL level
            # by the Rust test `soft_delete_queries_are_owner_scoped`; this E2E
            # is the live-stack confirmation. Set TEST_DELEGATE_KEY_2 +
            # TEST_ACCOUNT_ID_2 to enable.
            print("[skip] cross_owner_isolation (set TEST_DELEGATE_KEY_2 + TEST_ACCOUNT_ID_2 to enable)")
    else:
        print("[skip] remember_recall_happy_path (no TEST_DELEGATE_KEY)")
        print("[skip] size_*_test (no TEST_DELEGATE_KEY)")
        print("[skip] clear_namespace_soft_delete (no TEST_DELEGATE_KEY)")
        print("[skip] list_and_forget_by_id (no TEST_DELEGATE_KEY)")
        print("[skip] list_pagination (no TEST_DELEGATE_KEY)")
        print("[skip] forget_is_per_row_not_per_blob (no TEST_DELEGATE_KEY)")
        print("[skip] cross_owner_isolation (no TEST_DELEGATE_KEY)")

    print()
    print("=" * 60)
    if failures:
        print(f"  {len(failures)} failure(s):")
        for f in failures:
            print(f"    - {f}")
        print("=" * 60)
        return 1
    print("  all checks passed")
    print("=" * 60)
    return 0


if __name__ == "__main__":
    sys.exit(main())
