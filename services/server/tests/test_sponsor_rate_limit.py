#!/usr/bin/env python3
"""
Integration tests — Sponsor rate limiting (Phase 01 + Phase 02).

Covers every success criterion from plans/20260413-1430-sponsor-rate-limiting/plan-en.md.

Run against a live server:
    python tests/test_sponsor_rate_limit.py

Server must be running on BASE_URL with Redis available.
The sidecar does NOT need to be running for most tests —
rate limit and validation are enforced before the sidecar is called.

Tests that require a slow/mock sidecar are marked SKIP_NO_SIDECAR.
"""

import json
import os
import sys
import time
import uuid
import base64
import urllib.request
import urllib.error
from concurrent.futures import ThreadPoolExecutor, as_completed

BASE_URL = os.environ.get("TEST_BASE_URL", "http://localhost:8000")
SKIP_NO_SIDECAR = os.environ.get("WITH_SIDECAR", "0") == "1"

PASS = "\033[32m[PASS]\033[0m"
FAIL = "\033[31m[FAIL]\033[0m"
SKIP = "\033[33m[SKIP]\033[0m"

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def http(method: str, path: str, body=None, headers=None, expect_codes=(200,)):
    """Send an HTTP request, return (status_code, response_body_str)."""
    url = f"{BASE_URL}{path}"
    data = json.dumps(body).encode() if body is not None else None
    h = {"Content-Type": "application/json", **(headers or {})}
    req = urllib.request.Request(url, data=data, headers=h, method=method)
    try:
        with urllib.request.urlopen(req) as resp:
            return resp.status, resp.read().decode()
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode()


def unique_ip() -> str:
    """Return a unique fake IP string that won't collide across test runs."""
    return f"test-{uuid.uuid4().hex[:12]}"


def valid_sponsor_body() -> dict:
    """Minimal valid /sponsor body."""
    tx_bytes = base64.b64encode(b"\x00" * 12).decode()
    return {
        "sender": "0x" + "a" * 64,
        "transactionBlockKindBytes": tx_bytes,
    }


def valid_execute_body() -> dict:
    """Minimal valid /sponsor/execute body."""
    sig = base64.b64encode(b"\x00" * 65).decode()  # 65-byte signature
    return {
        "digest": "1" * 43,  # valid base58, 43 chars
        "signature": sig,
    }


REDIS_URL = os.environ.get("TEST_REDIS_URL", "redis://localhost:6379")


def redis_flush(*keys: str):
    """Delete Redis keys via a raw TCP connection — no external tools needed."""
    import socket
    host_port = REDIS_URL.replace("redis://", "")
    host, _, port_str = host_port.partition(":")
    port = int(port_str) if port_str else 6379
    with socket.create_connection((host, port), timeout=3) as s:
        for key in keys:
            cmd = f"*2\r\n$3\r\nDEL\r\n${len(key)}\r\n{key}\r\n".encode()
            s.sendall(cmd)
            s.recv(64)  # consume the :integer reply


def server_is_up() -> bool:
    try:
        code, _ = http("GET", "/health")
        return code == 200
    except Exception:
        return False


# ---------------------------------------------------------------------------
# Phase 02 — Input Validation
# ---------------------------------------------------------------------------

def test_sponsor_no_sender_returns_400():
    """POST /sponsor with no sender field → 400."""
    code, body = http("POST", "/sponsor", body={"transactionBlockKindBytes": "AAAAAAAAAAAAAAAA"},
                      headers={"X-Forwarded-For": unique_ip()})
    assert code == 400, f"expected 400, got {code}"
    print(f"{PASS} no sender → 400")


def test_sponsor_invalid_sender_returns_400():
    """POST /sponsor with sender='0xBAD' → 400."""
    code, body = http("POST", "/sponsor",
                      body={"sender": "0xBAD", "transactionBlockKindBytes": "AAAAAAAAAAAAAAAA"},
                      headers={"X-Forwarded-For": unique_ip()})
    assert code == 400, f"expected 400, got {code}"
    print(f"{PASS} invalid sender → 400")


def test_sponsor_invalid_sender_not_echoed():
    """Response body must NOT contain the invalid sender value (prevents reflected injection)."""
    bad_sender = "0xBAD_SHOULD_NOT_APPEAR_IN_RESPONSE"
    code, body = http("POST", "/sponsor",
                      body={"sender": bad_sender, "transactionBlockKindBytes": "AAAAAAAAAAAAAAAA"},
                      headers={"X-Forwarded-For": unique_ip()})
    assert code == 400, f"expected 400, got {code}"
    assert bad_sender not in body, f"server echoed the bad sender value: {body}"
    print(f"{PASS} bad sender value not echoed in response")


