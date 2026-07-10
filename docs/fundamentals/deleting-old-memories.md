---
title: "Deleting Old Memories"
description: "Permanently delete old memories from Walrus Memory: what deletion does, what it can never undo, and how the delete flow works."
keywords:
  - delete memories
  - deletion
  - Walrus blob
  - cleanup
  - permanent deletion
---

Walrus Memory lets you permanently delete memories you no longer want. This page explains what deletion does, what it can never undo, and how the flow works.

## Deletion is permanent

Read this before deleting anything:

- A deleted memory is **erased from Walrus storage and from your memory index, forever**. Nobody can recover, restore, or re-index it afterwards: not you, not the Walrus Memory team, not anyone else.
- A deleted memory is **never migrated** to any future version of Walrus Memory. If you delete before a migration, that memory never arrives on the other side.
- There is **no undo, no trash bin, and no grace period**. The moment the transaction lands onchain, the data is gone.

Only delete memories you are certain you no longer want.

## How it works

Your memories live on Walrus as `Blob` objects owned by your wallet. The delete flow:

1. **Open the cleanup section** from the `old memories` banner or the `Delete old memories` section at the bottom of your dashboard. The app scans your wallet onchain and counts every deletable memory blob it owns. The scan skips expired blobs because their storage is already gone.
2. **Delete all**. One button deletes all of your old memories together. There is no per-memory picking.
3. **Confirm**. A dialog restates that deletion is permanent.
4. **Sign**. The app builds each delete transaction for you and sponsors the gas, so signing is the only thing you do. Deletion runs in batches of about 40 memories per transaction: a wallet with a few dozen memories signs once or twice, and a wallet with hundreds signs a handful of times.
5. **Done**. The server submits each signed transaction, confirms it succeeded onchain, and removes the matching rows from your memory index in the same call. You receive the reclaimed Walrus storage objects in your wallet.

If the flow stops partway (a rejected signature, a network drop), nothing is lost or half-deleted: batches that already ran stay deleted onchain and in the index, and the section picks up exactly the remaining blobs after a refresh.

## Notes

- Walrus Memory sponsors the gas, so deleting costs you nothing.
- Only blobs marked `deletable` onchain with unexpired storage can be deleted. The app hides the rest.
- Sponsored transactions have a per-wallet rate limit, so deleting many thousands of memories can take more than one session.
- You need an active delegate-key session (the same one the dashboard and playground use) so the server can verify the request is really yours.
