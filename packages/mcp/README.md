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

## How the plugin launches the server

The [MemWal plugin](https://memory.walrus.xyz/mcp/claude-code) does **not** use the
`npx` form above. `npx` resolves a package *name* against the directory the MCP
client was started in — your project — so a project that contains an installed
`@mysten-incubation/memwal-mcp` claiming the pinned version would be run instead of
the published one. Pinning the version in the `npx` command does not prevent that:
the planted package simply claims the pinned version.

Instead, every plugin launch config runs the plugin's launcher:

```json
{
  "mcpServers": {
    "memwal": {
      "command": "node",
      "args": ["${CLAUDE_PLUGIN_ROOT}/scripts/launch_mcp.mjs"]
    }
  }
}
```

The launcher installs the pinned version once into a directory it owns and then
runs that absolute entry point with the current `node` binary:

```
~/.memwal/runtime/memwal-mcp@<version>/node_modules/@mysten-incubation/memwal-mcp/dist/bin/memwal-mcp.js
```

It never consults your project's `node_modules` or a `PATH`-relative bin shim, and
it fails rather than falling back to the package name if the pinned version cannot
be installed. Everything after the script path is forwarded to the server
unchanged, so flags such as `--namespace work` or `--relayer <url>` work exactly as
they do above.

The runtime directory is trusted because of what it is, not how it is spelled:

- It must be outside the project the client started in. An absolute path is not
  enough on its own — a client expands `${workspaceFolder}` to an absolute path
  inside the repository, and a repository can commit a whole fake install there.
- It must be a real directory (not a symlink), owned by you, and not group- or
  world-writable. The launcher creates it with mode `0700` and refuses to run code
  out of it otherwise. If you see a refusal, `chmod 700 ~/.memwal ~/.memwal/runtime`.
- `MEMWAL_MCP_RUNTIME_DIR` moves it, subject to exactly the same rules.

The one-off install is run with `--ignore-scripts` (so no `preinstall` or
`postinstall` from the package or its dependencies executes), against an explicitly
pinned public registry, with the `npm_config_*` and `NODE_OPTIONS` environment
scrubbed for that spawn — npm ranks environment variables above every `.npmrc`, so
a client `env` block would otherwise choose the registry. npm itself is run as
`node <npm-cli.js>` resolved from the running node binary where that layout exists.

What that does **not** give you is an integrity check of the package contents: it
establishes where the code came from and that nobody else can write it, not that
the registry served the bytes a reviewer read. If you install from a private
registry, pre-populate the directory yourself (below) — the launcher then finds the
install and never runs npm at all.

If you configure MemWal without the plugin and want the same property, install the
version you intend to run into a directory outside any project and point your
client at its absolute path:

```sh
mkdir -p ~/.memwal/runtime/memwal-mcp@0.0.14
chmod 700 ~/.memwal ~/.memwal/runtime
npm install --ignore-scripts --prefix ~/.memwal/runtime/memwal-mcp@0.0.14 \
  @mysten-incubation/memwal-mcp@0.0.14
```

```json
{
  "mcpServers": {
    "memwal": {
      "command": "node",
      "args": ["/absolute/path/to/home/.memwal/runtime/memwal-mcp@0.0.14/node_modules/@mysten-incubation/memwal-mcp/dist/bin/memwal-mcp.js"]
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

Enable verbose stderr logging with `MEMWAL_MCP_DEBUG=1`.

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

Credentials are stored locally in `~/.memwal/credentials.json`. To remove them:

```sh
npx -y @mysten-incubation/memwal-mcp --logout
```

## License

Apache-2.0
