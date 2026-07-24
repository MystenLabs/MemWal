---
title: Sign in as a Returning User
description: What to expect when you return to Walrus Memory on a new device or as an existing Walrus user, covering first-sign-in memory discovery, the re-upload expectation, and what your wallet reveals onchain.
keywords: [returning user, existing user, sign in, recovery, delegate key, restore, migration, re-upload, wallet visibility, privacy, MemWal, Walrus]
---

Your memories live on Walrus and your account lives on Sui, so they persist no matter which device you sign in from. Only the delegate key your browser used last time stays behind. On a new device, expect to recover access, re-upload rather than import existing Walrus data, and see what your account reveals onchain.

<Info>
  **Post-GA:** Walrus Memory ships the full returning-user onboarding experience after GA. The delegate-key recovery flow below works today and matches the current dashboard behavior. The wider existing-user experience, including console visibility for existing Walrus assets, is on the near-term product roadmap.
</Info>

## Your account is not tied to one device

Walrus Memory stores your memories as encrypted blobs on Walrus and records your account and its permissions on Sui. Neither depends on your browser. When you connect the same wallet again, whether a week later or on a different machine, the same account and the same memories are still yours.

The one thing that stays local is the delegate key. A delegate key is a keypair your account authorizes to read and write memory on your behalf. The dashboard keeps it in the browser you created it in, so a new browser starts without it. Expect this; recovering takes a single step.

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

    Because your account's owner and delegates enforce access control onchain, any delegate key registered to the account can decrypt its memories. The new key you just created reads the memories you wrote with the old one. You do not need to recover the old key.
  </Step>
</Steps>

<Note>
Losing a delegate key does not lose your memories. The key is a credential for reaching your account, not the account itself. Create a new one and your memories are still there. If a lost key might be exposed, remove it from your account on the dashboard so it can no longer act on your behalf.
</Note>

### Recall already reaches your memories

The search index lives in the relayer's database, not your browser, scoped to your account and namespace. Once you have a delegate key on the new device, recall reaches your existing memories straight away, with nothing to rebuild.

You only run restore when the relayer's index itself is missing rows, for example after a database loss or reset, or when you point a fresh self-hosted relayer at your account. Restore rediscovers the blobs your account owns in a namespace and re-indexes any the relayer does not already have:

```ts
const result = await memwal.restore("personal");
console.log(`restored=${result.restored} skipped=${result.skipped} total=${result.total}`);
```

Restore inspects your onchain blobs newest-first, bounded by `limit` (default 10), so `total` is the number of blobs it inspected in that call, not a full count of your namespace. Restore has no pagination cursor, so repeating a call at the same limit re-inspects the same newest blobs and returns nothing new. To rebuild a large namespace, rerun restore with a progressively higher `limit` until `restored` stops increasing. For how restore works, see [How Storage Works](/fundamentals/architecture/how-storage-works).

## Walrus Memory does not migrate existing data

If you already store files on Walrus directly, expect a clear boundary: Walrus Memory does not import those blobs as memories. There is no migration step, by design. Existing Walrus assets also do not appear in the console yet; surfacing them there is on the near-term product roadmap.

A memory is not just a blob. When Walrus Memory stores a memory, it encrypts the content with Seal, attaches namespace metadata, and generates a vector embedding so recall can match the memory by meaning. An arbitrary blob you uploaded to Walrus through another tool has none of that structure, so Walrus Memory cannot treat it as a memory or return it from recall.

To bring existing content into Walrus Memory, write it through the SDK, which produces a proper memory:

```ts
await memwal.rememberAndWait("Content you want to carry into Walrus Memory.");
```

<Note>
Re-uploading is not a loss of ownership. You still own the original Walrus blobs, and re-uploading through the SDK creates a new, encrypted, searchable memory that you also own. Your data stays yours throughout.
</Note>

This boundary runs the other way too. Deleting a memory in Walrus Memory does not touch any separate Walrus blob you uploaded elsewhere, because they are different objects with different owners and lifecycles.

## Onchain privacy

Walrus Memory keeps your content private but your ownership public. Know which is which before you rely on it.

- **Walrus Memory keeps your content private.** It Seal-encrypts every memory before the memory reaches Walrus, and only your account's owner and delegates can decrypt it. No one else reads your memories, including the relayer operator when you use client-managed encryption.
- **Anyone can see your ownership.** Sui shows the `Blob` objects your wallet owns, along with metadata such as blob IDs, sizes, expiry epochs, and the namespace label. Anyone inspecting the chain can see that your address owns blobs and how many, even though they cannot read the contents.
- **Anyone can read namespace labels.** A namespace is an organizing label attached as metadata, not a private field. Avoid putting sensitive information in a namespace name.

<Warning>
Treat namespace names and the fact that your wallet owns memory as public. Keep anything sensitive inside the memory content, which Walrus Memory encrypts, and never in a namespace label or other metadata, which it does not.
</Warning>

For the full ownership and access model, see [Ownership and Delegates](/fundamentals/concepts/ownership-and-access).