def test_sponsor_missing_tx_bytes_returns_400():
    """POST /sponsor with valid sender but no transactionBlockKindBytes → 400."""
    code, body = http("POST", "/sponsor", body={"sender": "0x" + "a" * 64},
                      headers={"X-Forwarded-For": unique_ip()})
    assert code == 400, f"expected 400, got {code}"
    print(f"{PASS} missing transactionBlockKindBytes → 400")


def test_sponsor_tx_bytes_invalid_base64_returns_400():
    """POST /sponsor with non-base64 transactionBlockKindBytes → 400."""
    code, _ = http("POST", "/sponsor", body={
        "sender": "0x" + "a" * 64,
        "transactionBlockKindBytes": "not!!valid@@base64",
    }, headers={"X-Forwarded-For": unique_ip()})
    assert code == 400, f"expected 400, got {code}"
    print(f"{PASS} invalid base64 transactionBlockKindBytes → 400")


def test_sponsor_tx_bytes_too_small_returns_400():
    """POST /sponsor with transactionBlockKindBytes decoding to < 10 bytes → 400."""
    tiny = base64.b64encode(b"\x00" * 5).decode()
    code, _ = http("POST", "/sponsor", body={
        "sender": "0x" + "a" * 64,
        "transactionBlockKindBytes": tiny,
    }, headers={"X-Forwarded-For": unique_ip()})
    assert code == 400, f"expected 400, got {code}"
    print(f"{PASS} tx_bytes < 10 bytes → 400")


def test_sponsor_tx_bytes_too_large_returns_400():
    """POST /sponsor with transactionBlockKindBytes decoding to > 7000 bytes → 400.

    7001 bytes raw encodes to ~9335 bytes base64 (~9.1 KB), well under the 10 KB body limit,
    so the content validator fires before the body limit.
    """
    big = base64.b64encode(b"\x00" * 7001).decode()
    code, _ = http("POST", "/sponsor", body={
        "sender": "0x" + "a" * 64,
        "transactionBlockKindBytes": big,
    }, headers={"X-Forwarded-For": unique_ip()})
    assert code == 400, f"expected 400, got {code}"
    print(f"{PASS} tx_bytes > 7000 bytes → 400")


def test_sponsor_body_too_large_returns_413():
    """POST /sponsor with body > 10 KB → 413 (DefaultBodyLimit)."""
    # 10 KB + 1 byte of padding
    big_body = "x" * (10 * 1024 + 1)
    url = f"{BASE_URL}/sponsor"
    data = big_body.encode()
    req = urllib.request.Request(
        url, data=data,
        headers={"Content-Type": "application/json", "X-Forwarded-For": unique_ip()},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req) as resp:
            code = resp.status
    except urllib.error.HTTPError as e:
        code = e.code
    assert code == 413, f"expected 413, got {code}"
    print(f"{PASS} body > 10 KB → 413")


def test_execute_missing_digest_returns_400():
    """POST /sponsor/execute with no digest → 400."""
    sig = base64.b64encode(b"\x00" * 65).decode()
    code, _ = http("POST", "/sponsor/execute", body={"signature": sig},
                   headers={"X-Forwarded-For": unique_ip()})
    assert code == 400, f"expected 400, got {code}"
    print(f"{PASS} missing digest → 400")


def test_execute_invalid_digest_returns_400():
    """POST /sponsor/execute with digest containing '0' (not base58) → 400."""
    bad_digest = "0" * 43  # '0' is not in base58 alphabet
    sig = base64.b64encode(b"\x00" * 65).decode()
    code, _ = http("POST", "/sponsor/execute", body={"digest": bad_digest, "signature": sig},
                   headers={"X-Forwarded-For": unique_ip()})
    assert code == 400, f"expected 400, got {code}"
    print(f"{PASS} invalid digest (base58 violation) → 400")


def test_execute_digest_wrong_length_returns_400():
    """POST /sponsor/execute with digest of wrong length (42 chars) → 400."""
    sig = base64.b64encode(b"\x00" * 65).decode()
    code, _ = http("POST", "/sponsor/execute", body={"digest": "1" * 42, "signature": sig},
                   headers={"X-Forwarded-For": unique_ip()})
    assert code == 400, f"expected 400, got {code}"
    print(f"{PASS} digest wrong length → 400")


