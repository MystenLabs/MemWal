# MemWal MCP — Client Testing Guide (local dev)

**Date**: 2026-05-11
**Status**: Local server running on `http://127.0.0.1:3005`
**Server PID**: `16187`  •  **Sidecar PID**: (auto-spawned, port 9005)

---

## 0. Credentials (use the same for every client below)

```
MEMWAL_KEY        = <copy from packages/python-sdk-memwal/examples/.env>
MEMWAL_ACCOUNT_ID = 0x8a1121b8f95d79e68bd07efaf71689ce6fd832b369cdb1b2a943ec7beb822392
LOCAL_MCP_URL     = http://127.0.0.1:3005/api/mcp/sse
```

`MEMWAL_KEY` = 64-hex Ed25519 delegate private key. Get it: `cat packages/python-sdk-memwal/examples/.env | grep MEMWAL_KEY`. Treat it like a password — never commit, never paste in public.

After deploy: replace `LOCAL_MCP_URL` with `https://relayer.dev.memwal.ai/api/mcp/sse` or `https://relayer.memwal.ai/api/mcp/sse`.

---

## 1. Quick verify (CLI — no GUI needed)

Before configuring any client, smoke-test the server reachable on your machine:

```bash
# Health (no auth needed)
curl http://127.0.0.1:3005/health
# → {"status":"ok","version":"0.1.0"}

# MCP SSE without auth → 401 + WWW-Authenticate
curl -i http://127.0.0.1:3005/api/mcp/sse
# → HTTP 401, WWW-Authenticate: Bearer realm="memwal", error="invalid_token"

# Bridge through mcp-remote (same flow Claude Desktop uses)
export MEMWAL_KEY=...   # paste real key
export MEMWAL_ACCOUNT_ID=0x8a1121b8...
echo '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' | \
  npx -y mcp-remote@latest http://127.0.0.1:3005/api/mcp/sse \
    --header "Authorization:Bearer ${MEMWAL_KEY}" \
    --header "X-MemWal-Account-Id:${MEMWAL_ACCOUNT_ID}"
# → JSON-RPC response listing 4 tools: memwal_remember, memwal_recall,
#   memwal_analyze, memwal_restore
```

If all three pass, **the server side is fine**. Any failure in a GUI client below is config-side.

---

## 2. **Cursor**  (native SSE, easiest)

Cursor supports remote SSE MCP servers directly — no bridge needed.

### Config path
- **Per-project**: `<project-root>/.cursor/mcp.json`
- **Global**: `~/.cursor/mcp.json`

### Config

```json
{
  "mcpServers": {
    "memwal-local": {
      "url": "http://127.0.0.1:3005/api/mcp/sse",
      "headers": {
        "Authorization": "Bearer PASTE_MEMWAL_KEY_HERE",
        "X-MemWal-Account-Id": "0x8a1121b8f95d79e68bd07efaf71689ce6fd832b369cdb1b2a943ec7beb822392"
      }
    }
  }
}
```

### Verify
1. **Settings → Features → MCP** → "memwal-local" should show 🟢 connected with 4 tools listed
2. Open chat (`Cmd+L`), in the agent panel run:
   ```
   Use the memwal_recall tool to find any memory about coffee.
   ```
3. Agent should call `memwal_recall` and return decrypted memories

### Troubleshoot
- "Failed to connect" → check `curl http://127.0.0.1:3005/health` first
- 401 → `MEMWAL_KEY` wrong or wrong format (must be 64 hex, no `0x` prefix)
- Cursor doesn't see the tools → toggle the server off+on in Settings → MCP

---

## 3. **Claude Desktop**  (needs mcp-remote bridge — stdio only)

Claude Desktop only speaks stdio MCP. Bridge remote SSE → local stdio using `mcp-remote`.

### Config path
- **macOS**: `~/Library/Application Support/Claude/claude_desktop_config.json`
- **Windows**: `%APPDATA%\Claude\claude_desktop_config.json`
- **Linux**: `~/.config/Claude/claude_desktop_config.json`

### Config

```json
{
  "mcpServers": {
    "memwal-local": {
      "command": "npx",
      "args": [
        "-y",
        "mcp-remote@latest",
        "http://127.0.0.1:3005/api/mcp/sse",
        "--header", "Authorization:Bearer ${MEMWAL_KEY}",
        "--header", "X-MemWal-Account-Id:${MEMWAL_ACCOUNT_ID}"
      ],
      "env": {
        "MEMWAL_KEY": "PASTE_64HEX_HERE",
        "MEMWAL_ACCOUNT_ID": "0x8a1121b8f95d79e68bd07efaf71689ce6fd832b369cdb1b2a943ec7beb822392"
      }
    }
  }
}
```

