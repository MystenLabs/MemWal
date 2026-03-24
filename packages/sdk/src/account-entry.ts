/**
 * @mysten/memwal/account
 *
 * Account management entry point — on-chain operations.
 * Requires @mysten/sui as a peer dependency.
 *
 * @example
 * ```typescript
 * import { createAccount, addDelegateKey, generateDelegateKey } from "@mysten/memwal/account"
 * ```
 */

// Account management (on-chain: create account, add/remove delegate keys)
export { createAccount, addDelegateKey, removeDelegateKey, generateDelegateKey } from "./account.js";

// Account-related types
export type {
    CreateAccountOpts,
    CreateAccountResult,
    AddDelegateKeyOpts,
    AddDelegateKeyResult,
    RemoveDelegateKeyOpts,
} from "./types.js";