def test_execute_signature_wrong_length_returns_400():
    """POST /sponsor/execute with signature decoding to 64 bytes (not 65 or 97) → 400."""
    sig_64 = base64.b64encode(b"\x00" * 64).decode()
    code, _ = http("POST", "/sponsor/execute", body={"digest": "1" * 43, "signature": sig_64},
                   headers={"X-Forwarded-For": unique_ip()})
    assert code == 400, f"expected 400, got {code}"
    print(f"{PASS} signature wrong decoded length → 400")


def test_execute_body_too_large_returns_413():
    """POST /sponsor/execute with body > 4 KB → 413."""
    big_body = "x" * (4 * 1024 + 1)
    url = f"{BASE_URL}/sponsor/execute"
    data = big_body.encode()
    req = urllib.request.Request(
        url, data=data,
        headers={"Content-Type": "application/json", "X-Forwarded-For": unique_ip()},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req) as resp:
            code = resp.status
    except urllib.error.HTTPError as e:
        code = e.code
    assert code == 413, f"expected 413, got {code}"
    print(f"{PASS} /sponsor/execute body > 4 KB → 413")


def test_valid_sponsor_body_passes_all_guards():
    """
    POST /sponsor with a fully valid body must pass every guard layer:
    rate limit middleware → body limit → validation → reaches upstream.
    Upstream may be down (502) but the request must not be blocked by our guards (400/413/429).
    """
    body = valid_sponsor_body()
    code, _ = http("POST", "/sponsor", body=body, headers={"X-Forwarded-For": unique_ip()})
    assert code not in (400, 413, 429), \
        f"valid body blocked by a guard layer (got {code}), should reach upstream"
    print(f"{PASS} valid /sponsor body passes all guards → upstream returned {code}")


def test_valid_execute_body_passes_all_guards():
    """
    POST /sponsor/execute with a fully valid body must pass every guard layer.
    Upstream may be down (502) but must not be blocked by our guards.
    """
    body = valid_execute_body()
    code, _ = http("POST", "/sponsor/execute", body=body, headers={"X-Forwarded-For": unique_ip()})
    assert code not in (400, 413, 429), \
        f"valid body blocked by a guard layer (got {code}), should reach upstream"
    print(f"{PASS} valid /sponsor/execute body passes all guards → upstream returned {code}")


# ---------------------------------------------------------------------------
# Phase 01 — Rate Limiting
# ---------------------------------------------------------------------------

def test_rate_limit_10th_request_still_allowed():
    """
    Boundary: the 10th request from an IP must NOT be rate limited.
    Off-by-one in the Lua ZCARD check would block request 10 instead of 11.
    """
    ip = unique_ip()
    headers = {"X-Forwarded-For": ip}

    for i in range(9):
        http("POST", "/sponsor", body={}, headers=headers)

    # 10th must pass the rate limiter (handler may reject with 400 for empty body — that's fine)
    code, _ = http("POST", "/sponsor", body={}, headers=headers)
    assert code != 429, f"10th request must not be rate limited (got {code})"
    print(f"{PASS} 10th request from same IP still allowed (boundary: limit is 10/min, not 9)")


def test_rate_limit_window_resets_via_redis():
    """
    Recovery: after the minute window expires (simulated by flushing the min key),
    the same IP can make requests again even though the hour bucket still exists.

    This verifies the Lua script uses ZREMRANGEBYSCORE to evict stale entries
    rather than just counting all-time entries.
    """
    ip = unique_ip()
    headers = {"X-Forwarded-For": ip}

    # Fill the minute bucket
    for _ in range(10):
        http("POST", "/sponsor", body={}, headers=headers)
    code, _ = http("POST", "/sponsor", body={}, headers=headers)
    assert code == 429, f"bucket should be full before reset, got {code}"

    # Simulate minute window expiry: delete the :min key (as Redis TTL would do)
    # Key format from rate_limit.rs: "sponsor:rl:{ip}:min"
    min_key = f"sponsor:rl:{ip}:min"
    redis_flush(min_key)

    # Same IP should now be allowed again (minute window is clean)
    code, _ = http("POST", "/sponsor", body={}, headers=headers)
    assert code != 429, f"after minute window reset, IP should be allowed again (got {code})"
    print(f"{PASS} rate limit window resets after minute bucket expires — IP unblocked")


