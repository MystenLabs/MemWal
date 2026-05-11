# MemWal MCP Package — Single npm Package with Auto-Login

**Date**: 2026-05-11
**Status**: Design / ready for tech lead review
**Branch suggestion**: `feat/memwal-mcp-package`
**Predecessor**: `feat/mcp-server-sidecar` — server-side MCP routes already done

---

## End-user flow (the contract we're shipping)

```
1. Cài MCP config 1 lần (paste 5 dòng JSON) vào ~/.cursor/mcp.json
   hoặc claude_desktop_config.json hoặc tương tự.

2. First time + after any "revoke key" trên dashboard:
     $ npx -y @memwal/mcp login
     → trình duyệt tự pop up → click "Connect Wallet" → sign tx
     → terminal show "✅ Login complete" → exit

3. MCP client (Cursor / Claude Desktop / Antigravity / Claude Code)
   đã ready. Chat bình thường — 4 tools memwal_* sẵn sàng.

4. Mất key / revoke from dashboard:
     - Run lại `npx -y @memwal/mcp login`
     - Restart MCP client để pick up creds mới
```

Đây là Phase B (blocking login) experience. Phase B.5 (OAuth-style
defer login, see below) sẽ remove bước 4's "restart MCP client" —
user stay trong chat client, browser tự pop up khi tool call đầu fail.

## TL;DR (technical)

Build a single npm package `@memwal/mcp` (per tech-lead Henry, Slack 2026-05-11) that end users add to their MCP client (Cursor/Claude Desktop/Antigravity/Claude Code) as:

```json
{
  "mcpServers": {
    "memwal": {
      "command": "npx",
      "args": ["-y", "@memwal/mcp"]
    }
  }
}
```

No `headers`, no API key, no hex string anywhere in user-facing config. The package handles login (browser-based Sui wallet flow) on first run, saves creds to `~/.memwal/credentials.json`, and bridges stdio MCP ↔ remote SSE relayer (`relayer.memwal.ai/api/mcp/sse`).

Pattern matches **Linear MCP, Figma MCP, Notion MCP** — standard "consumer-grade" MCP UX.

---

## Why this

### Current state (manual paste hex — BAD UX)

```json
{
  "mcpServers": {
    "memwal": {
      "url": "https://relayer.memwal.ai/api/mcp/sse",
      "headers": {
        "Authorization": "Bearer 21b423e7...64hex...",
        "X-MemWal-Account-Id": "0x8a1121b8...64hex..."
      }
    }
  }
}
```

User has to:
1. Open dashboard, click "Generate delegate key"
2. Copy 64-hex private key (must not miss a character)
3. Copy 66-char account ID
4. Find `~/.cursor/mcp.json` (or whatever client config is)
5. Paste both into JSON without breaking syntax
6. Save + reload client

→ **6 manual steps + 2 copy-pastes + secrets visible in plaintext config**. Only techies will do it. Non-starter for mass adoption.

### Proposed state (Walcraft-CLI + Linear-MCP hybrid)

```json
{
  "mcpServers": {
    "memwal": {
      "command": "npx",
      "args": ["-y", "@memwal/mcp"]
    }
  }
}
```

User flow:
1. Paste 5-line snippet into MCP client config
2. Reload client
3. First tool call triggers browser → user clicks "Connect Wallet" → wallet signs `add_delegate_key` tx → done
4. From now on, MCP just works. User never sees a hex key.

3 steps, 1 wallet sign, 0 hex copy-paste. **Standard MCP-consumer UX**.

---

## Architecture

### High level

