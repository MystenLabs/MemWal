# @mysten-incubation/memwal-mcp

## 0.0.12

### Added

- Forward the MCP client's `initialize.clientInfo` to the relayer as `x-memwal-client` / `x-memwal-client-version` so sidecar logs can name the coding agent (Claude Code, Codex, Cursor, …) on each session and tool call.

### Fixed

- Clarify `memwal_restore` `truncated=true` as known-retryable-incomplete: raising `limit` expands the sidecar cap only while `limit < 20`; `truncated=false` is not completeness (WALM-451 `sourceCapped`).
- Resolve the credential directory on every access instead of freezing it at module load, and let `MEMWAL_CREDS_DIR` override it. The login test sandboxed the home directory with `HOME` alone, which `os.homedir()` ignores on Windows, so running the package's test suite there wrote fixture credentials over the developer's real `~/.memwal/credentials.json` and destroyed the delegate key stored in it. (#705)

## 0.0.11

### Fixed

- Do not abort the SSE handshake socket on HTTP 429, 401, or a bad content-type (that crash path fired on Windows).
- Report MCP session occupancy caps as concurrent, not a 30-second cooldown.
- Exit with code 1 when `login` is run without a TTY, instead of booting the auth-required stub and reporting success.
- Concurrent `memwal_login` calls reuse the in-flight listener and URL instead of starting a second flow that can hang later remember/recall.
- Serialize outbound MCP POSTs and reconnect when the SSE handle is gone, so a burst of `memwal_recall` calls cannot poison the bridge until restart.
- Login timeout now warns that an on-chain delegate key may already exist if the browser approved after the local listener expired.
- Make `memwal_logout` actually revoke access on the running bridge. Logout previously deleted the credentials file and nothing else; the bridge kept the delegate key in memory and the SSE session open, so later `memwal_recall` / `memwal_remember` still ran under the key the user just removed. Logout now aborts the session, fails in-flight calls, and refuses memory tools until `memwal_login`. (#616)
- Drop the delegate key itself on logout rather than only flagging the session as signed out, so a forwarding path that misses the flag fails closed instead of reusing the deleted key. This also closes reconnect's replay loop, which posted against a pre-logout snapshot and could still push queued calls out under that key if a logout landed mid-replay. (#616)
- Refuse every request that arrives while signed out, not just memory tool calls. `ping` and other id-bearing requests previously fell through to a queue nothing drains while signed out and were never answered, hanging the client until the next `memwal_login`. (#616)

## 0.0.10

### Fixed

- Keep signed-out `tools/list` conservative so a model without credentials does not spam `memwal_remember`. Signed-in cold start (bridge) still uses the sidecar's proactive wording.
- Advertise `memwal_recall` as a read-only search (`readOnlyHint: true`, `destructiveHint: false`) so clients that gate on destructive tools do not hold back proactive recall.
- Align the cold-start `memwal_remember` / `memwal_recall` descriptions with the sidecar's proactive wording. The bridge serves this static list before the relayer session is up, and clients that keep the first `tools/list` were told to call remember only when the user explicitly asked.
- Stop classifying remember vs recall in the UserPromptSubmit hook. The hook injects a decision rubric and the agent chooses the tool from meaning, so Vietnamese, typos, and phrasing that never says "remember" still work.
- Keep remember proactive for preferences, decisions, constraints, corrections, and identity, but skip one-off tasks, the current file or bug, and small talk.
- Answer orphaned tool calls whose upstream response never arrives with a retryable error instead of hanging indefinitely. The bridge now tracks in-flight request start times and sweeps expired calls through a per-request deadline (`MEMWAL_MCP_CALL_TIMEOUT_MS`, default 240s), reuses the existing late-reply drop so an expired call cannot get a second response, and enriches reconnect logs with pending request IDs and methods. (#690)
- Inject the configured default namespace (`--namespace` / `MEMWAL_NAMESPACE`) into `memwal_remember_bulk` calls that omit one, so bulk facts land in the project namespace instead of the relayer fallback `default`. (#667)
- Send proactive-usage instructions in the MCP `initialize` handshake, so the model knows when to save and recall without being asked. Clients moved to lazy tool loading, which keeps tool descriptions out of the model's context until a tool is explicitly loaded; the guidance lived only in those descriptions, so the model stopped using memory on its own and would offer its built-in memory or deny the tool existed. `instructions` travels with `initialize`, before any `tools/list`, so lazy loading cannot strip it. (#681)
- Carry those instructions through the bridge's local `initialize`. The bridge answers the handshake itself at cold start and suppresses the relayer's reply, so the relayer's instructions never reached a stdio client. Signed-out sessions instead get guidance pointing at `memwal_login`, since every memory tool fails without credentials.
- Report the real package version in `serverInfo.version` instead of a hardcoded `0.0.1`, so handshake logs identify which build a user is running.

## 0.0.9

### Fixed

- Answer the MCP `initialize` handshake locally and connect the relayer in the background, so a slow cold start no longer trips the client's 30s connection timeout and leaves the session with no memory tools. Tool discovery is served immediately and refreshed once the relayer is up; a hung relayer now degrades to a tool-call error instead of a failed startup. (#415)
- Drop buffered tool calls on a same-account login reconnect and keep the `initialize` request id reusable, so a login handoff cannot publish stale cold-start traffic or break the client's handshake.

## 0.0.8

### Added

- Human-readable tool titles and explicit `readOnlyHint` / `destructiveHint` metadata during pre-login tool discovery, matching the remote relayer metadata used by Claude connectors.

## 0.0.7

### Fixed

- Reload credentials after browser login without restarting the MCP client.
- Reject stale handshakes and prevent request replay across account changes.
- Report truncated restores and enforce the relayer's bounded restore limit.

## 0.0.6

### Security

- Require a localhost preflight handshake proving the exact state, public key, and relayer before accepting a delegate-key login callback.

### Fixed

- Authenticate MCP SSE POST messages and replayed requests with the delegate credentials.
- Keep the canonical login label from the verified local flow instead of trusting the browser callback.

## 0.0.5

### Added

- Automatic memory plugin for Claude Code, Codex, Cursor, and Antigravity.
- New `memwal_remember_bulk` and `memwal_health` tools.

### Fixed

- Ship the plugin's `.mcp.json` in the marketplace bundle. A root gitignore rule excluded it, so plugin installs loaded the lifecycle hooks but never registered the MCP server.

### Changed

- Memory tools are now proactive — agents recall and save context on their own.

### Fixed

- Plugin bundle now ships its `.mcp.json` so the MCP server registers on install.
- Automatically recover from dropped relayer connections that could hang tool calls.

## 0.0.4

### Fixed

- Accept HTTPS dashboard sign-in callbacks to the local `127.0.0.1` MCP listener.
- Reload credentials after `memwal_login` so memory tools work without restarting the MCP client.

## 0.0.3

### Changed

- Rebranded package metadata and documentation from MemWal to Walrus Memory.

## 0.0.2

### Added

- Added relayer compatibility metadata checks before opening the MCP bridge.

## 0.0.1

### Initial Release

- Stdio MCP server for MemWal with browser-based wallet login.
- Inline `memwal_login` and `memwal_logout` session tools.
- Memory tools for remember, recall, analyze, and restore through the Walrus Memory relayer.
- Environment presets for production, dev, staging, and local relayers.
