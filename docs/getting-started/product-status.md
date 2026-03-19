# Product Status

MemWal is currently in **beta**.

## What That Means

- the main protocol pieces exist in this repo
- the recommended path is the relayer-backed SDK
- `namespace`, `restore`, and manual client flow are already part of the current design
- APIs and operational guidance may still change

## Supported Surfaces

- `MemWal.create(...)`
- `remember`, `recall`, `analyze`, `restore`
- `MemWalManual`
- `withMemWal`
- relayer-backed integration with a delegate key

## What To Expect

- use the documented SDK flows first
- keep namespaces explicit
- treat the public relayer as a managed beta surface
- expect lower-level helper APIs to evolve faster than the main flow

## Contributions Welcome

- bug reports
- docs fixes
- examples
- integration feedback
- implementation improvements
