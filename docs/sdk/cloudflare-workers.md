---
title: "Cloudflare Workers"
description: "Run MemWal on the Cloudflare Workers edge runtime — required flags, bundling notes, and a crash-isolation pattern."
---

MemWal runs on the [Cloudflare Workers](https://developers.cloudflare.com/workers/) runtime, but the edge environment differs from Node.js in a few ways that affect bundling and reliability. This guide covers the configuration and patterns that make it work cleanly.

## Required configuration

The `@mysten-incubation/memwal` dependency tree (`@mysten/seal`, `@mysten/sui`, and others) relies on Node.js built-ins at runtime. Enable the Node.js compatibility flag in your `wrangler.toml`:

```toml wrangler.toml
compatibility_flags = ["nodejs_compat"]
```

Without `nodejs_compat`, the dependency tree fails to resolve at runtime even though the Worker bundles successfully.

## Bundle size

`@mysten-incubation/memwal` pulls in a large peer dependency graph. A Worker bundling the default `MemWal` client lands around **~3 MB**. This is within Workers limits but worth knowing:

- A single incompatible peer version can break the build for the **entire** Worker, not just the memory feature. Pin your `@mysten/*` versions and treat the memory dependency as a unit.
- The default `@mysten-incubation/memwal` entry point bundles most cleanly in edge runtimes because the relayer handles embeddings, SEAL, and storage server-side. The `@mysten-incubation/memwal/manual` entry point pulls in client-side SEAL and Walrus operations, adding significantly more to the bundle — prefer the default entry point on Workers unless you specifically need the manual flow.

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
