---
title: Use Walrus Memory from Any Agent Runtime
description: >-
  Walrus Memory works with agents built on any chain or runtime, including EVM, Base, and Virtuals
  agents. Covers the ownership model, the SDK path, the signed HTTP path for languages with no SDK,
  and what cross-chain does and does not mean here.
keywords:
  - agent runtime
  - EVM
  - Base
  - Virtuals
  - cross-chain
  - multi-chain
  - Walrus Memory
  - MemWal
  - delegate key
  - relayer API
goal:
  description: Connect an agent running on any chain or in any language to Walrus Memory, by registering a delegate key and choosing either an SDK or the signed HTTP API.
  requires:
    - has_frontmatter:
        - title
        - description
        - keywords
      label: Has required frontmatter fields
    - min_words: 300
      label: Needs more content depth
    - pattern: '```'
      min: 2
      label: Has code examples
    - has_questions: true
      label: Needs questions for AI search visibility
    - has_answer: true
      label: Needs answer summary for AI citation
questions:
  - Can I use Walrus Memory with an EVM or Base agent?
  - Does Walrus Memory support cross-chain agents?
  - How do I call Walrus Memory from a language with no SDK?
answer: >-
  Yes. Walrus Memory does not care which chain your agent transacts on, because memory ownership
  lives in a Sui account and your agent authenticates with an Ed25519 delegate key registered on
  that account. An EVM, Base, or Virtuals agent uses Walrus Memory the same way any other agent
  does, either through an SDK or by signing relayer requests directly. Nothing is bridged between
  chains.
---

Agents built on EVM, Base, Virtuals, or any other stack can use Walrus Memory. The runtime your agent executes in and the chain it transacts on are independent of where its memory lives.

That surprises people who expect a bridge, so it is worth stating plainly: **you need not bridge anything.** Walrus Memory stores memories as encrypted blobs on Walrus and records ownership in a Sui account. Your agent proves who it is with an Ed25519 delegate key that the account owner registers on that account. Whether the same agent also signs Ethereum transactions, holds an ERC-20 balance, or runs inside a Virtuals runtime makes no difference to any of that.

## What your agent actually needs

Two things, regardless of language or chain:

1. **Register an Ed25519 delegate key on a Walrus Memory account.** The account owner registers the public key onchain, which grants the agent permission to read and write that account's memory. See [Ownership and Delegates](/fundamentals/concepts/ownership-and-access).
2. **Network access to a relayer.** The relayer performs the encryption, storage, and indexing work, so your agent does not need a Sui node, a Walrus node, or WAL tokens.

What your agent does **not** need: a Sui wallet for its own funds, a bridge, a wrapped token, or any change to how it transacts on its own chain.

## Path 1: use an SDK

If your agent runs in TypeScript or Python, use the SDK. It handles the request signing, the encryption session, and retries for you.

```ts
import { MemWal } from "@mysten-incubation/memwal";

const memwal = MemWal.create({
  key: process.env.MEMWAL_PRIVATE_KEY,
  accountId: process.env.MEMWAL_ACCOUNT_ID,
  // Mainnet relayer. Use https://relayer-staging.memory.walrus.xyz for Testnet.
  serverUrl: "https://relayer.memory.walrus.xyz",
  namespace: "agent-memory",
});

await memwal.health();
await memwal.remember("The user prefers dark mode.");
const hits = await memwal.recall({ query: "user preferences", limit: 5 });
```

For loading credentials from the environment, validating connectivity at boot, and handling credential errors, see [Headless SDK Setup](/sdk/headless-setup). For the write-confirm-recall cycle, see the [Agent Storage Loop](/sdk/agent-storage-loop).

## Path 2: sign requests directly

If your agent runs in a language with no SDK, such as Go, Rust, or Elixir, call the relayer API directly. Every authenticated route takes the same signed headers, so you need an Ed25519 signer, SHA-256, and an HTTP client.

Build the canonical message, sign it, and send the signature as hex:

```text
{timestamp}.{method}.{path_and_query}.{body_sha256}.{nonce}.{account_id}
```

| **Header** | **Value** |
|---|---|
| `x-public-key` | Hex-encoded Ed25519 public key, 32 bytes |
| `x-signature` | Hex-encoded Ed25519 signature of the message above, 64 bytes |
| `x-timestamp` | Unix timestamp in seconds, valid for five minutes |
| `x-nonce` | UUID v4, which the relayer records for replay protection |
| `x-account-id` | The account object ID. Official SDKs always send it and include it in the signed message |

The relayer verifies the signature, then resolves the owner by looking up your public key in the account's onchain delegate keys. For every route, request shape, and response shape, see the [Relayer API Reference](/relayer/api-reference).

```sh
$ curl -sS "$MEMWAL_RELAYER_URL/health"
```

Start with `/health`, which needs no authentication, to confirm the agent can reach the relayer before you debug signing.

## What "cross-chain" does not mean here

Three things are outside what Walrus Memory does, and assuming otherwise leads to designs that cannot work:

1. **No bridging.** Walrus Memory never mirrors, wraps, or relays a memory onto another chain. Ownership records live on Sui.
2. **No EVM-native ownership.** An Ethereum address cannot own a memory account. The delegate key is Ed25519, and the account is a Sui object.
3. **No payment in other tokens.** Walrus charges storage in WAL. Your agent neither holds nor spends it when a relayer fronts that cost.

If your design needs an onchain link between an EVM contract and a memory account, model it in your own application: keep the mapping in your contract or database, and have your agent present the matching delegate key.

## See also

- [Ownership and Delegates](/fundamentals/concepts/ownership-and-access) for how delegate keys grant access.
- [Headless SDK Setup](/sdk/headless-setup) for credentials and boot-time checks in a server runtime.
- [Relayer API Reference](/relayer/api-reference) for the full authenticated surface.
- [How AI Agent Memory Works](/fundamentals/concepts/how-agent-memory-works) for the embed, store, and recall loop.
