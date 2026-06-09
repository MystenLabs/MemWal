# Automatic Memory — design note (internal)

> Internal design rationale for WALM-94 "MCP Behavior Improvement". **Not
> published** — this file is intentionally excluded from `package.json`
> `files`, so it never reaches npm or the docs site. The public docs
> (`docs/mcp/*` — overview + per-client pages) deliberately do **not** mention mem0.

## Problem

The MCP did single, manual tasks: the agent only saved/recalled when explicitly
asked. The cause was the tool **descriptions** the agent reads — which live in
the relayer's TS sidecar (`services/server/scripts/mcp/tools/*.ts`), not in this
package. `memwal_remember` literally said *"Call ONLY when the user explicitly
asks… agents should not call this proactively."* And `rememberBulk` (in the SDK)
was never exposed as a tool.

## Architecture — three layers

1. **Agentic tool descriptions + `memwal_remember_bulk`** — `services/server/scripts/mcp/tools/`.
   The foundation: the agent *knows* when to act from the descriptions. Server-side,
   so it benefits every MCP client (Claude Code, Codex, Cursor).
2. **Decision hooks** — `packages/mcp/plugin/` (this package). Lifecycle hooks
   (SessionStart / UserPromptSubmit / PostToolUse) that *remind* the agent to
   recall/remember. Pure heuristic → injected directive; **no fetch, no network,
   no creds**. The agent makes the actual tool call.
3. **Docs** — `docs/mcp/` hub (`overview.md`) + per-client pages (`claude-code.md`, `codex.md`, `cursor.md`, `claude-desktop.md`, `antigravity.md`) + `reference.md`.

## Before / After

| Dimension | Before | After |
|---|---|---|
| Save trigger | "ONLY when user explicitly asks; don't be proactive" | "Save proactively whenever you learn a durable fact" |
| Bulk save | not exposed | `memwal_remember_bulk` (wraps SDK `rememberBulkAndWait`, ≤20) |
| Recall trigger | neutral; agent rarely called it unprompted | "Recall proactively at task start / when the user references past work" |
| Reinforcement | none | UserPromptSubmit + PostToolUse hooks (Claude Code + Codex) |
| Who benefits | n/a | tool-layer change benefits all MCP clients; hooks add Claude Code + Codex |

## mem0 vs MemWal

| Concept | mem0 plugin | MemWal plugin |
|---|---|---|
| MCP transport | remote HTTP | local stdio (`npx @mysten-incubation/memwal-mcp`) |
| Auth | `MEM0_API_KEY` | Ed25519 delegate key (`~/.memwal/credentials.json`, browser login) |
| Hook runtime | bash + Python (venv) | Node-only `.mjs` (no venv) |
| Recall | hooks inject a search rubric (+ direct search on strong signals) | hooks inject a directive; agent calls `memwal_recall` (no hook-side fetch) |
| Save | direct API on Stop/PreCompact (`infer`, `run_id`, 90d expiry) | agent calls `memwal_remember`/`_bulk`; hooks only remind |
| Tools | 9 (CRUD + entities, incl. delete/update) | 5 memory tools + `memwal_health` utility, **append-only** (no forget/update) |
| Scope | `user_id` + `app_id` + `run_id` | single `namespace` (global `default`; `MEMWAL_NAMESPACE` overrides) |
| Guardrail hooks | PreToolUse enforce-metadata / block writes | dropped (nothing to enforce) |

## Decisions (chosen)

- **Append-only** — no `forget`/`update` tools (relayer dedups embeddings).
- **Global `default` namespace** — `MEMWAL_NAMESPACE` overrides for per-project scope.
- **Heuristic → agent directive** — no `ask`-style LLM judge, no hook-side fetch.
- **Out of scope** — prefetch/warm-load, a `/api/recent` endpoint, `ask`-style judge,
  background auto-capture. The agentic tools + hooks already deliver auto-memory.

## File map

- `services/server/scripts/mcp/tools/{remember,recall,analyze,restore}.ts` — agentic descriptions
- `services/server/scripts/mcp/tools/remember-bulk.ts` + `index.ts` — new bulk tool
- `packages/mcp/plugin/` — plugin manifest, `.mcp.json`, hooks, Node scripts, Codex installer
- `.claude-plugin/marketplace.json` (repo root) — Claude Code marketplace entry (local source `./packages/mcp/plugin`)
- `docs/mcp/{overview,claude-code,codex,cursor,claude-desktop,antigravity,reference}.md` — public docs (no mem0); per-client, MCP-vs-Plugin framing
