---
title: "Trust & Security Model"
description: "Where trust lives in MemWal — what's enforced onchain, what's handled by the relayer, and what trade-offs exist."
---

MemWal's security model is split between onchain enforcement and offchain operations. Understanding where trust lives helps you make informed decisions about your deployment.

## What's enforced onchain

These guarantees are cryptographic and tamper-proof — no one can bypass them:

- **Ownership** — only the owner's private key controls a MemWal account
- **Delegate authorization** — delegate keys are registered and verified onchain
- **Access control** — the smart contract determines who can act on an account

Even a compromised relayer cannot change who owns an account or forge delegate permissions.

## Where the relayer is trusted

The relayer abstracts Web3 complexity to give developers a simple REST API. This convenience comes with a trust trade-off — the relayer handles sensitive operations on behalf of users:

| What the relayer sees | Why |
|----------------------|-----|
| Plaintext memory content | It generates embeddings and encrypts before storing |
| Decrypted content on recall | It decrypts blobs to return results to the SDK |
| Vector embeddings | It stores and searches them for semantic recall |

This means the **relayer operator can see your data in transit**. This is similar to how a traditional backend API works — your server sees the data it processes.

## Mitigating relayer trust

You have options depending on your trust requirements:

| Option | Trust level | What the relayer sees |
|--------|------------|----------------------|
| **Managed relayer** | You trust Walrus Foundation | Plaintext content, embeddings, decrypted results |
| **Self-hosted relayer** | You trust your own infra | Same as above, but under your control |
| **Manual client flow** | Minimal trust | Only encrypted payloads and pre-computed vectors — never plaintext |

- **Use the managed relayer** — convenient for getting started and prototyping. You trust Walrus Foundation to operate it responsibly.
- **Self-host your own relayer** — you control the infrastructure, so the trust boundary is entirely yours. No third party sees your data.
- **Manual client flow** — use `MemWalManual` to handle encryption and embedding entirely on the client side. The relayer only sees encrypted payloads and vectors, never plaintext. This is recommended for Web3-native users who want full control over their data and are comfortable managing keys, signing, and SEAL operations directly.

## What lives where

```mermaid
flowchart LR
    subgraph Onchain [Onchain — trustless]
        Contract[Ownership & delegates]
    end
    subgraph Offchain [Offchain — operator trust]
        Relayer[Encryption, embeddings, orchestration]
        DB[Vector search & caching]
    end
    subgraph Decentralized [Decentralized — durable]
        Walrus[Encrypted blobs]
    end

    Contract -. verifies .-> Relayer
    Relayer --> DB
    Relayer --> Walrus
```

- **Onchain (trustless)**: ownership, delegate keys, access control — enforced by Sui smart contracts
- **Offchain (operator trust)**: encryption, embedding, search — handled by the relayer and indexed database
- **Decentralized (durable)**: encrypted memory payloads — stored on Walrus, no single point of failure

## Authentication flow

Every protected API call goes through Ed25519 signature verification:

1. The SDK signs a message: `{timestamp}.{method}.{path}.{body_sha256}` using the delegate private key
2. The relayer verifies the Ed25519 signature against the provided public key
3. Timestamps must be within a **5-minute window** to prevent replay attacks
4. The relayer resolves the public key to a `MemWalAccount` using the priority chain: cache → indexed accounts → onchain registry → header hint → config fallback
5. The onchain account is fetched to verify the delegate key is registered in `delegate_keys`
6. The resolved owner address is used to scope all subsequent operations

## Current status

This describes the production beta model. The trust boundaries are designed to evolve — future versions may introduce client-side encryption by default or additional verifiability layers. Self-hosting remains the strongest option for teams that need full control today.
