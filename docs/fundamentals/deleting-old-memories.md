---
title: "Deleting Old Memories"
---

Walrus Memory lets you permanently delete memories you no longer want. This
page explains what deletion does, what it can never undo, and how the flow
works.

## ⚠️ Deletion is permanent

Read this before deleting anything:

- A deleted memory is **erased from Walrus storage and from your memory
  index, forever**. It cannot be recovered, restored, or re-indexed — by
  you, by the Walrus Memory team, or by anyone else.
- A deleted memory will **never be migrated** to any future version of
  Walrus Memory. If you delete before a migration, that memory simply never
  arrives on the other side.
- There is **no undo, no trash bin, and no grace period**. The moment the
  transaction lands on-chain, the data is gone.

Only delete memories you are certain you no longer want.

## How it works

Your memories live on Walrus as `Blob` objects owned by your wallet. The
delete flow:

1. **Open the cleanup page** — from the "old memories" banner or the "Delete old
   memories" section at the bottom of your dashboard. The app scans your wallet on-chain and lists every deletable
   memory blob it owns.
2. **Choose what to delete** — everything is selected by default; untick
   anything you want to keep.
3. **Confirm** — a dialog restates that deletion is permanent.
4. **Sign** — the app builds the delete transaction for you and sponsors the
   gas, so signing is the only thing you do. Deletion runs in batches of
   ~950 memories per transaction: a wallet with 20,000 memories signs about
   22 times, a wallet with a few hundred signs once.
5. **Done** — the server submits each signed transaction, waits for it to
   land on-chain, and removes the matching rows from your memory index in
   the same call. Reclaimed Walrus storage objects are returned to your
   wallet.

If the flow is interrupted partway (a rejected signature, a network drop),
nothing is lost or half-deleted: already-processed batches are fully deleted
on-chain and in the index, and re-opening the page picks up exactly the
remaining blobs.

## Notes

- Gas is sponsored — deleting costs you nothing.
- Only blobs marked `deletable` on-chain can be deleted; permanent blobs are
  not shown.
- You need an active delegate-key session (the same one the dashboard and
  playground use) so the server can verify the request is really yours.