Why `${...}`? `mcp-remote`'s `--header` flag does NOT do its own env substitution but Claude Desktop's launcher does. If your version doesn't substitute, inline the values directly in the `--header` strings.

### Verify
1. **Fully quit + reopen Claude Desktop** (Cmd+Q, not just close window — daemon caches config)
2. In a chat, look for the 🔌 hammer icon at bottom of input → tools list should include `memwal_remember` ... `memwal_restore`
3. Test:
   ```
   Use the memwal_remember tool to save: "I prefer Vietnamese coffee over Western coffee"
   ```
4. After ~20s, Claude Desktop shows the tool call result with `blob_id=...`

### Troubleshoot
- No hammer icon → check `~/Library/Logs/Claude/mcp.log` for spawn errors
- "Cannot find module mcp-remote" → install once: `npm install -g mcp-remote` then change `"npx", "-y", "mcp-remote"` → `"mcp-remote"`
- "Spawn npx ENOENT" → set PATH in config: add `"PATH": "/opt/homebrew/bin:/usr/bin:/bin"` to `env`

---

## 4. **Antigravity** (Google's Gemini IDE — Nov 2025)

Antigravity uses MCP for agent tool access. Config format mirrors Cursor's.

### Config path
- **macOS**: `~/Library/Application Support/Antigravity/mcp.json`  
  (also accessible via Settings → Extensions → MCP)
- **Windows**: `%APPDATA%\Antigravity\mcp.json`
- **Linux**: `~/.config/Antigravity/mcp.json`

### Config (SSE — preferred, direct)

```json
{
  "mcpServers": {
    "memwal-local": {
      "transport": "sse",
      "url": "http://127.0.0.1:3005/api/mcp/sse",
      "headers": {
        "Authorization": "Bearer PASTE_MEMWAL_KEY_HERE",
        "X-MemWal-Account-Id": "0x8a1121b8f95d79e68bd07efaf71689ce6fd832b369cdb1b2a943ec7beb822392"
      }
    }
  }
}
```

### Verify
1. Restart Antigravity
2. Settings → Extensions → MCP → "memwal-local" status
3. In agent chat: `@memwal_recall query: "anything you remember about me"`

### Notes
- Antigravity is Gemini-based; the agent will call memwal_* tools the same way Claude does
- If Antigravity ships a different schema, try Cursor's format as fallback (both are common)

---

## 5. **Claude Code**  (CLI tool)

### Two ways to add

**A) CLI command (per-project)**:
```bash
cd /your/project
claude mcp add memwal \
  --transport sse \
  --url http://127.0.0.1:3005/api/mcp/sse \
  --header "Authorization:Bearer ${MEMWAL_KEY}" \
  --header "X-MemWal-Account-Id:0x8a1121b8f95d79e68bd07efaf71689ce6fd832b369cdb1b2a943ec7beb822392"
```

**B) `.mcp.json` checked into repo**:
```json
{
  "mcpServers": {
    "memwal-local": {
      "type": "sse",
      "url": "http://127.0.0.1:3005/api/mcp/sse",
      "headers": {
        "Authorization": "Bearer PASTE_MEMWAL_KEY_HERE",
        "X-MemWal-Account-Id": "0x8a1121b8f95d79e68bd07efaf71689ce6fd832b369cdb1b2a943ec7beb822392"
      }
    }
  }
}
```

### Verify
```bash
claude
# → in REPL:
/mcp
# → lists memwal-local with 4 tools
# Then ask agent:
> remember that I work in Ho Chi Minh City
# → agent calls memwal_remember tool
```

### User-wide config (alternative)
`~/.claude.json` — same schema as `.mcp.json` but applies to all sessions.

---

## 6. **Cline** (VS Code extension)

### Config path
- Open Cline panel → ⋯ menu → "MCP Servers" → Edit Settings
- Or directly: `~/Library/Application Support/Code/User/globalStorage/saoudrizwan.claude-dev/settings/cline_mcp_settings.json`

### Config

```json
{
  "mcpServers": {
    "memwal-local": {
      "url": "http://127.0.0.1:3005/api/mcp/sse",
      "headers": {
        "Authorization": "Bearer PASTE_MEMWAL_KEY_HERE",
        "X-MemWal-Account-Id": "0x8a1121b8f95d79e68bd07efaf71689ce6fd832b369cdb1b2a943ec7beb822392"
      },
      "disabled": false,
      "autoApprove": ["memwal_recall"]
    }
  }
}
```

`autoApprove` skips confirmation for read-only tools. Don't auto-approve write tools.

