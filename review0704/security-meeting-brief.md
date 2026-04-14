# MemWal Security Meeting Brief
**Date:** 2026-04-08  
**Based on:** Security Audit Report — Commit `5bb1669`, branch `dev`  
**Total findings:** 77 (1 Critical · 13 High · 22 Medium · 34 Low · 7 Info)

---

## Executive Summary

MemWal has a **solid cryptographic foundation** (Ed25519 signing, parameterized SQL, well-structured Move contract), but it is **substantially undermined** by several architectural decisions that expose private key material at multiple points. Combined, these issues form 3 attack chains capable of **full account takeover, budget drain, or decryption of all user memories** — without ever needing to break the encryption layer directly.

---

## 3 Most Dangerous Attack Chains

### Chain A — Full Account Takeover
```
XSS → localStorage private key → x-delegate-key header → read/write/corrupt all memories + drain gas
```
1. XSS payload in browser reads the delegate private key from `localStorage` (stored in plaintext)
2. That same key is sent on **every HTTP request** via the `x-delegate-key` header
3. Attacker with the key can sign arbitrary requests, read/write/corrupt all user memories — **indefinitely** until revoked on-chain

### Chain B — Resource Exhaustion
```
Kill Redis → rate limiter fails open → spam /analyze → drain SUI + OpenAI budget uncapped
```
1. Redis is killed (port 6379 exposed, no auth) → rate limiter **automatically allows all requests through**
2. Spam `/api/analyze` → LLM extracts unbounded facts per request → N × (embedding + SEAL encrypt + Walrus upload)
3. 60 req/min × 50 facts = **3,000 Walrus uploads/min**, draining the entire SUI wallet + Enoki budget

### Chain C — Decrypt All User Memories
```
Access sidecar → intercept delegate keys → impersonate SEAL server (threshold=1) → plaintext everything
```
1. Sidecar binds `0.0.0.0:9000`, no auth → any host on the network can reach it directly
2. Every `/seal/decrypt` request carries the delegate private key in the request body
3. `verifyKeyServers: false` + `threshold: 1` → one rogue SEAL server is sufficient to decrypt everything

---

## P0 — Production Blockers (Fix Before Any Deployment)

### 🔴 CRIT-1 — Raw Private Key Transmitted on Every HTTP Request
| | |
|---|---|
| **File** | `packages/sdk/src/memwal.ts:314` |
| **Issue** | The `MemWal` SDK sends the raw Ed25519 delegate private key in the `x-delegate-key` header on every authenticated request. The key is also forwarded in the body of every `/seal/decrypt` call to the sidecar. |
| **Why critical** | Anyone with access to server logs, reverse proxy logs, WAF logs, or a network capture obtains the key. `MemWalManual` already proves this is architecturally unnecessary. `AuthInfo` also derives `Debug`, so any trace log that formats it will print the raw key. |
| **Fix** | Remove line 314 from `signedRequest()`. Push SEAL decryption to the client following the `MemWalManual` pattern. Implement a manual `Debug` for `AuthInfo` that redacts sensitive fields. |
| **Effort** | High — requires SDK + server SEAL flow redesign |

delegate -> can decrypt 
but can revolt 

need to do: change privite key to another key (another layer in the mid)
ref: https://docs.turnkey.com/home

---

### 🔴 HIGH-1 — Sidecar Fully Exposed with Zero Authentication
| | |
|---|---|
| **File** | `services/server/scripts/sidecar-server.ts:811` |
| **Issue** | Binds to `0.0.0.0:9000`, wildcard CORS `*`, **no authentication** on all endpoints: `/seal/encrypt`, `/seal/decrypt`, `/walrus/upload`, `/sponsor`, etc. |
| **Why critical** | Any host on the network can call it directly. Combined with CRIT-1, a compromised sidecar passively collects delegate keys from every decrypt operation. |
| **Fix** | Change to `app.listen(PORT, "127.0.0.1")` · Remove CORS middleware entirely · Add `X-Sidecar-Secret` header validation middleware |
| **Effort** | Low — a few lines of code |

---

### 🔴 HIGH-2 — Rate Limiter Fails Open When Redis is Unavailable
| | |
|---|---|
| **File** | `services/server/src/rate_limit.rs:240-281` |
| **Issue** | All 3 rate limit windows catch Redis errors and unconditionally allow requests through (`Ok(())`). Redis is also exposed on `0.0.0.0:6379` with no auth — an attacker can deliberately kill Redis to trigger this. |
| **Fix** | Return `429 Too Many Requests` instead of `Ok(())` on Redis error. Bind Redis to `127.0.0.1`. |
| **Effort** | Low |

---

### 🔴 HIGH-3 — `/analyze` Endpoint Has Unbounded Resource Consumption
| | |
|---|---|
| **File** | `services/server/src/routes.rs:391-597` |
| **Issue** | No cap on the number of facts the LLM can return. All facts are processed concurrently via `join_all` with no concurrency bound. Rate limit cost weight is a fixed 10 regardless of actual fact count — making it meaningless as a bound. |
| **Fix** | Add `facts.truncate(20)` after LLM response parsing · Replace `join_all` with `buffer_unordered(5)` |
| **Effort** | Low |

