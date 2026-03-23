---
title: "Database Sync"
---

The indexer syncs account data into PostgreSQL so the relayer can resolve ownership quickly.

## Current Stored State

- `accounts`
- `indexer_state`

## Why It Helps

- avoids repeated onchain registry scans during auth
- keeps a resumable cursor for long-running event polling
- makes account lookup effectively constant-time for the backend
