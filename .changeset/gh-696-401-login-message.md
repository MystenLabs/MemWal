---
"@mysten-incubation/memwal": patch
---

Show an actionable `memwal_login` hint on unauthenticated 401s (#696).

An empty 401 used to surface as `Walrus Memory server error (401): <no message>`. `sanitizeServerError` now returns: Walrus Memory isn't signed in. Call the memwal_login tool, then retry.
