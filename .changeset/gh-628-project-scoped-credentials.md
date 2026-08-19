---
"@mysten-incubation/memwal-mcp": patch
---

Resolve credentials per project, and stop silently replacing another account's (#628).

Credentials lived in one global `~/.memwal/credentials.json`, so signing in from one project repointed every other project on the machine at a different account and delegate key. The only visible signal was the `label` field, and nothing warned at the point of use — memories written in that state would have landed on the wrong account, on immutable storage, with no delete path.

A `.memwal/credentials.json` in the working directory now takes precedence over the global file, the way `.npmrc` and `.git/config` resolve. This is purely additive: a machine with no project-local file behaves exactly as before, and creating one is the opt-in.

Signing in as a *different* account now also copies the outgoing file to `credentials.backup-<timestamp>.json` and prints both account ids — the one replaced and the one now in use. There was previously no backup of any kind, so an overwrite was unrecoverable.
