# Permanent Registry Design Intent

## Overview
The `AccountRegistry` shared object in MemWal is designed as a *permanent* append-only mapping of `owner_address -> account_id`. Even if a user decides to deactivate or "delete" their account, their address remains in the registry.

## Security & Architecture Rationale
1. **Preventing Duplicate Sybil Accounts:**
   By maintaining a permanent record, we ensure that an address can only ever create exactly *one* MemWalAccount. This simplifies off-chain indexing and prevents abuses related to account recreation.
   
2. **Deterministic Indexing:**
   Indexers rely on a strict 1:1 mapping between a user's wallet address and their MemWal storage container. If accounts could be deleted and recreated with a different ID, historical data queries and relational integrity off-chain would be compromised.

3. **Data Immutability Context:**
   In Web3, identity is persistent. The "deletion" of an account in MemWal is treated as a *deactivation* (freezing) rather than true erasure, which aligns with blockchain state patterns. The account remains frozen, preserving the historical linkage.

4. **SEAL Access Integrity:**
   If an address could recreate its account, old data encrypted under the same SEAL Key ID (`bcs(address)`) could become unpredictably accessible or orphaned depending on the new configuration. A permanent registry guarantees that the encryption identity mathematically maps to a single, stable on-chain policy object forever.
