---
title: "Manage Your Memories"
description: "Browse, search, renew, and delete the memories your wallet has stored in Walrus Memory."
---

## Overview

Every memory your wallet stores in Walrus Memory stays under your control. From the dashboard
you can see what you have stored, group it by namespace, renew storage before it expires, and
remove anything you no longer want.

<Info>
  Walrus Memory encrypts memory content with Seal before it reaches Walrus. The dashboard
  decrypts a memory only when you preview it, and only for the wallet that owns it.
</Info>

## How Walrus Memory organizes memories

Walrus Memory groups your memories into memory spaces. A memory space isolates your storage, and
these values identify it:

| **Component** | **What it is** |
| --- | --- |
| Owner address | The Sui wallet address that owns the memory. |
| Namespace | A label you choose to group related memories, for example `personal` or `work`. |
| App ID | The Walrus Memory package ID, unique to each relayer deployment. |

The namespace is the part you manage day to day. One wallet can hold as many namespaces as you
want, and memories in one namespace never mix with another. When you browse, search, or restore,
you always work within a single namespace at a time. For more detail, see
[Memory Space](/fundamentals/concepts/memory-space).

## Prerequisites

Connect the wallet that owns the memories you want to manage. After you connect, the dashboard
opens at `/dashboard`.

## Browse your memories

The dashboard lists the memories your wallet has stored. Each memory appears as a row with these
columns:

| **Column** | **Description** |
| --- | --- |
| Blob | The Walrus blob ID that holds the encrypted memory. |
| Object | The onchain object ID for the blob. |
| Created | The date you stored the memory. |
| State | The current storage state, for example `stored` or `deletable`. |
| Preview | Opens the decrypted content so you can confirm what a memory holds. |

Select **Preview** on any row to read the memory content. Walrus Memory decrypts it in your
browser for that view only, then closes it again when you finish.

## Filter by namespace

Recall and restore both work within one namespace, so filter by namespace to find a memory
quickly. Choose the namespace you want to inspect, and the dashboard shows only the memories you
stored under that label. Switch namespaces to move between, for example, your `personal` and
`work` memories.

<Tip>
  If you are not sure which namespaces you have used, check the namespace values your app passes
  when it calls `remember`. Each distinct value creates a separate memory space.
</Tip>

## Renew storage before it expires

Walrus stores each memory as a blob that lives for a set number of epochs. Each epoch lasts about
2 weeks on Mainnet and about 1 day on Testnet. When the paid epochs run out, Walrus drops the blob
and the memory disappears, so renew memories you want to keep before they expire.

Renewing a memory extends the lifetime of its onchain `Blob` object for more epochs. You can renew
a single memory, or renew all memories near expiry at once.

<Note>
  Renewal extends existing storage. It does not change the memory content, the blob ID, or the
  namespace. To learn who pays for the extended storage, see
  [How an Agent Funds Walrus Storage](/fundamentals/architecture/funding-storage).
</Note>

## Delete memories

Deleting a memory removes it permanently. Preview a memory before you delete it, because you
cannot recover it afterward.

- To delete through the dashboard, see [Delete Old Memories](/guides/delete-old-memories).
- To delete in bulk from a script, see
  [Delete Memories Programmatically](/guides/delete-memories-programmatically).

<Warning>
  Deletion is permanent. Neither the dashboard nor the API can restore a memory after you delete
  it.
</Warning>
