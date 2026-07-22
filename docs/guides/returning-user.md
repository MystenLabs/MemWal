---
title: "Sign in as a returning user"
description: "What to expect when you return to Walrus Memory on a new device or as an existing Walrus user: first-sign-in memory discovery, the re-upload expectation, and what your wallet reveals onchain."
keywords: [returning user, existing user, sign in, recovery, delegate key, restore, migration, re-upload, wallet visibility, privacy, MemWal, Walrus]
---

Your memories live on Walrus and your account lives on Sui, so they persist no matter which device you sign in from. What does not travel with you is the delegate key your browser used last time. This guide explains what happens the first time you sign in on a new device, why your existing Walrus data is not automatically imported, and what other people can see about your account onchain.

## Your account outlives any single device

Walrus Memory stores your memories as encrypted blobs on Walrus and records your account and its permissions on Sui. Neither depends on your browser. When you connect the same wallet again, whether a week later or on a different machine, the same account and the same memories are still yours.

The one thing that stays local is the delegate key. A delegate key is a keypair your account authorizes to read and write memory on your behalf. The dashboard keeps it in the browser you created it in, so a new browser starts without it. This is expected, and recovering is a single step.

## First sign-in on a new device

When you connect your wallet on a device that has no saved delegate key, the dashboard checks Sui for your account and shows you one of two states.

<Steps>
  <Step>
    ### The dashboard finds your existing account

    If your wallet already owns a Walrus Memory account, the dashboard tells you the account is active but this browser has no saved delegate key. Your memories are safe. You just need a key on this device to reach them.
  </Step>

  <Step>
    ### Create a new delegate key

    Create a new delegate key from the dashboard. It generates a fresh keypair and registers it to your existing account onchain, so the new key joins the account rather than replacing it. Save the private key somewhere secure, because the dashboard shows it only once.
  </Step>

  <Step>
    ### Reach your existing memories

    Because access control is enforced onchain by your account's owner and delegates, any delegate key registered to the account can decrypt the account's memories. The new key you just created reads the memories you wrote with the old one. You do not need to recover the old key.
  </Step>
</Steps>

<Note>
Losing a delegate key does not lose your memories. The key is a credential for reaching your account, not the account itself. Create a new one and your memories are still there. If a lost key might be exposed, remove it from your account on the dashboard so it can no longer act on your behalf.
</Note>

### Rediscover your memories

A new device also starts with an empty local index, so recall may return nothing at first even though your memories exist on Walrus. Rebuild the index with restore, which rediscovers the blobs your account owns in a namespace and re-indexes them:

```ts
const result = await memwal.restore("personal");
console.log(`restored=${result.restored} skipped=${result.skipped} total=${result.total}`);
```

Run restore once per namespace you use. The `total` count reflects the memories your account actually owns on Walrus. For how restore works, see [How Storage Works](/fundamentals/architecture/how-storage-works).

## You own your data, and you re-upload it

If you already use Walrus to store files directly, expect a clear boundary: Walrus Memory does not import your existing Walrus blobs as memories. There is no migration step, and this is by design, not a limitation to work around.

A memory is not just a blob. When Walrus Memory stores a memory, it encrypts the content with Seal, attaches namespace metadata, and generates a vector embedding so the memory is searchable by meaning. An arbitrary blob you uploaded to Walrus through another tool has none of that structure, so Walrus Memory cannot treat it as a memory or return it from recall.

To bring existing content into Walrus Memory, write it through the SDK, which produces a proper memory:

```ts
await memwal.rememberAndWait("Content you want to carry into Walrus Memory.");
```

<Note>
Re-uploading is not a loss of ownership. You still own the original Walrus blobs, and re-uploading through the SDK creates a new, encrypted, searchable memory that you also own. Your data stays yours throughout.
</Note>

This boundary runs the other way too. Deleting a memory in Walrus Memory does not touch any separate Walrus blob you uploaded elsewhere, because they are different objects with different owners and lifecycles.

## What your wallet reveals onchain

Walrus Memory is private in content but public in structure, and it helps to know which is which before you rely on it.

- **Your memory content is encrypted.** Every memory is Seal-encrypted before it reaches Walrus, and only your account's owner and delegates can decrypt it. No one else reads your memories, including the relayer operator when you use client-managed encryption.
- **Your ownership is public.** The `Blob` objects your wallet owns are visible on Sui, along with metadata such as blob IDs, sizes, expiry epochs, and the namespace label. Anyone inspecting the chain can see that your address owns blobs and how many, even though they cannot read the contents.
- **Namespace labels are not secret.** A namespace is an organizing label attached as metadata, not a private field. Avoid putting sensitive information in a namespace name.

<Warning>
Treat namespace names and the fact that your wallet owns memory as public. Keep anything sensitive inside the memory content, which is encrypted, and never in a namespace label or other metadata, which is not.
</Warning>

For the full ownership and access model, see [Ownership and Delegates](/fundamentals/concepts/ownership-and-access).

## Related links

- [Ownership and Delegates](/fundamentals/concepts/ownership-and-access)
- [How Storage Works](/fundamentals/architecture/how-storage-works)
- [Manage your memory](/guides/manage-your-memory)
- [Memory Space](/fundamentals/concepts/memory-space)
- [SDK Quickstart](/sdk/quick-start)
