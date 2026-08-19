---
"@mysten-incubation/memwal": patch
---

Show an actionable `memwal_login` hint on unauthenticated 401s (#696).

An empty 401 used to surface as `Walrus Memory server error (401): <no message>`, which gives first-time MCP callers nothing to do. `sanitizeServerError` now returns a short message pointing at `memwal_login`.
