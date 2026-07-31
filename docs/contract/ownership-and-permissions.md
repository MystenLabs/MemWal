---
title: "Ownership and Permissions"
description: >-
  Explains the ownership and permission model for Walrus Memory accounts, including owner capabilities, delegate key permissions, SEAL access control via seal_approve, and how the onchain contract and relayer enforce the permission boundary together.
keywords:
  - Walrus Memory
  - MemWal
  - ownership
  - permissions
  - SEAL access control
  - delegate permissions
goal:
  description: Distinguish what owners vs. delegates can do in a MemWalAccount, explain how SEAL enforces per-blob access control, and apply the permission model when designing multi-user agent workflows.
  requires:
    - has_frontmatter:
        - title
        - description
        - keywords
      label: Has required frontmatter fields
    - min_words: 200
      label: Needs more content depth
    - has_questions: true
      label: Needs questions for AI search visibility
    - has_answer: true
      label: Needs answer summary for AI citation
questions:
  - "What permissions do Walrus Memory account owners have?"
  - "What can delegate keys do in MemWal?"
  - "How does SEAL access control work in Walrus Memory?"
answer: >-
  Walrus Memory uses a layered permission model where the account owner has full control (manage keys, activate/deactivate), delegates can store and recall memories but cannot modify account settings, and the SEAL seal_approve function grants decryption access to owners and registered delegates on active accounts. The relayer verifies every request against the onchain contract, ensuring that permissions are cryptographically enforced on Sui.
---

## Owner

The owner is the Sui wallet address recorded by the `MemWalAccount`. The owner can:

- Add and remove delegate keys
- Deactivate (freeze) and reactivate the account when no Admin quarantine is active
- Decrypt any memory encrypted under their address via SEAL

Each Sui address can only create **one** MemWalAccount (enforced by the `AccountRegistry`).

## Delegate

A delegate key authenticates API calls through the relayer. Delegates can:

- Store memories (`remember`, `analyze`)
- Recall memories (`recall`)
- Restore namespaces (`restore`)
- Decrypt SEAL-encrypted content (via `seal_approve`)

Delegates **cannot**:

- Add or remove other delegate keys
- Deactivate or reactivate the account
- Transfer ownership

## SEAL Access Control

The contract's `seal_approve` function is the SEAL policy that controls who can decrypt memories. Every key ID must end with `BCS(owner_address) ‖ BCS(access_counter_version)` — the owner's 32 bytes followed by the account's 8-byte little-endian rotation counter. Anything may precede that tail; the SDK puts a namespace there. This tail check applies to owners and delegates alike. Given it, access is granted if the caller is:

1. **The data owner** — the caller is the account owner
2. **A registered delegate** — the caller's Sui address is in the account's `delegate_keys` list

The account must also be **active** (not frozen). If the account is deactivated, all SEAL access is denied.

Delegate authorization is account-wide. A namespace changes the SEAL identity,
but it does not stop another delegate on the same account from requesting that key.

### The rotation counter

SEAL derives one *reusable* key per identity, so an identity fixed at `BCS(owner)` would let any delegate who ever fetched that key keep decrypting new memories forever — removing them onchain would never touch the copy in their hands. Tailing the ID with `access_counter_version` fixes this: withdrawing access (removing a delegate, freezing the account) bumps the counter, which changes the identity, which yields a key the removed delegate cannot fetch.

Two rules follow, and clients must respect both:

- **`seal_approve` rejects any counter above the account's current one.** Otherwise a delegate authorized *right now* could pre-fetch keys for every future identity and make rotation a no-op. Older counters stay approvable, so owners keep access to their history.
- **Read the counter fresh from chain immediately before encrypting** — never cache it, never accept it from a request body. Encrypting under a stale counter hands the data straight back to the delegate you just removed.

Rotation is forward-only: memories already written under an older counter stay readable with the older key. Retracting those requires re-encryption.

## Permission Boundary

These are separate layers that work together:

| Layer | Controls | Enforced by |
|-------|----------|-------------|
| **Owner** | Account control — keys, activation, ownership | Sui smart contract |
| **Delegate** | Application access — read/write memory | Sui smart contract + relayer verification |
| **Relayer** | Backend execution — encryption, storage, search | Server-side auth middleware |

The relayer verifies every request against the onchain contract before executing any operation. Even if the relayer is compromised, it cannot forge delegate permissions or change ownership — those are cryptographically enforced onchain.
