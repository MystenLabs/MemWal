---
"@mysten-incubation/memwal": patch
---

Empty-body 401s now triage SDK/headless credentials (delegate key, account ID, network) instead of telling every caller to run MCP `memwal_login` (WALM-469).
