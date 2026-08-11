# MemWal MCP — Local Test Plan

Step-by-step plan to test the auto-memory work (agentic tools + bulk + health + per-editor plugin/MCP) on the **local testnet** before opening the PR. Check each box as you go.

> **Local note:** the standalone configs below point at your **local build** via
> `node /Users/uydev/code/MemWal/packages/mcp/dist/bin/memwal-mcp.js --local`
> (tests your local code, not the published npx package). The **shipped plugin
> `.mcp.json` is prod** (`npx -y @mysten-incubation/memwal-mcp`) — no `--local` in
> the committed file. It still reaches your **local relayer** because your saved
> creds (`~/.memwal/credentials.json`) point there. To force a local target by hand
> (e.g. fresh/prod creds), `export MEMWAL_SERVER_URL=http://127.0.0.1:8000` in the
> shell before launching the client — the prod bin reads it (`index.ts:116-117`),
> no need to edit the shipped file.

---

## 0. Prerequisites (do once)

- [ ] Relayer + sidecar running on local testnet, **restarted** so the sidecar loaded the new tools:
  ```bash
  cd services/server && cargo run          # Ctrl+C the old one first
  curl -s localhost:8000/health            # → 200
  ```
- [ ] Credentials present and on testnet: `~/.memwal/credentials.json` (relayerUrl = `http://127.0.0.1:8000`).
- [ ] MCP package built: `ls packages/mcp/dist/bin/memwal-mcp.js`.

**How to tell MemWal vs the editor's built-in memory** (use everywhere below):
- ✅ **MemWal** → the step shows `Called memwal…` with a **`blob_id`** + `namespace`.
- ❌ **Built-in** → shows `Recalled/wrote N memories` with **no blob_id**.

---

## 1. Tool layer (server-side — applies to every client)

Run these in any connected client (e.g. Claude Code `memwal-local`). They prove Layer 1 (agentic descriptions + new tools). Type the prompts **without** saying "memwal" or "remember".

| # | Action / prompt | Expect | OK? |
|---|---|---|---|
| 1 | `check Walrus Memory health` | Calls `memwal_health`, returns `status=ok version=…` in ~ms (not a slow recall) | [ ] |
| 2 | `I prefer pnpm and always use TypeScript strict mode.` | Agent calls `memwal_remember` on its own | [ ] |
| 3 | `A few things about me: I'm a backend dev in Vietnam, I'm allergic to peanuts, and I drink black coffee.` | Agent calls `memwal_remember_bulk` (one call, several facts) | [ ] |
| 4 | *(new chat)* `What do you remember about my preferences?` | Calls `memwal_recall` **once** (no redundant repeat searches), returns the facts | [ ] |
| 5 | Paste a short paragraph of mixed facts and ask to "save what's worth keeping" | Agent uses `memwal_analyze` (or `memwal_remember_bulk`) | [ ] |
| 6 | On a namespace with Walrus blobs but empty index: ask to recall → empty → then `memwal_restore <ns>` | After restore, recall returns results | [ ] |

---

## 1.5 Tool layer via MCP Inspector (no agent, no editor)

The official **MCP Inspector** connects straight to the stdio server, so you list/call tools yourself — no LLM agent, no editor, no tokens. Fastest way to verify Layer 1 (agentic descriptions + schemas) and the read path.

**Web UI** — Tools tab → pick a tool → fill the form → **Run** → see the raw JSON. Notifications tab shows server logs.
```bash
npx @modelcontextprotocol/inspector node /Users/uydev/code/MemWal/packages/mcp/dist/bin/memwal-mcp.js --local
# opens http://localhost:6274
```

**CLI mode** — scriptable smoke test:
```bash
BIN="/Users/uydev/code/MemWal/packages/mcp/dist/bin/memwal-mcp.js"
INSP="npx -y @modelcontextprotocol/inspector --cli node $BIN --local"

$INSP --method tools/list                                     # 6 tools w/ agentic descriptions
$INSP --method tools/call --tool-name memwal_health           # status=ok (~ms)
$INSP --method tools/call --tool-name memwal_recall --tool-arg query="coding preferences"
$INSP --method tools/call --tool-name memwal_remember --tool-arg text="I prefer pnpm"
```

- [ ] `tools/list` shows all 6 tools (`memwal_remember`, `_remember_bulk`, `_recall`, `_analyze`, `_restore`, `_health`) with the new proactive descriptions
- [ ] `memwal_health` returns `status=ok` instantly
- [ ] `memwal_recall` returns (read path — no on-chain write)

Notes:
- `tools/list`, `memwal_health`, `memwal_recall` return instantly — they don't write on-chain, so they work regardless of the Enoki/gas state.
- `memwal_remember` / `memwal_remember_bulk` still go through the on-chain write — they only complete once the relayer is up with `ENOKI_FALLBACK_TO_DIRECT_SIGN=true` (or Enoki testnet quota is available).
- For array args (`memwal_remember_bulk` → `facts`), use the **Web UI** form — it handles arrays cleanly.

