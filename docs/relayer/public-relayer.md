# Public Relayer

The public relayer is the fastest way to evaluate MemWal during beta.

## When To Use It

- you are testing the SDK
- you want to validate namespace-aware memory flows quickly
- you want to try `remember`, `recall`, `analyze`, and `restore` before self-hosting
- you do not want to provision PostgreSQL, Sui RPC, Walrus, and the sidecar yet

## Minimal Configuration

```ts
import { MemWal } from "@cmdoss/memwal";

const memwal = MemWal.create({
  key: process.env.MEMWAL_PRIVATE_KEY!,
  serverUrl: process.env.MEMWAL_SERVER_URL!,
  namespace: "demo",
});
```

## Recommended Evaluation Flow

1. call `health()`
2. store one memory with `remember()`
3. retrieve it with `recall()`
4. try `analyze()` on a longer passage
5. use `restore()` only when you want to validate recovery behavior for a namespace

## What To Assume

- the public relayer is a managed beta surface
- the default documented routes are the supported surface
- your integration should set a namespace explicitly
- public relayer behavior may change faster than a self-hosted deployment contract

## When To Self-Host Instead

Prefer self-hosting if you need:

- tighter operational guarantees
- your own infrastructure and credentials
- more control over relayer rollout timing
- a deployment path that you can pin to your own environment
