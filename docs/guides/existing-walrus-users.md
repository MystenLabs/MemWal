---
title: Existing Walrus Users
description: What to expect the first time you sign in to Walrus Memory with a wallet you already use on Walrus, including blob discovery, re-upload, and onchain visibility.
keywords: [Walrus Memory, existing Walrus users, first sign-in, blob discovery, restore, re-upload, onchain visibility]
---


If you already build on Walrus, you can sign in to Walrus Memory with the same Sui wallet. Your
wallet stays the root of ownership, and any memories you created earlier through Walrus Memory
reappear on their own. Data you stored on Walrus outside of Walrus Memory does not move across
automatically. To use that data as memory, re-upload it through Walrus Memory.

<Info>
  You own your data. Walrus is the permanent record, and your wallet is the key to it. Walrus
  Memory reads from that record on your behalf rather than holding a separate copy of your
  memories.
</Info>

## Sign in on a new device

When you connect your wallet, Walrus Memory looks up your account in the onchain registry:

- If the registry has a `MemWalAccount` for your wallet, your account already exists. You do
  not create a new one.
- If this browser has no saved delegate key, create one to continue. The dashboard prompts you,
  and you can revoke old keys at any time.

A delegate key is a lightweight key that your apps and agents use to reach Walrus Memory on your
behalf. Creating a key on a new device does not affect your existing memories. For how delegate
keys work, see [Ownership and Delegates](/fundamentals/concepts/ownership-and-access).

## Discover your existing memories

The relayer keeps a search index over your memories, not your device, so recall stays fast. When
you sign in, recall returns whatever the index holds for your wallet. When the relayer has not
indexed memories you stored earlier, restore rediscovers them from Walrus and re-indexes them:

1. Walrus Memory queries the Walrus blob objects your wallet owns and filters them by namespace
   metadata.
2. It downloads the blobs the index does not have yet, decrypts them, and re-embeds them.
3. Recall can find those memories again.

Because Walrus holds the permanent record, you recover your memories even if the relayer rebuilds
the index from scratch. Restore one namespace at a time. For the full flow, see
[How Storage Works](/fundamentals/architecture/how-storage-works).

Each call restores up to a set number of blobs, newest first. The default is 10, and the limit
caps the onchain query itself, so calling restore repeatedly with the default does not reach older
memories. Set a `limit` at least as large as the namespace you want to restore:

```ts
// Restore up to 500 of the newest blobs in the "personal" namespace.
await memwal.restore("personal", 500);
```

<Note>
  Restore only rediscovers memories that Walrus Memory wrote, because it matches on the namespace
  metadata that Walrus Memory attaches at upload. It does not scan every blob in your wallet.
</Note>

## Why Walrus Memory does not migrate blobs

Walrus Memory does not import your existing Walrus blobs into memory. A raw Walrus blob is just
bytes. A memory is your content plus a vector embedding and namespace metadata that make
semantic recall possible. Blobs you stored through other tools carry none of that structure, so
Walrus Memory cannot search or decrypt them as memories.

To use existing content as memory, re-upload it through Walrus Memory:

- Call `remember` with the text you want to store. Walrus Memory embeds it and writes a new
  blob tagged for your memory space.
- The original blob stays where it is. Re-uploading creates a memory alongside it, and does not
  move or delete your existing data.

<Tip>
  Plan for re-upload as a one-time step when you adopt Walrus Memory. After that, recall reaches
  your memories from any device, and restore rebuilds the index from Walrus if the relayer ever
  loses it.
</Tip>

## What others can see onchain

Walrus Memory enforces ownership onchain, so anyone can read some records that point to your
wallet address:

- Anyone can see your `MemWalAccount` object, your registered delegate keys, and the `Blob`
  objects for each memory.
- Walrus Memory stores the namespace of a memory as blob metadata, so anyone can see namespace
  labels.
- No one can see your memory content. Only you or your authorized delegates can decrypt it.

<Warning>
  Choose namespace labels that you are comfortable leaving in public metadata. Keep sensitive
  information out of a namespace name, because anyone can read it.
</Warning>
