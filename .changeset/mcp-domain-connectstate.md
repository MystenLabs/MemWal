---
"@mysten-incubation/memwal-mcp": patch
---

Point the MCP client at memory.walrus.xyz and fix Google sign-in (WALM-86).

- Default relayer/web URLs and `--prod`/`--staging` presets now resolve to
  `memory.walrus.xyz` / `relayer.memory.walrus.xyz` (staging:
  `staging.memory.walrus.xyz` / `relayer-staging.memory.walrus.xyz`), removing
  the temporary Cloudflare `memwal.ai` redirect dependency.
- Rename the connect-URL CSRF query param `state` → `connectState`. `state` is a
  reserved OAuth 2.0 response parameter, so the consent page's redirect_uri was
  rejected by Google (`invalid_request`). The callback POST body field is
  unchanged.
