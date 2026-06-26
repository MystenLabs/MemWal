# Independently verify a memory

Walrus Memory's core promise is **verifiable, non-custodial memory**: a memory you
write is provable from on-chain data plus the public Walrus network, with **no trust
in the relayer**. This page shows how to demonstrate that property — both with the
`MemWal.verify()` helper and by hand.

The check needs **public inputs only**: a `blobId`, the owning `accountId`, a Sui
fullnode, and the public Walrus aggregator. **No private key and no relayer** are
involved.

## Quick check (SDK)

```ts
import { MemWal } from "@mysten-incubation/memwal";

const report = await MemWal.verify(blobId, {
  accountId,            // owning MemWalAccount object id
  network: "testnet",   // or "mainnet"
});

console.log(report);
// {
//   ok: true,
//   onChain: true,        // Blob object found on Sui with memwal_* metadata
//   agentKeyOk: true,     // memwal_agent_id is a registered DelegateKey pubkey
//   ownerOk: true,
//   walrusReachable: true,// blob served by the public aggregator
//   namespace: "…",
//   metadata: { memwal_namespace: "…", memwal_owner: "0x…", memwal_agent_id: "0x…", … },
//   blobObjectId: "0x…",
//   notes: [],
// }
```

`report.ok` is `true` only when the hard checks pass: `onChain && agentKeyOk &&
walrusReachable` (and `ownerOk` when you pass an `expectedOwner`).

## What it proves, and how

A memory is anchored by a chain of independently checkable links:

```
MemWalAccount ──registers──▶ DelegateKey (public_key)
       │                          │
       │                          │ writes
       ▼                          ▼
  memwal_owner            Walrus Blob object on Sui
                                   │  on-chain Metadata (VecMap<String,String>):
                                   │    memwal_namespace
                                   │    memwal_owner
                                   │    memwal_package_id
                                   │    memwal_agent_id  ◀── equals a registered DelegateKey pubkey
                                   ▼
                    content-addressed encrypted bytes on Walrus
                    (retrievable from the public aggregator, SEAL-encrypted at rest)
```

`verify()` walks that chain:

1. **On-chain provenance** — resolves the `…::blob::Blob` object on Sui and reads its
   `memwal_*` metadata.
2. **Delegate-key binding** — confirms `memwal_agent_id` is one of the `accountId`'s
   registered `DelegateKey` public keys, cryptographically tying the blob to a key the
   account authorized.
3. **Relayer-independent availability** — fetches the blob straight from the public
   Walrus aggregator (`GET /v1/blobs/{blobId}` → `200`); the relayer is never in the path.

## On-chain metadata schema

Each memory's Walrus `Blob` carries this metadata (`VecMap<String, String>`), readable
by anyone via `sui_getObject`:

| Key                  | Meaning                                                    |
| -------------------- | ---------------------------------------------------------- |
| `memwal_namespace`   | Namespace the memory was written under                     |
| `memwal_owner`       | Owner address                                              |
| `memwal_package_id`  | MemWal Move package that wrote it                          |
| `memwal_agent_id`    | Public key of the authorized `DelegateKey` that wrote it   |

> **Privacy note.** Content is SEAL-encrypted at rest, but `memwal_namespace`,
> `memwal_owner`, and `memwal_agent_id` are stored as **public plaintext** on-chain.
> Do not name namespaces after end-users or tenants (e.g. `patient-12345`, `org-acme`)
> if those names are sensitive — they become world-readable. For privacy-sensitive
> integrations, store an opaque/hashed namespace.

## Doing it by hand (no SDK)

1. **Fetch the blob without the relayer:**
   ```
   curl -s -o /dev/null -w "%{http_code} %{size_download}\n" \
     https://aggregator.walrus-testnet.walrus.space/v1/blobs/<blobId>
   ```
   A `200` with non-zero size confirms public availability. The bytes are
   SEAL-encrypted — no plaintext should be visible.

2. **Read the on-chain Blob + metadata** with `sui_getObject` (showContent), and read
   the account with another `sui_getObject` to list its registered `DelegateKey`
   public keys. Confirm `memwal_agent_id` is among them.

That's the entire trust basis: chain + public Walrus, no relayer.

## Roadmap

- **Content-address recompute** (`report.contentAddressed`): recompute the Walrus blob
  id from the downloaded bytes to prove byte-for-byte integrity end-to-end. This needs
  a Walrus encoding dependency and lands as a follow-up.
