# Walrus Memory MCP

Walrus Memory MCP is a stdio Model Context Protocol server for Walrus Memory. It lets MCP clients such as Cursor, Claude Desktop, Antigravity, and Claude Code connect to the Walrus Memory relayer without manually configuring remote headers or auth tokens.

On first use, the package advertises a `memwal_login` tool to the MCP client. The agent can call it inline — no separate CLI command needed. The tool opens a browser-based wallet login flow and stores local credentials at `~/.memwal/credentials.json`. A matching `memwal_logout` tool clears the saved credentials.

## Source and release ownership

This directory is the canonical source for the MCP runtime, tests, versioning, and npm releases. The Claude Code marketplace package is maintained separately in [`CommandOSSLabs/walrus-memory-mcp-plugin`](https://github.com/CommandOSSLabs/walrus-memory-mcp-plugin) for transfer to MystenLabs. npm releases intentionally do not bundle a second marketplace-plugin copy.

## Quick Start

Add Walrus Memory MCP to your MCP client config:

```json
{
  "mcpServers": {
    "memwal": {
      "command": "npx",
      "args": ["-y", "@mysten-incubation/memwal-mcp"]
    }
  }
}
```

## Login

Run the login flow manually:

```sh
npx -y @mysten-incubation/memwal-mcp login
```

The command opens your browser, asks you to connect your Sui wallet, and saves credentials locally.

## Commands

```sh
memwal-mcp
memwal-mcp login
memwal-mcp auto-save on|off
memwal-mcp --logout
memwal-mcp --help
```

## Options

Use CLI flags or environment variables to override the default Walrus Memory endpoints.

| CLI flag | Environment variable | Description |
| --- | --- | --- |
| `--relayer <url>` | `MEMWAL_SERVER_URL` | Override the relayer base URL. |
| `--web-url <url>` | `MEMWAL_WEB_URL` | Override the web app URL used during login. |
| `--label <text>` | `MEMWAL_CLIENT_LABEL` | Friendly delegate-key label shown in Walrus Memory. |
| `--namespace <name>` (alias `--ns`) | `MEMWAL_NAMESPACE` | Default memory namespace applied when the agent omits one. |
| `auto-save on\|off` | `MEMWAL_AUTO_SAVE` | Let the agent save durable facts unprompted. Off by default; see [Automatic Memory](#automatic-memory-opt-in). |

Enable verbose stderr logging with `MEMWAL_MCP_DEBUG=1`.

## Automatic Memory (opt-in)

By default the agent saves **only what you ask it to save**. Turning automatic
memory on lets it save durable facts — preferences, decisions, constraints,
recurring workflows — without being asked:

```sh
npx -y @mysten-incubation/memwal-mcp auto-save on
npx -y @mysten-incubation/memwal-mcp auto-save off
npx -y @mysten-incubation/memwal-mcp auto-save        # report the current setting
```

The choice is stored as `{"autoSave": true}` in `settings.json` next to your
credentials file, so it follows the same project-local-beats-global resolution.
To pin one MCP client instead, set the environment variable — it overrides the
file:

```json
{
  "mcpServers": {
    "memwal": {
      "command": "npx",
      "args": ["-y", "@mysten-incubation/memwal-mcp"],
      "env": { "MEMWAL_AUTO_SAVE": "1" }
    }
  }
}
```

Recall is never gated, and neither is an explicit "remember this" — the setting
only decides whether the agent saves things you did not ask it to save.

### What is never saved

Walrus storage is append-only and encrypted: a memory that lands **cannot be
edited or deleted**. So credentials are excluded in both modes, by the same
rules stated in the server instructions, the tool descriptions and the plugin
hooks — and enforced by a check that runs before any text is sent:

- passwords, API keys, access and refresh tokens, private keys, seed and
  recovery phrases, authorization headers, session cookies, and connection
  strings or URLs with an embedded `user:password`;
- anything you say not to save ("don't save this", "off the record");
- pasted third-party content — a fenced block, a quoted passage — which is not
  a fact about you.

When a message mixes a preference with a credential, the **preference is kept**
and only the credential is removed: "I prefer dark mode, db is
`postgres://admin:hunter2@db.internal/app`" is stored with the password gone and
the host intact. The agent is told which kinds were removed; the secret itself
is never stored, logged, or echoed back.

Detection targets specific credential shapes rather than "looks random", so
identifiers you *do* want remembered — blob ids, Sui object ids, commit SHAs,
digests — pass through untouched. Where a secret is indistinguishable from an
identifier, the **label** decides: pasting your `credentials.json` has its
`delegatePrivateKey` removed, while the same 64 hex characters with nothing
calling them a key are stored as the digest they look like. The trade-off is
that a secret in no recognisable shape, and with no label near it, can still
slip past the check — which is why the model-facing rules exist alongside it.

## Default Namespace

By default the MCP tool schemas expose an optional `namespace` argument and the
agent has to pass it on every `memwal_remember` / `memwal_remember_bulk` /
`memwal_recall` / `memwal_analyze` call (and `memwal_restore` requires it). Set
a default once in your client config instead:

```json
{
  "mcpServers": {
    "memwal": {
      "command": "npx",
      "args": ["-y", "@mysten-incubation/memwal-mcp", "--namespace", "work"]
    }
  }
}
```

Or with an environment variable (e.g. Claude Desktop / Codex `env` blocks):

```json
{
  "mcpServers": {
    "memwal": {
      "command": "npx",
      "args": ["-y", "@mysten-incubation/memwal-mcp"],
      "env": { "MEMWAL_NAMESPACE": "work" }
    }
  }
}
```

Resolution and precedence:

- **Per-call wins**: an explicit, non-empty `namespace` in a tool call is
  always used as-is — the configured default never overrides it.
- **Configured default**: when the agent omits `namespace`, the package
  injects `--namespace` (CLI) or `MEMWAL_NAMESPACE` (env); CLI wins over env.
- **Unset**: if neither is configured, the call is forwarded without a
  `namespace` and the relayer applies its own `"default"` namespace.

`memwal_restore` still advertises `namespace` as **required** in its schema, so
agents normally pass one explicitly. If a default is configured and the agent
calls `memwal_restore` without a namespace, the configured default is filled
in the same way.

### Verifying namespace injection

No automated test runner ships with this package (consistent with the rest of
the monorepo). To verify manually:

1. Start the server pinned to a namespace and with debug logging:
   `MEMWAL_MCP_DEBUG=1 npx -y @mysten-incubation/memwal-mcp --namespace demo-ns`
2. From your MCP client, ask the agent to remember a fact **without**
   specifying a namespace, then recall it **without** a namespace — the recall
   should return that fact (both landed in `demo-ns`).
3. Ask the agent to recall with an explicit different namespace
   (e.g. `other`) — it should **not** return the fact, proving the per-call
   value overrode the default.

The injection itself is the pure, exported `applyDefaultNamespace(msg, ns)`
function in `src/bridge.ts` if you want to assert it directly.

## Environment Presets

```sh
memwal-mcp --prod
memwal-mcp --staging
memwal-mcp --local
```

You can also pass explicit URLs:

```json
{
  "mcpServers": {
    "memwal": {
      "command": "npx",
      "args": [
        "-y",
        "@mysten-incubation/memwal-mcp",
        "--relayer",
        "https://relayer-staging.memory.walrus.xyz"
      ]
    }
  }
}
```

## Credential Storage

Credentials are stored locally in `~/.memwal/credentials.json`, and the
automatic-memory setting in `settings.json` beside it. To remove the
credentials:

```sh
npx -y @mysten-incubation/memwal-mcp --logout
```

### Per-project credentials

A project can keep its own `.memwal/credentials.json` so memory written from it
goes to a separate account. That file lives inside the repository, where anyone
who can commit to it — or who can get you to open a clone — could otherwise
choose the account and relayer your memories go to. So it is **ignored until you
approve it**, once per machine:

```sh
cd path/to/project
npx -y @mysten-incubation/memwal-mcp approve-project
```

Until then the global credentials are used, and a line on stderr names the file
that was skipped and the destination it wanted. An approval covers one exact
project path, account, delegate key and relayer: if any of those change, it has
to be approved again. The record is kept in `~/.memwal/project-approvals.json`,
outside the repository, so a repository cannot carry its own approval.
`revoke-project` withdraws it.

`MEMWAL_CREDS_DIR` points both the credentials and the approval record at a
directory of your choosing and overrides project resolution entirely — it can
only come from your own environment, never from a checkout, so it needs no
approval.

`memwal_health` reports the destination in use as `account=… relayer=…`.

## License

Apache-2.0
