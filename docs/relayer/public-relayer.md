---
title: "Managed Relayer"
---

A managed relayer is a simpler experience for teams that want to get started without running infrastructure. If a managed relayer endpoint is available for your environment, it gives you the fastest path to integration.

## Walrus Foundation hosted endpoints

| Network | Relayer URL |
|---|---|
| **Production** (mainnet) | `https://relayer.memwal.ai` |
| **Staging** (testnet) | `https://relayer.staging.memwal.ai` |

## Minimal Config

```ts
import { MemWal } from "@mysten-incubation/memwal";

const memwal = MemWal.create({
  key: "<your-ed25519-private-key>",
  accountId: "<your-memwal-account-id>",
  serverUrl: "https://relayer.memwal.ai",
  namespace: "demo",
});
```

## What to Know

- **Shared App ID** - all users of the managed relayer share the same MemWal package ID. Your data is isolated by your own `owner + namespace` (Memory Space), but the underlying deployment is shared.
- **Trust assumption** - the relayer sees plaintext during encryption and embedding. By using the managed relayer, you're trusting the Walrus Foundation-hosted instance with that data. See [Trust & Security Model](/fundamentals/architecture/data-flow-security-model) for details.
- **Availability** - the managed relayer is a managed beta service. There are no SLA guarantees.
- **Storage costs** - the server wallet covers Walrus storage fees. Usage limits may apply during beta.

If you need full control over the trust boundary or your own dedicated instance, see [Self-Hosting](/relayer/self-hosting).
