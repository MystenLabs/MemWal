# Purpose

The indexer exists to keep backend account lookup fast.

Instead of forcing the relayer to scan the chain for every request, the indexer listens to
MemWal events and syncs the relevant account data into PostgreSQL.