```
                ┌─────────────────────────────────────────────────────┐
                │   MCP Client (Cursor / Claude Desktop / etc.)       │
                │                                                     │
                │   spawn: npx -y @memwal/mcp     (stdio)             │
                └─────────────────────────────────────────────────────┘
                                       │ stdio (JSON-RPC)
                                       ▼
        ┌────────────────────────────────────────────────────────────┐
        │            @memwal/mcp  (single Node binary)               │
        │                                                            │
        │   index.ts:                                                │
        │     1. Load ~/.memwal/credentials.json                     │
        │     2. If missing → loginFlow() (open browser, wait)       │
        │     3. startStdioBridge(creds)                             │
        │                                                            │
        │   auth.ts:        read/write credentials.json              │
        │   login.ts:       local HTTP listener + browser open       │
        │   bridge.ts:      stdio ↔ remote SSE                       │
        └────────────────────────────────────────────────────────────┘
                                       │ HTTPS + SSE
                                       │ Bearer auto-injected from creds
                                       ▼
              ┌────────────────────────────────────────────────┐
              │  relayer.memwal.ai/api/mcp/sse                 │
              │  (feat/mcp-server-sidecar — already built)     │
              └────────────────────────────────────────────────┘
```

### Login flow (first run only)

Port Walcraft's `cli/login.ts` flow exactly:

```
1. @memwal/mcp boots → checks ~/.memwal/credentials.json
2. Not found:
   a. Generate Ed25519 keypair LOCAL → { delegatePrivateKey, delegatePublicKey }
   b. Start HTTP listener on random localhost port (e.g. 17463)
   c. Open browser → https://memwal.ai/connect/mcp?port=17463&publicKey=<hex>&label=<encodeURIComponent(client_name)>
   d. Web page (built in apps/app):
      - Show consent: "MCP client wants permission: read/write your MemWal memory"
      - User clicks [Connect Sui Wallet]
      - dApp Kit popup → Slush/Suiet
      - User confirms → wallet signs add_delegate_key(account, pubkey, label) tx
      - Sui PTB broadcast + confirm
      - Web POSTs back to localhost:17463/callback with:
          { accountId, walletAddress, packageId, txDigest }
   e. MCP receives callback, writes ~/.memwal/credentials.json:
      {
        "delegatePrivateKey": "21b423e7...",
        "delegatePublicKeyHex": "0197c985...",
        "delegateAddress": "0x9083163a...",
        "walletAddress": "0xdead...",
        "accountId": "0x8a1121b8...",
        "packageId": "0xcf6ad755...",
        "relayerUrl": "https://relayer.memwal.ai",
        "createdAt": "2026-05-11T...",
        "label": "Cursor MCP",
        "version": 1
      }
   f. Browser tab shows "✅ Connected — close this tab"
   g. MCP shuts down login listener, continues to bridge mode
3. ~/.memwal/credentials.json exists:
   → skip login → straight to bridge mode
```

### Bridge mode (every run after login)

```
1. MCP package reads stdin (JSON-RPC from MCP client)
2. Opens persistent SSE connection to creds.relayerUrl + /api/mcp/sse with:
     Authorization: Bearer <creds.delegatePrivateKey>
     X-MemWal-Account-Id: <creds.accountId>
3. Forwards stdio messages ↔ SSE events using mcp-remote-style logic
4. On 401 from server (key revoked): clear creds + relaunch login flow
```

This is essentially `mcp-remote` inlined into our package so user has zero extra dependencies + can customize error UX (e.g., re-login on revoke).

---

## Package structure

```
packages/mcp-client/                  ← new package, separate from existing packages/mcp
├── package.json                       # @memwal/mcp v0.0.1
├── tsconfig.json
├── README.md                          # 30-line user-facing setup guide
├── bin/
│   └── memwal-mcp.mjs                 # #!/usr/bin/env node entry
└── src/
    ├── index.ts                       # boot + flow router
    ├── auth.ts                        # load/save credentials.json
    ├── login.ts                       # local listener + browser open
    ├── bridge.ts                      # stdio ↔ SSE forwarding
    ├── crypto.ts                      # Ed25519 keygen wrapper (noble)
    └── logger.ts                      # JSON stderr lines (sidecar pattern)
```

Bundle with `obuild` or `tsup` to single `dist/cli.mjs` so `npx -y @memwal/mcp` works without resolving deep deps.

### `package.json` key fields

