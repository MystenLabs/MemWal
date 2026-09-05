# SDK workstream summary

Commit: `0da34fb4e647d182897f6cb86a7146a76c65e65e`

## Files changed

- `packages/sdk/src/namespace.ts` (new)
- `packages/sdk/src/utils.ts` — `namespaceSealKeyId` next to `u64ToLeHex`
- `packages/sdk/src/types.ts` — additive V2 namespace option/result types
- `packages/sdk/src/account-entry.ts` — re-exports public API from `@mysten-incubation/memwal/account`
- `packages/sdk/test/namespace.test.mjs` (new)
- `packages/sdk/CHANGELOG.md` — one Added line

## Public API (`@mysten-incubation/memwal/account`)

- `namespaceSealKeyId(namespaceId: string, keyVersion: bigint | number): Uint8Array`
- `wrapNamespaceDek(opts: WrapNamespaceDekOpts): Promise<WrapNamespaceDekResult>`
- `generateAndWrapNamespaceDek(opts: GenerateAndWrapNamespaceDekOpts): Promise<GenerateAndWrapNamespaceDekResult>`
- `createNamespace(opts: CreateNamespaceOpts): Promise<CreateNamespaceResult>`
- `initializeKey(opts: InitializeKeyOpts): Promise<{ digest: string }>`
- `grantAccess(opts: GrantAccessOpts): Promise<{ digest: string }>`
- `revokeAccess(opts: RevokeAccessOpts): Promise<{ digest: string }>`
- `rotateKey(opts: RotateKeyOpts): Promise<{ digest: string }>`
- `cancelUninitializedNamespace(opts: CancelUninitializedNamespaceOpts): Promise<{ digest: string }>`
- `permissionBits(canRead: boolean, canWrite: boolean, canShare: boolean): number` (client validation helper)

## Tests

```
pnpm --filter @mysten-incubation/memwal test
pnpm --filter @mysten-incubation/memwal typecheck
```

Both green. 34 tests passed (12 new in `namespace.test.mjs`), `tsc --noEmit` clean.

Covered: 40-byte seal id; Move golden vectors for key_version 0 / 1 / 10000; grant bit validation; wrap DEK length + encrypt `id`; createNamespace PTB arg order + label 1..=64; initialize_key / cancel_uninitialized_namespace targets.

## Deviations

- Duplicated `buildTxContext` / `signAndExecute` / object-id extract in `namespace.ts` instead of extracting from `account.ts` (file ownership: cannot edit `account.ts`).
- `createNamespace` throws if the created `MemoryNamespace` id is missing from effects (account `createAccount` returns an empty string). Needed so initialize cannot proceed with a blank id.
- `WRITE` without `READ` is auto-upgraded to READ|WRITE; `SHARE` without `READ` is rejected unless `WRITE` already implied READ. All-false is rejected.
- `wrapNamespaceDek` requires a caller-supplied `dek` (32 bytes). Random DEK generation is `generateAndWrapNamespaceDek` only.
- `createNamespace` + `initializeKey` are separate `signAndExecute` calls; never batched with `createAccount`.