---

## 2. Per-editor tests

### 2A. Claude Code — Plugin (hooks + "prefer MemWal" steer)

> Local target: the plugin uses the prod `npx` server, which reaches your **local**
> relayer via saved creds. If creds are missing or point at prod, launch Claude Code
> with `MEMWAL_SERVER_URL=http://127.0.0.1:8000` exported. (`npx` pulls the published
> bridge, but the bridge is a pure proxy — bulk/health/agentic descriptions all come
> from your local sidecar, so they still show up.)

- [ ] Remove the standalone server to avoid a duplicate `memwal`: `claude mcp remove memwal-local`
- [ ] In Claude Code: `/plugin marketplace add /Users/uydev/code/MemWal`
- [ ] In Claude Code: `/plugin install memwal@memwal-plugins`
- [ ] Restart Claude Code → `/mcp` shows **memwal: Connected**; tools include `memwal_remember_bulk` + `memwal_health`
- [ ] Type `I prefer pnpm and TypeScript strict mode.` → agent calls **`memwal_remember`** (NOT the built-in "wrote N memories") — this proves the hook steer
- [ ] Run the Section 1 prompts → all behave

### 2B. Claude Code — MCP-only (Layer 1 without hooks)

- [ ] `claude mcp add memwal-local -- node /Users/uydev/code/MemWal/packages/mcp/dist/bin/memwal-mcp.js --local`
- [ ] Restart Claude Code → run Section 1 prompts
- [ ] Note: no hook steer here; compare against 2A (the agent may lean on built-in memory more)

### 2C. Claude Desktop — MCP-only

- [ ] Edit `~/Library/Application Support/Claude/claude_desktop_config.json`, add:
  ```json
  {
    "mcpServers": {
      "memwal": {
        "command": "node",
        "args": ["/Users/uydev/code/MemWal/packages/mcp/dist/bin/memwal-mcp.js", "--local"]
      }
    }
  }
  ```
- [ ] **Cmd+Q** (full quit) and reopen Claude Desktop
- [ ] Ask `what MCP tools do you have available?` → see the `memwal_*` tools
- [ ] Run Section 1 prompts (Layer 1 only — no hooks on Claude Desktop)

### 2D. Codex — Plugin (hooks)

- [ ] Install hooks + MCP: `node packages/mcp/plugin/scripts/install_codex_hooks.mjs`
- [ ] Enable the flag in `~/.codex/config.toml`:
  ```toml
  [features]
  codex_hooks = true
  ```
- [ ] **For local testnet**, point the registered server at local — edit `[mcp_servers.memwal]` in `~/.codex/config.toml` to:
  ```toml
  [mcp_servers.memwal]
  command = "node"
  args = ["/Users/uydev/code/MemWal/packages/mcp/dist/bin/memwal-mcp.js", "--local"]
  ```
- [ ] Restart Codex → run Section 1 prompts; confirm hooks fire
- [ ] *(Unverified by me — report what you see.)*

### 2E. Codex — MCP-only

- [ ] In `~/.codex/config.toml` (no hooks):
  ```toml
  [mcp_servers.memwal]
  command = "node"
  args = ["/Users/uydev/code/MemWal/packages/mcp/dist/bin/memwal-mcp.js", "--local"]
  ```
- [ ] Restart Codex → run Section 1 prompts

### 2F. Cursor — MCP-only (+ optional plugin)

- [ ] Edit `~/.cursor/mcp.json`:
  ```json
  {
    "mcpServers": {
      "memwal": {
        "command": "node",
        "args": ["/Users/uydev/code/MemWal/packages/mcp/dist/bin/memwal-mcp.js", "--local"]
      }
    }
  }
  ```
- [ ] Restart Cursor → run Section 1 prompts
- [ ] *(Optional, unverified)* Plugin/hooks: install the MemWal plugin via Cursor's plugin marketplace; confirm hooks fire

### 2G. Antigravity — Plugin / MCP-only

- [ ] **MCP-only:** add the local stdio server to Antigravity's MCP config (same `node … --local` command as above), restart, run Section 1 prompts
- [ ] *(Optional, unverified)* **Plugin:** `npx degit MystenLabs/MemWal/packages/mcp/plugin ~/.gemini/config/plugins/memwal` then restart. NOTE: the bundled `.mcp.json` is `--local` (abs path) right now, so it only works on this machine — fine for local testing

### 2H. OpenCode — MCP-only

- [ ] Edit `~/.config/opencode/opencode.json`:
  ```json
  {
    "mcp": {
      "memwal": {
        "type": "local",
        "command": ["node", "/Users/uydev/code/MemWal/packages/mcp/dist/bin/memwal-mcp.js", "--local"],
        "enabled": true
      }
    }
  }
  ```