---

### 🔴 HIGH-4 — `/sponsor` Endpoints are Public, Unauthenticated, Unrate-Limited
| | |
|---|---|
| **File** | `services/server/src/routes.rs:1011-1060` |
| **Issue** | `POST /sponsor` and `/sponsor/execute` require no authentication. Any caller can sponsor arbitrary Sui transactions, draining the project's Enoki gas sponsorship budget. |
| **Fix** | Move both endpoints behind the existing Ed25519 auth middleware · Add rate limiting with a low cost weight · Add 16KB body size limit |
| **Effort** | Low |

---

### 🔴 HIGH-5 — SEAL Key Server Verification Disabled in All 4 Client Instances
| | |
|---|---|
| **Files** | `sidecar-server.ts:67` · `seal-encrypt.ts:96` · `seal-decrypt.ts:117` · `manual.ts:200` |
| **Issue** | `verifyKeyServers: false` is set on every `SealClient`. Combined with `threshold: 1`, a single rogue SEAL server (via DNS poisoning or BGP hijack) is enough to obtain all key material needed to encrypt or decrypt any memory. |
| **Fix** | Set `verifyKeyServers: true` in all 4 files — **one line change per file**. |
| **Effort** | Trivial |

---

### 🔴 HIGH-6 — Server Wallet Private Keys Transmitted Per-Request to Sidecar
| | |
|---|---|
| **File** | `services/server/src/walrus.rs:80-81` |
| **Issue** | The raw private key string is sent in the HTTP request body to the sidecar on every Walrus upload. The key lives in `req.body` and is accessible via heap dumps for the duration of the request. |
| **Fix** | Load `SERVER_SUI_PRIVATE_KEYS` from environment variables at sidecar startup · Pass a **key index** in the request body, never the raw key |
| **Effort** | Low–Medium |

---

### 🔴 HIGH-8 — Private Key Persisted in `localStorage`
| | |
|---|---|
| **Files** | `apps/app/src/App.tsx:71-85` · `apps/chatbot/components/chat.tsx:93-114` |
| **Issue** | The delegate private key is stored in plaintext in `localStorage` in both frontend apps. Any XSS, malicious browser extension, or injected third-party script on the same origin can read it. |
| **Fix** | Minimum: migrate to `sessionStorage` (cleared on tab close) · Correct solution: Web Crypto API non-extractable `CryptoKey` objects |
| **Effort** | Low–Medium |

---

## What's Already Working Well (Keep These)

| Strength | Detail |
|---|---|
| ✅ SQL Injection | 100% parameterized queries via sqlx — zero dynamic SQL construction found |
| ✅ Ed25519 Verification | Uses `ed25519_dalek::verify()` — constant-time, no timing side-channel |
| ✅ Data Isolation | All queries filter by `(owner, namespace)` — owner is derived from on-chain verification, cannot be forged |
| ✅ Move Contract Auth | All 15 authorization-relevant boolean computations flow into `assert!` — silent bypass antipattern is absent |
| ✅ Move Reentrancy | Not applicable — prevented by Move's linear type system by design |
| ✅ SEAL Integration | Native, on-chain enforced encryption — correct architecture, just needs `verifyKeyServers: true` |

---

## Architectural Decisions to Resolve Today

### CRIT-1 — Choose a remediation approach:

| Option | Description | Trade-off |
|---|---|---|
| **(A) Full migration** | Deprecate `MemWal` class entirely, unify on `MemWalManual` pattern | Breaking change — cleanest long-term |
| **(B) Hybrid ECDH** | Keep server-side decrypt but replace raw key transmission with an ephemeral session key via ECDH | No breaking change — more complex to implement |
| **(C) Phased** | Remove the key header immediately (small breaking change), defer SDK architectural redesign | Fastest path to unblock production |

### Smart Contract changes — batch these together:
MED-15, MED-16, LOW-19 → LOW-21 all require a contract upgrade and redeployment. Should be batched into a single upgrade.

### SEAL Threshold:
Currently hardcoded to `threshold: 1`. Increasing to 2 is a one-way operational change — confirm that ≥2 key servers are available before applying.

---

## Proposed Remediation Roadmap

| Phase | Scope | Effort | Priority |
|---|---|---|---|
| **P0** | CRIT-1, HIGH-1 through HIGH-8 — 8 production blockers | 3–5 days | Start immediately |
| **P1** | HIGH-7 cleanup, HIGH-9 through HIGH-13, MED-1/2 | 3–4 days | After P0 |
| **P2** | All remaining MEDIUM — concurrency, input validation, infrastructure | 3–4 days | After P1 |
| **P3** | All LOW findings | 2–3 days | After P2 |
| **P4** | INFO items + missing test coverage | 1 day | After P3 |

**Total estimated effort: ~12–17 days to clear all 77 findings.**

---

*Source: MemWal Security Audit Report — Commit `5bb1669`, 2026-04-03*  
*Methodology: Automated static analysis across 599 files + Manual code review (3 phases)*