```json
{
  "name": "@memwal/mcp",
  "version": "0.0.1",
  "type": "module",
  "bin": { "memwal-mcp": "./dist/cli.mjs" },
  "files": ["dist"],
  "dependencies": {
    "@modelcontextprotocol/sdk": "^1.29.0",
    "@noble/ed25519": "^2.3.0",
    "@noble/hashes": "^2.0.0",
    "open": "^10.0.0"
  }
}
```

`open` is a tiny cross-platform `open URL in default browser` helper.

---

## Web `/connect/mcp` page (new route in `apps/app`)

```
URL pattern:
  https://memwal.ai/connect/mcp?port=17463&publicKey=<hex>&label=<encoded>

Page sections:
  1. App identity header
  2. Permission preview:
       ✓ Read your memories
       ✓ Save new memories
       ✓ Analyze + extract facts
       ✓ Re-index from Walrus
  3. Connected wallet status (auto-populates if already logged in)
  4. [Connect Sui Wallet] button (dApp Kit)
  5. On click:
     a. Wallet popup → sign add_delegate_key(account, publicKey, label) tx
     b. Wait for tx confirm + indexer sync
     c. POST to http://localhost:${port}/callback with:
          { accountId, walletAddress, packageId, txDigest, label }
     d. Show success → "MCP connected. You can close this tab."
  6. Error states:
     - Wallet not connected
     - User has no MemWalAccount yet → CTA "Create account first" → /dashboard
     - Tx rejected
     - localhost callback failed (CORS / port mismatch)
```

Files touched:
- `apps/app/src/pages/ConnectMcp.tsx` — new page
- `apps/app/src/App.tsx` — route registration

---

## Existing dashboard "Connect to AI clients" panel

Same UX flow as above, but **triggered from dashboard side** (in case user wants to setup multiple clients at once):

```
Dashboard / Settings / MCP Clients
─────────────────────────────────────
  Connected:
    [icon] Cursor    │ created 2 days ago  │ [Revoke]
    [icon] Claude    │ created 1 hour ago  │ [Revoke]

  + Connect new client:
    [ Cursor ] [ Claude Desktop ] [ Antigravity ] [ Claude Code ]
    or
    [ Copy snippet to paste manually ]
```

Click [Cursor] → opens helper page with detailed install steps + 1-click "Open Cursor with config" if Cursor's deep-link scheme supports it.

This is a separate UX track from the auto-login. Defer to Phase D.

---

## Phases

### Phase A — `@memwal/mcp` package (1 sprint, 1 dev) — ✅ DONE

- [x] Create `packages/mcp/` (renamed from earlier `packages/mcp-client/`)
- [x] Implement `auth.ts` (load/save credentials.json with permission 0600)
- [x] Implement `crypto.ts` (Ed25519 keygen via @noble/ed25519)
- [x] Implement `login.ts`:
  - [x] HTTP listener on random port
  - [x] Open browser via `open` package
  - [x] Parse `/callback` POST body
  - [x] Timeout (5 min default)
- [x] Implement `bridge.ts`:
  - [x] stdio JSON-RPC reader/writer
  - [x] Persistent SSE connection (with auto-reconnect on drop)
  - [x] Forward POST `/api/mcp/messages` to relayer
  - [x] Inject Bearer + X-MemWal-Account-Id headers
  - [x] On 401: clear creds + surface clear error
  - [x] On stale-session 404 after reconnect: refresh sessionId + retry
- [x] `index.ts` orchestrator
  - [x] CLI flags: `--local`, `--dev`, `--staging`, `--prod`, `--relayer`, `--web-url`, `--logout`, `login`
  - [x] TTY vs spawn detection (TTY exits after login; spawn falls through to bridge)
  - [x] Spawn + no-creds: print friendly help + exit 2 (instead of blocking 30s+)
- [ ] Unit tests for auth + bridge (deferred to dedicated test ticket)
- [ ] Bundle to single dist file (tsc output works as-is for now)

### Phase B — Web `/connect/mcp` page (3 days)

