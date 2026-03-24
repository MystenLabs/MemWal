---
title: "Public Relayer"
---

The public relayer is a managed MemWal deployment for teams that want to get started without running infrastructure. If a public relayer endpoint is available for your environment, it gives you the fastest path to integration.

## Endpoints

| | Value |
|---|---|
| **Relayer URL** | Provided by the relayer operator |
| **Package ID** | Provided by the relayer operator |

If you do not have these values yet, use a local or [self-hosted relayer](/relayer/self-hosting) instead.

## Minimal Config

```ts
import { MemWal } from "@mysten/memwal";

const memwal = MemWal.create({
  key: "<your-ed25519-private-key>",
  accountId: "<your-memwal-account-id>",
  serverUrl: "https://your-relayer-url.com",
  namespace: "demo",
});
```

## What to Know

- **Shared App ID** - all users of the public relayer share the same MemWal package ID. Your data is isolated by your own `owner + namespace` (Memory Space), but the underlying deployment is shared.
- **Trust assumption** - the relayer sees plaintext during encryption and embedding. By using the public relayer, you're trusting the Mysten-hosted instance with that data. See [Trust & Security Model](/fundamentals/architecture/data-flow-security-model) for details.
- **Availability** - the public relayer is a managed beta service. There are no SLA guarantees.
- **Storage costs** - the server wallet covers Walrus storage fees. Usage limits may apply during beta.

If you need full control over the trust boundary or your own dedicated instance, see [Self-Hosting](/relayer/self-hosting).