### Verify
- Reload Cline window
- MCP panel shows "memwal-local" green
- Type: "what do you remember about me?" → Cline calls memwal_recall

---

## 7. **Windsurf** (Codeium IDE)

### Config path
- Settings → Cascade → MCP → "View raw config"
- Or: `~/.codeium/windsurf/mcp_config.json`

### Config

```json
{
  "mcpServers": {
    "memwal-local": {
      "serverUrl": "http://127.0.0.1:3005/api/mcp/sse",
      "headers": {
        "Authorization": "Bearer PASTE_MEMWAL_KEY_HERE",
        "X-MemWal-Account-Id": "0x8a1121b8f95d79e68bd07efaf71689ce6fd832b369cdb1b2a943ec7beb822392"
      }
    }
  }
}
```

### Verify
- Reload Windsurf
- Cascade chat → `/mcp` → status check
- Ask agent to recall memory

---

## 8. **Continue.dev** (VS Code/JetBrains extension)

### Config path
- `~/.continue/config.yaml`

### Config (yaml, not json)

```yaml
mcpServers:
  - name: memwal-local
    url: http://127.0.0.1:3005/api/mcp/sse
    requestOptions:
      headers:
        Authorization: "Bearer PASTE_MEMWAL_KEY_HERE"
        X-MemWal-Account-Id: "0x8a1121b8f95d79e68bd07efaf71689ce6fd832b369cdb1b2a943ec7beb822392"
```

---

## 9. **Zed editor** (Anthropic context-server protocol — close to MCP)

Zed uses its own "context server" config (similar but not identical to MCP). For now skip — Zed's MCP support is experimental; use Cursor/Claude Desktop instead.

---

## 10. After local works → deploy & switch URL

Once configured for local, switching to production is **only changing the URL**:

```json
"url": "https://relayer.memwal.ai/api/mcp/sse"     // prod
"url": "https://relayer.dev.memwal.ai/api/mcp/sse" // dev (after this PR merges + deploys)
```

Everything else stays identical. The MCP server contract is stable.

---

## 11. End-user setup flow (post-deploy, real users)

This is the UX a user will get after we deploy `feat/mcp-server-sidecar`:

```
1. Go to dev.memwal.ai/dashboard → connect Sui wallet → create MemWalAccount
2. Dashboard generates a delegate key (Ed25519) — shown once, copyable
3. Dashboard's "Connect to AI clients" panel shows:
     [ Cursor ]  [ Claude Desktop ]  [ Antigravity ]  [ Claude Code ]
   → click their client, get a copy-paste-ready config snippet with key + account_id pre-filled
4. User pastes into their client → reload → 4 memwal_* tools appear
5. User types: "remember X" or "what do you know about me?" — done
```

That last "Connect to AI clients" panel is a follow-up dashboard ticket; the MCP server itself doesn't depend on it.

---

## 12. Common failure modes (across all clients)

| Symptom | Probable cause | Fix |
|---|---|---|
| `Failed to connect` / `ECONNREFUSED` | Local server not running, or production URL not deployed yet | `curl http://127.0.0.1:3005/health` |
| HTTP 401, `Missing Authorization: Bearer` | Header missing entirely from client config | Re-check headers section in config |
| HTTP 401, `Bearer token must be 64-char hex` | Key format wrong (has `0x` prefix, or wrong length) | Strip `0x`, must be exactly 64 hex chars |
| HTTP 401, `Missing X-MemWal-Account-Id` | Account ID header missing or wrong | Must be `0x` + 64 hex |
| Connects but no tools listed | Initialize handshake failed | Check client's MCP log; usually a JSON schema mismatch — open issue with client log |
| Tool call hangs >60s then errors | Walrus / Sui infra slow on testnet | Retry once; if persistent, check `relayer.memwal.ai/health` |
| Tool returns `isError` with "MemWal relayer error: ..." | Server-side rejection (auth, quota, validation) | Read the error message — usually self-explanatory (delegate key not registered, namespace too long, etc.) |

---

## 13. What server logs to watch

While testing, tail these on your machine:

```bash
# Rust relayer + MCP routes + sidecar combined
tail -f services/server/server.log | grep -i "mcp\|recall\|remember\|wallet-job"
```

Expected per-call pattern:
```
session.opened  sessionKey=delegate:0x...:...
recall: query="..." owner=0x...    ← SDK forwarded to relayer
recall complete: 3 results          ← relayer answered
                                    ← MCP transport pushes result back via SSE
```

---

## 14. Stop the local server when done

```bash
pkill -TERM -f memwal-server
# sidecar auto-stops via SIGTERM handler we added
```
