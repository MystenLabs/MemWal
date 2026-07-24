---
title: "Managed Relayer"
description: >-
  Use the Walrus Foundation-hosted managed relayer to get started with Walrus Memory without running infrastructure. Covers available endpoints, minimal SDK configuration, and the trust and availability trade-offs of the shared deployment.
keywords:
  - Walrus Memory
  - MemWal
  - managed relayer
  - public relayer
  - hosted endpoint
  - getting started
goal:
  description: Connect to the managed Walrus Memory relayer and understand the trade-offs of using the shared hosted deployment.
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
  - "What is the Walrus Memory managed relayer URL?"
  - "How do I connect to the public MemWal relayer?"
  - "What are the trade-offs of using the managed Walrus Memory relayer?"
answer: >-
  The Walrus Foundation hosts managed relayer endpoints for production (mainnet) at relayer.memory.walrus.xyz and staging (testnet) at relayer-staging.memory.walrus.xyz. The managed relayer provides the fastest integration path but involves trusting the hosted instance with plaintext during encryption, sharing the deployment with other users, and accepting beta availability without SLA guarantees.
---

A managed relayer is a simpler experience for teams that want to get started without running infrastructure. If a managed relayer endpoint is available for your environment, it gives you the fastest path to integration.

## Walrus Foundation hosted endpoints

| Network | Relayer URL |
|---|---|
| **Production** (mainnet) | `https://relayer.memory.walrus.xyz` |
| **Staging** (testnet) | `https://relayer-staging.memory.walrus.xyz` |

## Minimal Config

```ts
import { MemWal } from "@mysten-incubation/memwal";

const memwal = MemWal.create({
  key: "<your-ed25519-private-key>",
  accountId: "<your-memwal-account-id>",
  serverUrl: "https://relayer.memory.walrus.xyz",
  namespace: "demo",
});
```

## What to Know

- **Shared App ID** - all users of the managed relayer share the same Walrus Memory package ID. Your data is isolated by your own `owner + namespace` (Memory Space), but the underlying deployment is shared.
- **Trust assumption** - the relayer sees plaintext during encryption and embedding. By using the managed relayer, you're trusting the Walrus Foundation-hosted instance with that data. See [Trust & Security Model](/fundamentals/architecture/data-flow-security-model) for details.
- **Availability** - the managed relayer is a managed beta service. There are no SLA guarantees.
- **Storage costs** - the server wallet covers Walrus storage fees. Usage limits may apply during beta.

If you need full control over the trust boundary or your own dedicated instance, see [Self-Hosting](/relayer/self-hosting).
