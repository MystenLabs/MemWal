---
"@mysten-incubation/memwal": patch
---

Show an actionable `memwal_login` hint on empty 401s without a session (#696).

Calling a `memwal_*` tool with no session used to surface `Walrus Memory server error (401): <no message>` when status was forwarded as a string and skipped the 401 special-case. Empty 401s now return the login instruction; WALM-318 AUTH_REJECTED (401 with a body) and clock-drift (`x-auth-error: ERR_TIMESTAMP_OUT_OF_BOUNDS`) are unchanged.
