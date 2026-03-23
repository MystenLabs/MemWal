---
title: "Public Relayer"
---

The public relayer is the fastest way to evaluate MemWal during beta.

## Use It When

- you are testing the SDK
- you want to validate namespace-aware flows quickly
- you want to try `remember`, `recall`, `analyze`, and `restore` before self-hosting

## Minimal Config

```ts
import { MemWal } from "@cmdoss/memwal";

const memwal = MemWal.create({
  key: process.env.MEMWAL_PRIVATE_KEY!,
  serverUrl: process.env.MEMWAL_SERVER_URL!,
  namespace: "demo",
});
```

## Good Evaluation Flow

1. call `health()`
2. store one memory with `remember()`
3. retrieve it with `recall()`
4. try `analyze()` on a longer passage
5. use `restore()` only when you want to validate recovery behavior

## Assume This

- the public relayer is a managed beta surface
- the documented routes are the supported surface
- your integration should set a namespace explicitly

## Self-Host Instead If You Need

- your own infra and credentials
- tighter operational guarantees
- your own rollout control
