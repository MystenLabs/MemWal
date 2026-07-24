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
  description: Understand the layered permission model of Walrus Memory accounts, including what owners and delegates can do and how SEAL access control is enforced.
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
  - "What permissions do Walrus Memory account owners have?"
  - "What can delegate keys do in MemWal?"
  - "How does SEAL access control work in Walrus Memory?"
answer: >-
  Walrus Memory uses a layered permission model where the account owner has full control (manage keys, activate/deactivate), delegates can store and recall memories but cannot modify account settings, and the SEAL seal_approve function grants decryption access to owners and registered delegates on active accounts. The relayer verifies every request against the onchain contract, ensuring that permissions are cryptographically enforced on Sui.
---

## Owner

The owner is the Sui wallet address that created the `MemWalAccount`. The owner has full control:

- Add and remove delegate keys
- Deactivate (freeze) and reactivate the account
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

The contract's `seal_approve` function is the SEAL policy that controls who can decrypt memories. Access is granted if the caller is:

1. **The data owner** — the key ID ends with the BCS-encoded owner address and the caller is the account owner
2. **A registered delegate** — the caller's Sui address is in the account's `delegate_keys` list

The account must also be **active** (not frozen). If the account is deactivated, all SEAL access is denied.

## Permission Boundary

These are separate layers that work together:

| Layer | Controls | Enforced by |
|-------|----------|-------------|
| **Owner** | Account control — keys, activation, ownership | Sui smart contract |
| **Delegate** | Application access — read/write memory | Sui smart contract + relayer verification |
| **Relayer** | Backend execution — encryption, storage, search | Server-side auth middleware |

The relayer verifies every request against the onchain contract before executing any operation. Even if the relayer is compromised, it cannot forge delegate permissions or change ownership — those are cryptographically enforced onchain.