- [ ] `apps/app/src/pages/ConnectMcp.tsx`
- [ ] Wire to existing dApp Kit + add_delegate_key flow (already exists in dashboard)
- [ ] Handle callback POST to localhost
- [ ] Error states + retry UI

### Phase C — Publish + docs (2 days)

- [ ] Publish `@memwal/mcp@0.0.1` to npm (workflow in `.github/workflows/release-mcp.yml`)
- [ ] Smoke test through all 4 clients (Cursor / Claude Desktop / Antigravity / Claude Code)
- [ ] Update `plans/2026-05-11-mcp-client-testing-guide.md` to show new install method
- [ ] Add user-facing setup video / GIF in dashboard

### Phase B.5 — OAuth-style defer login (3-5 hours, optional polish)

Currently Phase B ships **blocking login at boot**: when the MCP client
(Cursor / Claude Desktop / Antigravity) spawns the bridge and
`~/.memwal/credentials.json` is missing, the bridge prints a friendly
help message to stderr and exits with code 2. The user then runs
`npx -y @memwal/mcp login` once in a terminal and restarts the MCP
client.

That's pragmatic but not the smoothest UX. **Linear MCP, Figma MCP, and
Notion MCP** all let the user stay inside the chat client — they
implement MCP's OAuth flow so the MCP client's host (Cursor / Claude
Desktop) drives the browser dance natively.

Phase B.5 brings MemWal in line:

1. Bridge responds OK to `initialize` even with no creds.
2. `tools/list` returns the full 4-tool list (so the agent can plan).
3. First `tools/call` → bridge intercepts, sees no creds, returns an
   MCP error envelope including a one-shot login URL.
4. MCP client's host detects the auth-required error, opens the URL in
   the user's browser, waits for the callback, hands the bridge the
   fresh credentials over a side-channel (env var update / file watch
   on `~/.memwal/credentials.json`).
5. Client retries the tool call → success.

Spec references:
- OAuth 2.1 IETF DRAFT
- RFC 8414 — Authorization Server Metadata
- RFC 9728 — Protected Resource Metadata
- MCP Authorization spec (modelcontextprotocol.io/specification/.../authorization)

Implementation notes:
- Bridge keeps a watcher on `~/.memwal/credentials.json` so it picks
  up the file written by the parallel `login` flow without restart.
- Login URL becomes part of the error envelope's `details` field.
- First-call retry needs to be transparent — host clients differ in
  how they retry, so we should test against Cursor + Claude Desktop +
  Claude Code + Antigravity individually.

Effort: 3-5 hours plus 1 day of cross-client QA.

### Phase D — Dashboard "Connect to AI clients" UI (1 sprint, optional)

- [ ] Multi-client panel in dashboard
- [ ] Detect installed clients via custom URL schemes (`cursor://`, `claude://` etc.) where possible
- [ ] Active-session list with [Revoke] buttons

### Phase E — Deprecate manual paste-hex (post-Phase A stable, ~1 month)

- [ ] Warn in docs that paste-hex is legacy
- [ ] Keep relayer backward-compat (still accepts Bearer hex) — never remove
- [ ] Add deprecation notice in dashboard's "Generate delegate key (raw)" UI

---

## Acceptance criteria

### Phase A done means

- [ ] `npx -y @memwal/mcp` in a fresh shell opens browser when no creds
- [ ] After wallet sign, creds saved to `~/.memwal/credentials.json` with 0600 permission
- [ ] Subsequent `npx -y @memwal/mcp` skips browser, opens SSE to relayer
- [ ] stdio MCP messages forward correctly: `initialize`, `tools/list`, `tools/call`
- [ ] On 401 (revoked key), package re-triggers login automatically
- [ ] Works on macOS + Linux + Windows (test all 3)
- [ ] Bundle <2 MB, no native deps

### Phase B done means

- [ ] `/connect/mcp?port=...&publicKey=...` page renders + connect wallet works
- [ ] add_delegate_key tx broadcasts + confirms
- [ ] callback POST to localhost succeeds
- [ ] Page shows clean success state with "close this tab" message