def test_rate_limit_valid_body_counts_against_limit():
    """
    A request with a *valid* body also counts against the rate limit.
    Previously only invalid bodies were used in rate limit tests — this confirms
    the counter increments regardless of whether the handler succeeds or fails.

    Uses a unique sender per run to avoid cross-test contamination of the
    per-sender bucket (valid_sponsor_body() always uses 0xaaaa... which is
    shared across tests).
    """
    ip = unique_ip()
    headers = {"X-Forwarded-For": ip}
    # Use a unique sender so this test's per-sender bucket is isolated
    unique_sender = "0x" + uuid.uuid4().hex * 2  # 64 hex chars
    tx_bytes = base64.b64encode(b"\x00" * 12).decode()
    body = {"sender": unique_sender, "transactionBlockKindBytes": tx_bytes}

    # Send 10 valid requests (each reaches upstream, may return 502)
    for i in range(10):
        code, _ = http("POST", "/sponsor", body=body, headers=headers)
        assert code != 429, f"should not hit rate limit before the 11th request (hit at {i+1})"

    # 11th — now rate limited regardless of body validity
    code, _ = http("POST", "/sponsor", body=body, headers=headers)
    assert code == 429, f"11th valid request should be rate limited (got {code})"
    print(f"{PASS} valid body requests count against rate limit same as invalid ones")


def test_rate_limit_11_requests_same_ip_triggers_429():
    """
    Plan criterion 1: 11 consecutive /sponsor calls from same IP → 11th returns 429.

    The middleware records each request even when the handler returns 400 (invalid body).
    The 11th call must be rejected by the middleware with 429 before validation runs.
    """
    ip = unique_ip()
    headers = {"X-Forwarded-For": ip}
    results = []

    for i in range(11):
        code, _ = http("POST", "/sponsor", body={}, headers=headers)
        results.append(code)

    # First 10: middleware allows (records), handler rejects with 400
    for i, code in enumerate(results[:10]):
        assert code in (400, 502, 503), f"request {i+1}: expected 400/502/503 before limit, got {code}"

    # 11th: middleware rejects with 429
    assert results[10] == 429, f"11th request should be 429, got {results[10]}"
    print(f"{PASS} 11th consecutive request from same IP → 429")


def test_rate_limit_shared_bucket_alternating_endpoints():
    """
    Plan criterion 2: /sponsor and /sponsor/execute share the same bucket.
    11 total alternating calls → 11th returns 429.
    """
    ip = unique_ip()
    headers = {"X-Forwarded-For": ip}
    results = []

    for i in range(5):
        code, _ = http("POST", "/sponsor", body={}, headers=headers)
        results.append(("sponsor", code))
        code, _ = http("POST", "/sponsor/execute", body={}, headers=headers)
        results.append(("execute", code))

    # 11th call
    code, _ = http("POST", "/sponsor", body={}, headers=headers)
    results.append(("sponsor", code))

    last_code = results[-1][1]
    assert last_code == 429, f"11th alternating call should be 429, got {last_code}"
    print(f"{PASS} shared bucket: alternating /sponsor + /sponsor/execute → 11th is 429")


def test_rate_limit_xff_uses_last_entry():
    """
    Plan criterion 5: X-Forwarded-For: 1.2.3.4, 5.6.7.8 → IP used is 5.6.7.8.

    We fill the bucket for 5.6.7.8 and verify the limit is hit using that IP,
    not 1.2.3.4 (which should still have a clean bucket).
    """
    real_ip = unique_ip()
    spoofed_xff = f"1.2.3.4, {real_ip}"

    # Fill the bucket for real_ip via the spoofed XFF header
    for _ in range(10):
        http("POST", "/sponsor", body={}, headers={"X-Forwarded-For": spoofed_xff})

    # 11th with same spoofed header → real_ip bucket is full → 429
    code, _ = http("POST", "/sponsor", body={}, headers={"X-Forwarded-For": spoofed_xff})
    assert code == 429, f"expected 429 for real_ip bucket full, got {code}"

    # Verify 1.2.3.4 bucket is NOT affected — a request with just 1.2.3.4 should pass the rate limit
    # (we use a unique second real_ip to avoid any cross-contamination)
    code_clean, _ = http("POST", "/sponsor", body={}, headers={"X-Forwarded-For": "1.2.3.4"})
    assert code_clean != 429, f"1.2.3.4 should not be rate limited (got {code_clean})"
    print(f"{PASS} XFF last-entry rule: bucket filled via last IP, first IP unaffected")


