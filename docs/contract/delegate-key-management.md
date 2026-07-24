---
title: "Delegate Key Management"
description: >-
  Guide to the delegate key lifecycle in Walrus Memory, covering key generation, onchain registration, SDK usage, revocation, limits, and account deactivation as an emergency kill switch.
keywords:
  - Walrus Memory
  - MemWal
  - delegate key
  - Ed25519
  - key management
  - authentication
goal:
  description: Generate a delegate key pair, register it onchain to a MemWalAccount, authenticate SDK requests with it, and revoke it when access should end.
  requires:
    - has_frontmatter:
        - title
        - description
        - keywords
      label: Has required frontmatter fields
    - min_words: 300
      label: Needs more content depth
    - has_questions: true
      label: Needs questions for AI search visibility
    - has_answer: true
      label: Needs answer summary for AI citation
questions:
  - "How do I create and register a delegate key for Walrus Memory?"
  - "How do I revoke a MemWal delegate key?"
  - "What is the delegate key limit per Walrus Memory account?"
answer: >-
  Delegate keys are lightweight Ed25519 keypairs used for Walrus Memory SDK authentication. They are generated client-side, registered onchain in a MemWalAccount by the owner, and verified by the relayer on every request. Each account supports up to 20 delegate keys, and the owner can revoke any key or deactivate the entire account as an emergency kill switch.
---

Delegate keys are lightweight Ed25519 keys used for SDK authentication. They are registered onchain in a `MemWalAccount` and verified by the relayer on every request.

## Why They Exist

- Apps need a usable key for API calls without exposing the owner wallet
- Users should not hand over the owner wallet for day-to-day memory access
- Different apps or devices can each have their own delegate key with a descriptive label

## Lifecycle

### 1. Generate a delegate keypair

Use the SDK's `generateDelegateKey()` helper to create a new Ed25519 keypair:

```ts
import { generateDelegateKey } from "@mysten-incubation/memwal/account";

const delegate = await generateDelegateKey();
// delegate.privateKey — hex string, store securely
// delegate.publicKey — 32-byte Uint8Array
// delegate.suiAddress — derived Sui address (0x...)
```

### 2. Register the public key onchain

Only the account owner can add delegate keys:

```ts
import { addDelegateKey } from "@mysten-incubation/memwal/account";

await addDelegateKey({
  packageId: "0x...",
  accountId: "0x...",
  publicKey: delegate.publicKey,
  label: "MacBook Pro",
  suiPrivateKey: "suiprivkey1...", // or walletSigner
});
```

### 3. Use the private key in the SDK

```ts
import { MemWal } from "@mysten-incubation/memwal";

const memwal = MemWal.create({
  key: delegate.privateKey,
  accountId: "0x...",
});
```

### 4. Revoke the delegate key

Removing a delegate key prevents future relayer access from that key:

```ts
import { removeDelegateKey } from "@mysten-incubation/memwal/account";

await removeDelegateKey({
  packageId: "0x...",
  accountId: "0x...",
  publicKey: delegate.publicKey,
  suiPrivateKey: "suiprivkey1...", // or walletSigner
});
```

## Limits

- Each account supports up to **20 delegate keys**
- Each delegate key must be a valid 32-byte Ed25519 public key
- Duplicate keys are rejected (error code 0)
- Only the account owner can add or remove delegate keys

## Account Deactivation

An account owner can deactivate (freeze) their account. When deactivated:

- SEAL decryption access is denied for all keys (owner and delegates)
- Delegate keys cannot be added or removed
- The owner can reactivate the account at any time

This is useful as an emergency kill switch if a key is compromised.