### End-to-end UX done means

- [ ] User opens fresh Cursor, no MemWal config
- [ ] Adds 5-line snippet to `~/.cursor/mcp.json`
- [ ] Reloads Cursor
- [ ] Chats "save: I prefer dark mode"
- [ ] Browser auto-opens to memwal.ai
- [ ] User signs once, browser shows success
- [ ] Cursor immediately runs `memwal_remember` tool
- [ ] Tool returns "Saved to MemWal."
- [ ] **From paste-snippet to first saved memory: < 60 seconds**

---

## Out of scope

- OAuth 2.1 / MCP spec compliance (separate ticket — see `plans/2026-05-11-memwal-positioning-vs-rag-critique.md` Path B)
- Cross-app permission scoping (read-only / write-only delegate keys) — server already supports, dashboard UX TBD
- Multi-user / org delegation flows
- macOS Keychain / Linux secret-service storage (Phase A uses plain JSON 0600; OS keychain in v2)

---

## Open questions for tech lead

1. **Package name**: `@memwal/mcp` (short, brand-aligned) vs `@mysten-incubation/memwal-mcp` (longer, consistent with current SDK package). Em prefer the short one for npx UX (typed by users into config files); brand maintained.

2. **Repository location**: new sibling package `packages/mcp-client/` vs subdir of `packages/mcp/` (renamed `server` + `client`)?

3. **Web route**: `/connect/mcp` vs `/login/mcp` vs `/dashboard/connect`? Em prefer `/connect/mcp` as it's the verb-noun the URL parameter naturally implies.

4. **Delegate key label**: store `"Cursor MCP"` etc. in `add_delegate_key` so user can identify which client a key belongs to in dashboard. Requires contract field — check if `account.move::add_delegate_key` already accepts a label string. If not → contract change ticket.

5. **Server quota per delegate**: should each MCP-issued delegate key have lower quota than a "main" delegate? Or all equal? Default to "all equal" for v1.

6. **OS keychain v2**: ticket for storing creds in OS keychain (macOS Keychain / Linux secret-service / Windows credential manager) instead of plain JSON. Important for security; defer to v2.

---

## Risk + mitigation

| Risk | Mitigation |
|---|---|
| Browser doesn't open (headless env, SSH session) | Fallback: print URL to stderr + ask user to open manually, accept callback as before |
| User has no MemWalAccount yet | Web page shows "Create account first" CTA → dashboard → return |
| localhost callback blocked by browser (HTTPS strict-mode) | Use port 17463 (Walcraft's choice — proven works); browser doesn't enforce HTTPS for `localhost` per spec |
| User's wallet rejects tx | Web page error UI + retry button |
| `npx` is slow first run | Pin `@memwal/mcp` to specific version in user snippet to enable npm cache reuse |
| Concurrent MCP processes spawned by Cursor | Use file lock on credentials.json during login; later processes wait |
| Revoked delegate key still cached in MCP | On 401 from relayer: clear creds + relogin (already in scope) |

---

## Reference implementations

- **Walcraft CLI login**: `https://github.com/CommandOSSLabs/walcraft/blob/dev/cli/src/login.ts` — port the listener + browser open pattern verbatim
- **mcp-remote** (npm): inline the stdio-↔-SSE bridge logic instead of taking it as a runtime dep
- **Linear MCP**: `npx @linear/mcp` — same install pattern, OAuth-based
- **Figma MCP**: `npx figma-developer-mcp` — token-based but same package layout

---

## Tracking

- This plan: `plans/2026-05-11-memwal-mcp-package-with-login.md`
- Linked tickets: TBD when filed
- Relayer-side MCP server: `feat/mcp-server-sidecar` (PR pending)
- Walrus-bump server fix: `chore/sidecar-bump-walrus-1.1.7` (separate ticket — see earlier plans)
- Playground UX fix: `fix/playground-remember-poll-status` (separate ticket — see `plans/2026-05-10-playground-remember-status-stuck-running.md`)
