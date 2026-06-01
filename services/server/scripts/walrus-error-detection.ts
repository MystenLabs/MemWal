/**
 * Detect a Walrus MoveAbort caused by an on-chain package version mismatch
 * (i.e. the cached @mysten/walrus client carries package metadata older than
 * what the Walrus system object now points to).
 *
 * The Walrus runtime surfaces this as a MoveAbort raised from
 * `walrus::system::inner_mut` with abort code 1 (EWrongVersion in
 * `contracts/walrus/sources/system.move`).
 *
 * `@mysten/walrus` (via `@mysten/sui`'s `formatMoveAbortMessage`) renders the
 * message in two transport-dependent shapes:
 *   - JSON-RPC (common):  "MoveAbort in 1st command, abort code: 1,
 *                          in '0x<hex>::system::inner_mut' (instruction N)"
 *   - gRPC / GraphQL:     "MoveAbort in 1st command, 'EWrongVersion': <v>,
 *                          in '0x<hex>::system::inner_mut' (line N)"
 *
 * The package component is always a numeric hex address — never the literal
 * "walrus" — so the cross-transport anchor is the `::system::inner_mut`
 * location fragment. We also match the symbolic `EWrongVersion` token when
 * present (gRPC/GraphQL clients).
 *
 * Case-insensitive. Requires `MoveAbort` alongside the anchor so an
 * unrelated log line mentioning "EWrongVersion" won't trigger a refresh.
 */
export function isWalrusPackageVersionMismatch(message: string): boolean {
    if (!message) return false;
    if (!/moveabort/i.test(message)) return false;
    return /::system::inner_mut/i.test(message) || /ewrongversion/i.test(message);
}

/**
 * Detect a Sui owned-object lock / equivocation error: a specific
 * object+version is locked to a competing transaction, so the transaction is
 * rejected by >1/3 of validator stake and is non-retriable within the epoch.
 * Retrying re-fails against the same locked object until the lock clears
 * (typically the next epoch boundary).
 *
 * Mirrors the Rust classifier in `services/server/src/jobs.rs`
 * (`classify_sidecar_error` → `ObjectLockedUntilEpoch`); keep both in sync.
 * Distinct from the recoverable `locked at version` case, where a retry can
 * rebuild against a fresh version.
 */
export function isWalrusObjectLockEquivocation(message: string): boolean {
    if (!message) return false;
    return /already locked by a different transaction/i.test(message)
        || /rejected as invalid by more than 1\/3 of validators by stake/i.test(message)
        || /non-retriable/i.test(message)
        || /equivocated|equivocation/i.test(message)
        || /reserved for another transaction/i.test(message);
}