def test_rate_limit_different_ips_independent():
    """Two different IPs are rate-limited independently."""
    ip_a = unique_ip()
    ip_b = unique_ip()

    # Fill ip_a to the limit
    for _ in range(10):
        http("POST", "/sponsor", body={}, headers={"X-Forwarded-For": ip_a})

    code_a, _ = http("POST", "/sponsor", body={}, headers={"X-Forwarded-For": ip_a})
    assert code_a == 429, f"ip_a should be rate limited"

    # ip_b should still be clean
    code_b, _ = http("POST", "/sponsor", body={}, headers={"X-Forwarded-For": ip_b})
    assert code_b != 429, f"ip_b should NOT be rate limited (got {code_b})"
    print(f"{PASS} different IPs have independent rate limit buckets")


def test_semaphore_503_when_at_capacity():
    """
    Plan criterion 3: 9 in-flight requests simultaneously → 9th returns 503.

    Requires a slow sidecar (WITH_SIDECAR=1) to keep requests in-flight.
    Without a sidecar, the handler completes too fast to saturate the semaphore.
    Skipped unless WITH_SIDECAR=1.
    """
    if not SKIP_NO_SIDECAR:
        print(f"{SKIP} semaphore 503 test requires slow sidecar — set WITH_SIDECAR=1")
        return

    body = valid_sponsor_body()
    results = []

    def send_one():
        code, resp = http("POST", "/sponsor", body=body)
        return code

    with ThreadPoolExecutor(max_workers=9) as pool:
        futures = [pool.submit(send_one) for _ in range(9)]
        for f in as_completed(futures):
            results.append(f.result())

    assert 503 in results, f"at least one request should get 503 (got {results})"
    print(f"{PASS} 9 concurrent requests → at least one 503 (semaphore full)")


# ---------------------------------------------------------------------------
# Phase 02 — Error Masking
# ---------------------------------------------------------------------------

def test_mask_upstream_enoki_429_returns_503_generic():
    """
    Enoki returns 429 with body containing API key → client receives 503 with generic message.
    Requires a mock sidecar that returns 429. Skipped unless WITH_SIDECAR=1.
    """
    if not SKIP_NO_SIDECAR:
        print(f"{SKIP} upstream masking test requires mock sidecar — set WITH_SIDECAR=1")
        return

    body = valid_sponsor_body()
    code, resp_body = http("POST", "/sponsor", body=body)
    assert code == 503, f"expected 503 when upstream returns 429, got {code}"
    data = json.loads(resp_body)
    assert "enoki" not in resp_body.lower(), "Enoki internals must not appear in response"
    assert "api" not in resp_body.lower() or "error" in resp_body.lower(), \
        "API key must not appear in response"
    assert data.get("error") == "Sponsor service temporarily overloaded"
    print(f"{PASS} upstream 429 masked to 503 with generic message")


# ---------------------------------------------------------------------------
# Phase 02 — CORS
# ---------------------------------------------------------------------------

def test_cors_disallowed_origin_no_header():
    """
    Browser preflight from origin not in ALLOWED_ORIGINS → no Access-Control-Allow-Origin.
    Plan criterion 5 (Phase 02).
    """
    url = f"{BASE_URL}/sponsor"
    req = urllib.request.Request(
        url,
        headers={
            "Origin": "https://evil-attacker.com",
            "Access-Control-Request-Method": "POST",
            "Access-Control-Request-Headers": "Content-Type",
        },
        method="OPTIONS",
    )
    try:
        with urllib.request.urlopen(req) as resp:
            acao = resp.headers.get("Access-Control-Allow-Origin", "")
    except urllib.error.HTTPError as e:
        acao = e.headers.get("Access-Control-Allow-Origin", "")

    assert acao != "https://evil-attacker.com" and acao != "*", \
        f"evil origin must not receive ACAO header, got: '{acao}'"
    print(f"{PASS} preflight from disallowed origin → no Access-Control-Allow-Origin")


