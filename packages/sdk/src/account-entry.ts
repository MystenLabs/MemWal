/**
 * @mysten-incubation/memwal/account
 *
 * Account management entry point — on-chain operations.
 * Requires @mysten/sui as a peer dependency.
 *
 * @example
 * ```typescript
 * import { createAccount, addDelegateKey, generateDelegateKey } from "@mysten-incubation/memwal/account"
 * ```
 */

// Account management (on-chain: create account, add/remove delegate keys)
export { createAccount, addDelegateKey, removeDelegateKey, generateDelegateKey } from "./account.js";

// V2 namespace PTBs + Seal wrap of the namespace DEK
export {
    namespaceSealKeyId,
    wrapNamespaceDek,
    generateAndWrapNamespaceDek,
    createNamespace,
    initializeKey,
    grantAccess,
    revokeAccess,
    rotateKey,
    cancelUninitializedNamespace,
    permissionBits,
} from "./namespace.js";

// Account-related types
export type {
    CreateAccountOpts,
    CreateAccountResult,
    AddDelegateKeyOpts,
    AddDelegateKeyResult,
    RemoveDelegateKeyOpts,
    CreateNamespaceOpts,
    CreateNamespaceResult,
    InitializeKeyOpts,
    GrantAccessOpts,
    RevokeAccessOpts,
    RotateKeyOpts,
    CancelUninitializedNamespaceOpts,
    WrapNamespaceDekOpts,
    WrapNamespaceDekResult,
    GenerateAndWrapNamespaceDekOpts,
    GenerateAndWrapNamespaceDekResult,
} from "./types.js";
