# Product Status

MemWal is currently in **beta**.

## What That Means

- the core protocol pieces exist in this repository today
- the recommended path is the relayer-backed SDK
- namespaces, restore, and manual mode are supported
- some APIs and operational details may still change
- docs should follow the current repo, not older MemWal flows

## Current Supported Surfaces

- `MemWal.create(...)` for the default SDK client
- `remember`, `recall`, `analyze`, and `restore`
- namespace-aware storage and retrieval
- `MemWalManual` for the manual client flow
- relayer-backed integration using a delegate key

## What Still Needs Judgment

- the relayer trust boundary
- what happens server-side versus client-side
- how public-relayer usage differs from self-hosting
- how restore depends on on-chain Walrus metadata plus local vector state

## Expectations for Early Integrators

- prefer the documented SDK flows before customizing infrastructure
- treat public relayer usage as a managed beta surface
- keep namespaces explicit in your integration
- expect some lower-level helper APIs to evolve as the SDK and backend converge

## Contributions Welcome

We welcome:

- bug reports
- docs fixes and clarifications
- examples and integration feedback
- implementation improvements through issues and pull requests
