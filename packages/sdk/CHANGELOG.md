# @mysten-incubation/memwal

## 0.0.2

### Security

- Added per-request `x-nonce` signing to block replay within the timestamp window.
- Added `x-account-id` to the canonical signed message so account hints cannot be rebound in transit.
- Replaced relayer-mode `x-delegate-key` transport with ephemeral `x-seal-session`; manual-mode requests no longer send delegate private key material.
- SDK versions that do not send `x-nonce` are no longer supported by the server and receive `426 Upgrade Required`.

## 0.0.1

### Initial Release

- `MemWal` default client — relayer-handled embedding, SEAL encryption, Walrus upload, vector search
- `MemWalManual` manual client — client-side embedding and SEAL operations
- `withMemWal` Vercel AI SDK middleware — automatic memory recall and save
- Account management utilities — `createAccount`, `addDelegateKey`, `removeDelegateKey`, `generateDelegateKey`
- Ed25519 delegate key authentication
- Namespace-scoped memory isolation
