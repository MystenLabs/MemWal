---
title: "Cloudflare Workers"
description: "Run MemWal on the Cloudflare Workers edge runtime — required flags, bundling notes, and a crash-isolation pattern."
---

MemWal runs on the [Cloudflare Workers](https://developers.cloudflare.com/workers/) runtime, but the edge environment differs from Node.js in a few ways that affect bundling and reliability. This guide covers the configuration and patterns that make it work cleanly.

## Required configuration

The SDK relies on the Node.js `crypto` built-in (and `@mysten/seal` / `@mysten/sui` pull in more Node APIs). Enable the Node.js compatibility flag in your `wrangler.toml`:

```toml wrangler.toml
compatibility_flags = ["nodejs_compat"]
```

Without `nodejs_compat` the build fails outright — `wrangler deploy` stops with `Could not resolve "crypto"` (the SDK calls `await import("crypto")` internally). Adding the flag resolves it.

## Bundle size

Even the default `MemWal` client requires `@mysten/seal` and `@mysten/sui` as peer dependencies — it builds a SEAL session key on the client to authenticate each request — so it pulls in a sizeable dependency graph. A Worker bundling just the default client comes out to roughly **1.2 MB raw / ~225 KB gzipped** (measured with `wrangler deploy --dry-run`, `@mysten/sui` 2.x). That is comfortably within the Workers size limit, but worth knowing:

- A single incompatible peer version can break the build for the **entire** Worker, not just the memory feature. Pin your `@mysten/*` versions and treat the memory dependency as a unit.
- The default `@mysten-incubation/memwal` entry point is the lightest to bundle: the relayer handles embeddings and Walrus storage server-side, so the client only needs `@mysten/seal` + `@mysten/sui` (both required peers). The `@mysten-incubation/memwal/manual` entry point additionally pulls in `@mysten/walrus` and client-side encryption/upload, adding more to the bundle — prefer the default entry point on Workers unless you specifically need the manual flow.

## Crash isolation with dynamic import

To keep a MemWal bundling or runtime issue from taking down the rest of your agent, load it behind a defensive dynamic import and feature-flag it off when config is missing or the client fails to come up. This way the app keeps serving requests even if memory is unavailable for a cycle:

```ts
let memwal: any = null;

try {
  const mod = await import("@mysten-incubation/memwal");
  memwal = mod.MemWal.create({ key, accountId, serverUrl, namespace });
  await memwal.health();
} catch (e) {
  console.log("MemWal unavailable, degrading gracefully:", e);
  memwal = null; // app keeps running without memory this cycle
}
```

Guard your read/write paths on `memwal` being non-null, and the rest of the Worker stays healthy regardless of the memory layer's state.

<Note>
The dynamic `import()` also keeps the heavy dependency graph out of your Worker's cold-start critical path until memory is actually needed.
</Note>

## Next Steps

- [Walrus Memory client](/sdk/usage/memwal) — the default relayer-backed client used above
- [Public relayer](/relayer/public-relayer) — managed mainnet/testnet relayer endpoints
- [API Reference](/sdk/api-reference) — full method signatures and config fields
