---
title: "Onchain Events"
---

The current indexer listens to Sui events for the MemWal package and uses them to update local
backend state.

## Current Event Coverage

- `AccountCreated`

The current service comment also points to delegate-key events as part of the broader V2 design,
even though the main loop shown in the repo currently targets account creation flow first.
