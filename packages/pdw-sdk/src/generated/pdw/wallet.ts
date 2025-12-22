/**************************************************************
 * THIS FILE IS GENERATED AND SHOULD NOT BE MANUALLY MODIFIED *
 **************************************************************/


/**
 * @deprecated This module is DEPRECATED - use pdw::capability instead
 * 
 * MIGRATION NOTICE: ================= This module used dynamic fields for context
 * management. The new pdw::capability module uses standalone MemoryCap objects.
 * 
 * Benefits of new architecture:
 * 
 * - No MainWallet object management needed
 * - Standard Sui object ownership
 * - SEAL-compliant PrivateData pattern
 * - Simpler cross-dApp data sharing
 * 
 * See CAPABILITY-ARCHITECTURE-SUMMARY.md for details.
 * 
 * @deprecated Use pdw::capability::MemoryCap instead
 */

import { MoveStruct, normalizeMoveArguments, type RawTransactionArgument } from '../utils/index.js';
import { bcs } from '@mysten/sui/bcs';
import { type Transaction } from '@mysten/sui/transactions';
import * as object from './deps/sui/object.js';
const $moduleName = '@local-pkg/pdw::wallet';
export const UserProfile = new MoveStruct({ name: `${$moduleName}::UserProfile`, fields: {
        id: object.UID,
        owner: bcs.Address,
        created_at: bcs.u64()
    } });
export const UserProfileCreated = new MoveStruct({ name: `${$moduleName}::UserProfileCreated`, fields: {
        profile_id: bcs.Address,
        owner: bcs.Address,
        created_at: bcs.u64()
    } });
export interface CreateUserProfileOptions {
    package?: string;
    arguments?: [
    ];
}
/**
 * @deprecated Use pdw::capability::create_memory_cap instead Create a simple user
 * profile (for backward compatibility)
 */
export function createUserProfile(options: CreateUserProfileOptions = {}) {
    const packageAddress = options.package ?? '@local-pkg/pdw';
    return (tx: Transaction) => tx.moveCall({
        package: packageAddress,
        module: 'wallet',
        function: 'create_user_profile',
    });
}
export interface GetOwnerArguments {
    profile: RawTransactionArgument<string>;
}
export interface GetOwnerOptions {
    package?: string;
    arguments: GetOwnerArguments | [
        profile: RawTransactionArgument<string>
    ];
}
/** Get profile owner */
export function getOwner(options: GetOwnerOptions) {
    const packageAddress = options.package ?? '@local-pkg/pdw';
    const argumentsTypes = [
        `${packageAddress}::wallet::UserProfile`
    ] satisfies string[];
    const parameterNames = ["profile"];
    return (tx: Transaction) => tx.moveCall({
        package: packageAddress,
        module: 'wallet',
        function: 'get_owner',
        arguments: normalizeMoveArguments(options.arguments, argumentsTypes, parameterNames),
    });
}
export interface GetProfileIdArguments {
    profile: RawTransactionArgument<string>;
}
export interface GetProfileIdOptions {
    package?: string;
    arguments: GetProfileIdArguments | [
        profile: RawTransactionArgument<string>
    ];
}
/** Get profile ID */
export function getProfileId(options: GetProfileIdOptions) {
    const packageAddress = options.package ?? '@local-pkg/pdw';
    const argumentsTypes = [
        `${packageAddress}::wallet::UserProfile`
    ] satisfies string[];
    const parameterNames = ["profile"];
    return (tx: Transaction) => tx.moveCall({
        package: packageAddress,
        module: 'wallet',
        function: 'get_profile_id',
        arguments: normalizeMoveArguments(options.arguments, argumentsTypes, parameterNames),
    });
}
export interface DeleteProfileArguments {
    profile: RawTransactionArgument<string>;
}
export interface DeleteProfileOptions {
    package?: string;
    arguments: DeleteProfileArguments | [
        profile: RawTransactionArgument<string>
    ];
}
/** Delete user profile */
export function deleteProfile(options: DeleteProfileOptions) {
    const packageAddress = options.package ?? '@local-pkg/pdw';
    const argumentsTypes = [
        `${packageAddress}::wallet::UserProfile`
    ] satisfies string[];
    const parameterNames = ["profile"];
    return (tx: Transaction) => tx.moveCall({
        package: packageAddress,
        module: 'wallet',
        function: 'delete_profile',
        arguments: normalizeMoveArguments(options.arguments, argumentsTypes, parameterNames),
    });
}