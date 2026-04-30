---
date: 2026-04-29
tags: [lessons, security, memwal, architecture]
---
# Lessons — MemWal Security Audit & Fix

Derived from the code review (3 CRITICAL / 6 HIGH / 5 MEDIUM) and the Phase 1–3 fix session.

---

## 1. Private keys must never leave the process that owns them

Two separate violations of this rule were found in the same codebase:

**Client → server:** The SDK sent the user's raw Sui private key in the `x-delegate-key`
HTTP header on every authenticated request. The server had no legitimate need to receive
it — SEAL decryption should use the server's own key, not the client's. Removed entirely.

**Server → sidecar:** The Walrus upload key was sent from the Rust server to the sidecar
in every `POST /walrus/upload` request body. Even over localhost, this is wrong:

- The sidecar is a separate process — it has no legitimate need to receive a key it should already own.
- Keys in request bodies appear in logs, error messages, and any middleware between the two.
- The correct pattern: each process loads its own secrets from env at startup. If a process needs a key, it owns that key. It does not borrow it per-request from a caller.

**Rule:** If a secret travels in a request — header or body — it belongs in the receiving process's environment instead. Audit every API boundary for key material, not just the obvious ones.

---

## 1b. Ship-blocking bugs hide in pre-existing unstaged changes

After our security commit landed on `dev`, CI failed with a compile error in `auth.rs` — a file we never touched. The `auth.rs` on the remote still had `delegate_key: delegate_key_hex` referencing a field we'd cleaned from `AuthInfo`. It was in git status as "modified" locally (the correct version) but we only staged the files we actively worked on.

The gap: the local correct version of `auth.rs` existed but wasn't pushed, so the remote remained broken until we noticed the CI failure and pushed the fix as a hotfix commit.

**Rule:** Before pushing a security or structural change to shared types (structs, enums, traits), check `git diff` on all files that reference those types — not just the ones you edited. A modified-but-unstaged file in your working tree is invisible to CI.

---

## 2. Silent fallbacks are production bugs wearing a dev convenience disguise

The mock embedding fallback (`None => { /* return hash-based fake vector */ }`) was added during development to avoid needing an API key locally. It was never removed. In production:

- Fake vectors were silently stored alongside real ones.
- Search results would mix real semantic matches with noise.
- There was no log level that would alert you — `tracing::warn!` is easy to miss and doesn't page anyone.

**Rule:** Dev-only fallbacks must be behind an explicit `#[cfg(debug_assertions)]` or env flag, or removed entirely before the code path can reach production. A missing API key should be a hard startup failure, not a silent mode switch.

---

## 3. Check-then-act is not atomic — use a single round-trip

The rate limiter did: `GET count → check → SET new_count`. Under concurrent load, two requests can both pass the `GET count` check before either records. The fix is a Lua script executed with `EVAL` — Redis runs it atomically, so no other command can interleave.

**Rule:** Any "read → decide → write" sequence on shared mutable state requires an atomic operation (Lua script, CAS, database transaction). Separate commands are never safe.

---

## 4. Trust boundaries need explicit authentication even on localhost

The sidecar was reachable on `0.0.0.0` with no authentication. "Only the server calls it" is an assumption, not a control. Any process on the same machine — including a compromised dependency — could call it.

Fix applied in layers:
1. Bind to `127.0.0.1` (reduces attack surface to local processes)
2. Require a shared secret header (`x-sidecar-secret`)
3. Reduce body size limit to prevent resource exhaustion

**Rule:** Every service boundary needs explicit auth, regardless of whether it's "internal." Localhost is not a trust boundary.

---

## 5. Truncated hashes cause silent correctness bugs

The Redis search cache key used `&hash[..16]` — 64 bits of a 256-bit hash. The collision probability for a single key pair is ~1-in-2^64, but across millions of requests from many users with similar query vectors, it becomes meaningful. A collision returns the wrong user's cached search results: a privacy violation, not just a performance issue.

**Rule:** Never truncate a hash to save key length unless you've calculated the birthday-paradox collision probability over your actual traffic volume. For cache keys, use the full hash.

---

## 6. Unbounded external scans need a hard cap

The registry scan (`find_account_by_delegate_key`) iterated all pages of an on-chain table with no upper bound. A registry with thousands of accounts would stall auth middleware — every unauthenticated request would trigger an increasingly slow chain scan.

**Rule:** Any loop that fetches from an external system (chain, database, API) must have a hard page/iteration cap with a warning log, separate from any user-supplied `limit`.

---

## 7. Input validation belongs at the outermost boundary, not the innermost

The sidecar had no format validation on Sui addresses or object IDs. Malformed input would propagate through several layers of SDK calls before producing an unhelpful error deep in the stack.

**Rule:** Validate the shape and format of inputs at the point of entry — the HTTP handler. Don't rely on downstream libraries to reject bad input with useful errors; they often don't.

---

## 8. CORS "permissive" is a configuration decision, not a default

`CorsLayer::permissive()` is fine during development. Shipping it to production means any website can make credentialed requests to the API from a user's browser. For a web3 API where authentication is signature-based (not cookie-based), the practical risk is lower — but it's still a configuration that should be an explicit decision documented in env vars, not a default that just stayed in place.

**Rule:** Every security-relevant default should either fail-loud if not configured (e.g., SIDECAR_SECRET) or log a startup warning so operators know what posture they're running in (e.g., CORS_ORIGINS).

---

## 9. The "it's the server's own key" distinction matters for SEAL decrypt

SEAL decryption requires the server's own Sui private key (`SERVER_SUI_PRIVATE_KEY`) sent to the sidecar — this is different from the Walrus upload key. This one is unavoidable given the architecture: the server owns the key, needs the sidecar's SEAL SDK to do the decryption, so it must send the key. The mitigation is:
- Sidecar is localhost-only + shared-secret protected
- Key is the server's *own* identity key, not a user's key

The Walrus upload key was different: the sidecar could own it directly. That's what made sending it per-request wrong.

**Rule:** When a key must cross a process boundary, verify there's no alternative (e.g., move the operation into the key-owning process). When there genuinely isn't, ensure the channel has explicit auth and the exposure is documented.

---

## 10. Weight every endpoint in a rate limiter, then review it

The batch endpoint (`/api/remember/batch`, up to 100 items) was in the weight table at 50 — correctly. But this is easy to miss when adding new endpoints. A new endpoint with default weight=1 that processes 100 database rows is effectively unmetered.

**Rule:** Rate limit weights are not optional. Every new endpoint needs a weight assigned based on actual resource cost, reviewed at the same time the endpoint is added — not retrofitted later.