- [ ] Restart OpenCode → run Section 1 prompts

---

## 3. Sign-off

- [ ] Section 1 (tool layer) passes
- [ ] Claude Code plugin (2A) shows the agent preferring `memwal_*` over built-in memory
- [ ] At least one MCP-only client (2B/2C) saves & recalls via MemWal
- [ ] Recorded which hosts I could NOT verify (Codex/Cursor/Antigravity/OpenCode)

## 4. Before the PR

- [x] `packages/mcp/plugin/.mcp.json` ships the prod default (`npx -y @mysten-incubation/memwal-mcp`) — no `--local` in the committed file
- [ ] Re-register `memwal-local` if you removed it for the plugin test
- [ ] Remove the temporary local `memwal` entries from Claude Desktop / Cursor / Codex / OpenCode configs (or keep for ongoing local dev)

---

## 5. Post-merge verification on `dev`

What merging to `dev` triggers, and how to try the result end-to-end.

### What goes live automatically

| Surface | Trigger | Result |
|---|---|---|
| npm prerelease | `release-mcp.yml` (path `packages/mcp/**`) | `@mysten-incubation/memwal-mcp@0.0.6-dev.N` under the `dev` dist-tag (`latest` stays 0.0.5 until `main`) |
| Plugin marketplace | none needed — `dev` is the repo's **default branch** | `/plugin marketplace add MystenLabs/MemWal` serves the new plugin immediately after merge |
| Sidecar tools (Layer 1) | Railway image rebuild (`services/server/Dockerfile` copies `scripts/mcp/`) | New agentic descriptions + `memwal_remember_bulk`/`memwal_health` on `relayer.dev.memwal.ai` — **verify the Railway dev environment actually redeployed**; this is not a repo workflow |

> The tool layer lives in the relayer, so even a 0.0.4 client sees the new tools once the dev relayer redeploys. Conversely, the new npm package against a stale relayer shows the OLD tools — always confirm the relayer first.

### Step 1 — Confirm the dev relayer has Layer 1 (no editor needed)

```bash
npx @modelcontextprotocol/inspector --cli \
  npx -y @mysten-incubation/memwal-mcp@dev --relayer https://relayer.dev.memwal.ai --web https://dev.memwal.ai \
  --method tools/list
```

- [ ] 8 tools listed, including `memwal_remember_bulk` and `memwal_health`
- [ ] `memwal_remember` description says "proactively" (proves the new sidecar is deployed)

If the new tools are missing → the Railway dev service hasn't redeployed; trigger it from the Railway dashboard.

### Step 2 — Claude Code plugin from the public marketplace

```
/plugin marketplace add MystenLabs/MemWal
/plugin install memwal@memwal-plugins
```

Restart Claude Code. The shipped `.mcp.json` targets **prod** — for a dev-relayer test, sign in against dev first: `npx -y @mysten-incubation/memwal-mcp@dev login --dev` (or set `MEMWAL_SERVER_URL=https://relayer.dev.memwal.ai`).

- [ ] SessionStart banner appears (`Walrus Memory active`)
- [ ] State 2–3 durable facts in one message → agent calls `memwal_remember_bulk` unprompted
- [ ] New chat, ask something referencing those facts → agent calls `memwal_recall` first
- [ ] Run a failing shell command → PostToolUse directive nudges a recall

### Step 3 — One MCP-only client (Claude Desktop or OpenCode)

Follow the published docs page verbatim (this also validates the docs): add the server, restart, `memwal_login`, repeat the save/recall prompts.

- [ ] Docs steps work as written, no missing instruction

### Step 4 — Codex (second in-scope host)

```bash
npx degit MystenLabs/MemWal/packages/mcp/plugin /tmp/memwal-plugin
node /tmp/memwal-plugin/scripts/install_codex_hooks.mjs
```

Enable `codex_hooks = true`, restart Codex, repeat the Step 2 prompts.

- [ ] Hooks merged into `~/.codex/hooks.json`, `[mcp_servers.memwal]` registered, no duplicates on re-run
- [ ] Auto-save / auto-recall behave as in Step 2

> **Caveat:** the installer resolves scripts relative to its own location — run it from a **persistent** clone/degit directory, not a temp dir you'll delete (hooks reference those script paths at runtime). Use `~/.memwal/plugin` instead of `/tmp` for a real install.

### Step 5 — Promotion sanity (before merging dev → main later)

- [ ] Prod relayer redeployed with the new sidecar (same Step 1 check against `relayer.memory.walrus.xyz`)
- [ ] `npm view @mysten-incubation/memwal-mcp dist-tags` — `dev` points at `0.0.6-dev.N`; after main merge, `latest` = `0.0.6`
- [ ] Mintlify docs published (the 6 provider pages + reference + changelog render, nav matches)