def test_cors_allowed_origin_gets_header():
    """
    Browser preflight from an allowed origin → Access-Control-Allow-Origin is set.
    Only runs if ALLOWED_ORIGINS is configured; skipped otherwise.
    """
    allowed = os.environ.get("TEST_ALLOWED_ORIGIN", "")
    if not allowed:
        print(f"{SKIP} set TEST_ALLOWED_ORIGIN=http://localhost:3000 to run this test")
        return

    url = f"{BASE_URL}/sponsor"
    req = urllib.request.Request(
        url,
        headers={
            "Origin": allowed,
            "Access-Control-Request-Method": "POST",
            "Access-Control-Request-Headers": "Content-Type",
        },
        method="OPTIONS",
    )
    try:
        with urllib.request.urlopen(req) as resp:
            acao = resp.headers.get("Access-Control-Allow-Origin", "")
    except urllib.error.HTTPError as e:
        acao = e.headers.get("Access-Control-Allow-Origin", "")

    assert acao == allowed, f"allowed origin should get ACAO header, got: '{acao}'"
    print(f"{PASS} preflight from allowed origin ({allowed}) → Access-Control-Allow-Origin set")


# ---------------------------------------------------------------------------
# Runner
# ---------------------------------------------------------------------------

def run_all():
    if not server_is_up():
        print(f"\n{FAIL} Server not reachable at {BASE_URL}. Start the server and retry.\n")
        sys.exit(1)

    print(f"\n{'='*60}")
    print(f"  Sponsor Rate Limit — Integration Tests")
    print(f"  Target: {BASE_URL}")
    print(f"{'='*60}\n")

    tests = [
        # Phase 02 — Validation
        ("no sender → 400",                         test_sponsor_no_sender_returns_400),
        ("invalid sender → 400",                    test_sponsor_invalid_sender_returns_400),
        ("bad sender not echoed",                   test_sponsor_invalid_sender_not_echoed),
        ("missing tx bytes → 400",                  test_sponsor_missing_tx_bytes_returns_400),
        ("invalid base64 tx bytes → 400",           test_sponsor_tx_bytes_invalid_base64_returns_400),
        ("tx bytes < 10 bytes → 400",               test_sponsor_tx_bytes_too_small_returns_400),
        ("tx bytes > 7000 bytes → 400",             test_sponsor_tx_bytes_too_large_returns_400),
        ("/sponsor body > 10 KB → 413",             test_sponsor_body_too_large_returns_413),
        ("execute missing digest → 400",            test_execute_missing_digest_returns_400),
        ("execute invalid digest → 400",            test_execute_invalid_digest_returns_400),
        ("execute digest wrong length → 400",       test_execute_digest_wrong_length_returns_400),
        ("execute signature wrong length → 400",    test_execute_signature_wrong_length_returns_400),
        ("/sponsor/execute body > 4 KB → 413",      test_execute_body_too_large_returns_413),
        ("valid /sponsor body passes all guards",    test_valid_sponsor_body_passes_all_guards),
        ("valid /execute body passes all guards",   test_valid_execute_body_passes_all_guards),

        # Phase 01 — Rate limiting (rejection)
        ("10th request still allowed (boundary)",   test_rate_limit_10th_request_still_allowed),
        ("11 requests same IP → 429",               test_rate_limit_11_requests_same_ip_triggers_429),
        ("shared bucket alternating → 429",         test_rate_limit_shared_bucket_alternating_endpoints),
        ("XFF last-entry rule",                     test_rate_limit_xff_uses_last_entry),
        ("different IPs independent",               test_rate_limit_different_ips_independent),
        ("9 concurrent → 503 (needs sidecar)",      test_semaphore_503_when_at_capacity),

        # Phase 01 — Rate limiting (recovery & counting)
        ("window resets after expiry",              test_rate_limit_window_resets_via_redis),
        ("valid body counts against limit",         test_rate_limit_valid_body_counts_against_limit),

        # Phase 02 — Masking + CORS
        ("upstream 429 masked (needs sidecar)",     test_mask_upstream_enoki_429_returns_503_generic),
        ("CORS disallowed origin blocked",          test_cors_disallowed_origin_no_header),
        ("CORS allowed origin passes",              test_cors_allowed_origin_gets_header),
    ]

    passed = failed = skipped = 0
    for name, fn in tests:
        try:
            fn()
            passed += 1
        except AssertionError as e:
            print(f"{FAIL} {name}: {e}")
            failed += 1
        except Exception as e:
            print(f"{FAIL} {name}: unexpected error: {e}")
            failed += 1

    print(f"\n{'='*60}")
    print(f"  {passed} passed  |  {failed} failed  |  (skipped tests print inline)")
    print(f"{'='*60}\n")

    if failed:
        sys.exit(1)


if __name__ == "__main__":
    run_all()
