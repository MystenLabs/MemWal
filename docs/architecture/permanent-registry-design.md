---
title: "Permanent Registry Design"
description: >-
  Design rationale for the permanent append-only AccountRegistry in Walrus Memory,
  explaining why account entries are never removed to prevent Sybil attacks,
  ensure deterministic indexing, and maintain SEAL access integrity.
keywords:
  - Walrus Memory
  - MemWal
  - AccountRegistry
  - permanent registry
  - architecture
  - SEAL
goal:
  description: Understand why the Walrus Memory AccountRegistry is designed as a permanent append-only mapping and the security implications of this design.
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
  - "Why is the Walrus Memory AccountRegistry permanent and append-only?"
  - "What happens when a MemWal account is deactivated?"
  - "How does the permanent registry prevent Sybil attacks in Walrus Memory?"
answer: >-
  The AccountRegistry is a permanent append-only mapping so that each address can only
  create one MemWalAccount. Account deletion is treated as deactivation rather than
  erasure, preventing duplicate Sybil accounts, preserving deterministic indexing for
  off-chain systems, and ensuring SEAL encryption identity maps to a single stable
  on-chain policy object.
---

# Permanent Registry Design Intent

## Overview
The `AccountRegistry` shared object in Walrus Memory is designed as a *permanent* append-only mapping of `owner_address -> account_id`. Even if a user decides to deactivate or "delete" their account, their address remains in the registry.

## Security & Architecture Rationale
1. **Preventing Duplicate Sybil Accounts:**
   By maintaining a permanent record, we ensure that an address can only ever create exactly *one* MemWalAccount. This simplifies off-chain indexing and prevents abuses related to account recreation.
   
2. **Deterministic Indexing:**
   Indexers rely on a strict 1:1 mapping between a user's wallet address and their Walrus Memory storage container. If accounts could be deleted and recreated with a different ID, historical data queries and relational integrity off-chain would be compromised.

3. **Data Immutability Context:**
   In Web3, identity is persistent. The "deletion" of an account in Walrus Memory is treated as a *deactivation* (freezing) rather than true erasure, which aligns with blockchain state patterns. The account remains frozen, preserving the historical linkage.

4. **SEAL Access Integrity:**
   If an address could recreate its account, old data encrypted under the same SEAL Key ID (`bcs(address)`) could become unpredictably accessible or orphaned depending on the new configuration. A permanent registry guarantees that the encryption identity mathematically maps to a single, stable on-chain policy object forever.
