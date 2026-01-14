/**************************************************************
 * THIS FILE IS GENERATED AND SHOULD NOT BE MANUALLY MODIFIED *
 **************************************************************/


/**
 * Capability-based access control module for Personal Data Wallet
 *
 * This module implements the SEAL PrivateData pattern for simplified access
 * control using Move's capability pattern.
 *
 * Key benefits:
 *
 * - 1 user wallet instead of N HD wallets
 * - Object ownership = access permission (SEAL idiomatic)
 * - No global registry needed
 * - 60% gas savings vs allowlist pattern
 * - Type-safe access control
 *
 * Pattern combines:
 *
 * - Move Capability Pattern (object = proof of permission)
 * - SEAL PrivateData (nonce-based key derivation)
 * - PDW Requirements (app contexts)
 *
 * Reference:
 * https://github.com/MystenLabs/seal/blob/main/move/patterns/sources/private_data.move
 */

import { MoveStruct, normalizeMoveArguments, type RawTransactionArgument } from '../utils/index.js';
import { bcs } from '@mysten/sui/bcs';
import { type Transaction } from '@mysten/sui/transactions';
import * as object from './deps/sui/object.js';
const $moduleName = '@local-pkg/pdw::capability';
export const MemoryCap = new MoveStruct({ name: `${$moduleName}::MemoryCap`, fields: {
        id: object.UID,
        /**
         * Random nonce for SEAL key derivation key_id = keccak256(package_id || owner ||
         * nonce)
         */
        nonce: bcs.vector(bcs.u8()),
        /** Application context (e.g., "MEMO", "HEALTH") */
        app_id: bcs.string()
    } });
export const MemoryCapCreated = new MoveStruct({ name: `${$moduleName}::MemoryCapCreated`, fields: {
        cap_id: bcs.Address,
        owner: bcs.Address,
        app_id: bcs.string(),
        nonce: bcs.vector(bcs.u8()),
        created_at: bcs.u64()
    } });
export const MemoryCapTransferred = new MoveStruct({ name: `${$moduleName}::MemoryCapTransferred`, fields: {
        cap_id: bcs.Address,
        from: bcs.Address,
        to: bcs.Address,
        app_id: bcs.string()
    } });
export const MemoryCapBurned = new MoveStruct({ name: `${$moduleName}::MemoryCapBurned`, fields: {
        cap_id: bcs.Address,
        owner: bcs.Address,
        app_id: bcs.string()
    } });
export const SealApproved = new MoveStruct({ name: `${$moduleName}::SealApproved`, fields: {
        cap_id: bcs.Address,
        owner: bcs.Address,
        app_id: bcs.string(),
        key_id: bcs.vector(bcs.u8())
    } });
export interface CreateMemoryCapArguments {
    appId: RawTransactionArgument<string>;
}
export interface CreateMemoryCapOptions {
    package?: string;
    arguments: CreateMemoryCapArguments | [
        appId: RawTransactionArgument<string>
    ];
}
/**
 * Create a new memory capability for an app context
 *
 * This creates a MemoryCap object owned by the caller. The capability can be used
 * to:
 *
 * - Encrypt/decrypt memories for this app context
 * - Share access by transferring the capability
 *
 * @param app_id: Application identifier (e.g., "MEMO", "HEALTH") @param ctx:
 * Transaction context
 */
export function createMemoryCap(options: CreateMemoryCapOptions) {
    const packageAddress = options.package ?? '@local-pkg/pdw';
    const argumentsTypes = [
        '0x0000000000000000000000000000000000000000000000000000000000000001::string::String'
    ] satisfies string[];
    const parameterNames = ["appId"];
    return (tx: Transaction) => tx.moveCall({
        package: packageAddress,
        module: 'capability',
        function: 'create_memory_cap',
        arguments: normalizeMoveArguments(options.arguments, argumentsTypes, parameterNames),
    });
}
export interface SealApproveArguments {
    cap: RawTransactionArgument<string>;
    keyId: RawTransactionArgument<number[]>;
}
export interface SealApproveOptions {
    package?: string;
    arguments: SealApproveArguments | [
        cap: RawTransactionArgument<string>,
        keyId: RawTransactionArgument<number[]>
    ];
}
/**
 * SEAL-compliant approval function
 *
 * This function follows the SEAL PrivateData pattern:
 *
 * - Entry function that aborts on denial (SEAL requirement)
 * - Object holder can pass seal_approve
 * - Any dApp can call with user's connected wallet
 *
 * Flow:
 *
 * 1.  Verify caller owns the capability (via object reference)
 * 2.  Compute expected key_id from capability
 * 3.  Validate provided key_id matches
 * 4.  If valid, function returns (access granted)
 * 5.  If invalid, function aborts (access denied)
 *
 * @param cap: Reference to the MemoryCap object @param key_id: SEAL key identifier
 * to validate @param ctx: Transaction context
 */
export function sealApprove(options: SealApproveOptions) {
    const packageAddress = options.package ?? '@local-pkg/pdw';
    const argumentsTypes = [
        `${packageAddress}::capability::MemoryCap`,
        'vector<u8>'
    ] satisfies string[];
    const parameterNames = ["cap", "keyId"];
    return (tx: Transaction) => tx.moveCall({
        package: packageAddress,
        module: 'capability',
        function: 'seal_approve',
        arguments: normalizeMoveArguments(options.arguments, argumentsTypes, parameterNames),
    });
}
export interface TransferCapArguments {
    cap: RawTransactionArgument<string>;
    recipient: RawTransactionArgument<string>;
}
export interface TransferCapOptions {
    package?: string;
    arguments: TransferCapArguments | [
        cap: RawTransactionArgument<string>,
        recipient: RawTransactionArgument<string>
    ];
}
/**
 * Transfer capability to another address (for delegation/sharing)
 *
 * After transfer:
 *
 * - New owner can call seal_approve
 * - New owner can decrypt memories
 * - Original owner loses access
 *
 * @param cap: The capability to transfer (consumed) @param recipient: Address to
 * receive the capability
 */
export function transferCap(options: TransferCapOptions) {
    const packageAddress = options.package ?? '@local-pkg/pdw';
    const argumentsTypes = [
        `${packageAddress}::capability::MemoryCap`,
        'address'
    ] satisfies string[];
    const parameterNames = ["cap", "recipient"];
    return (tx: Transaction) => tx.moveCall({
        package: packageAddress,
        module: 'capability',
        function: 'transfer_cap',
        arguments: normalizeMoveArguments(options.arguments, argumentsTypes, parameterNames),
    });
}
export interface BurnCapArguments {
    cap: RawTransactionArgument<string>;
}
export interface BurnCapOptions {
    package?: string;
    arguments: BurnCapArguments | [
        cap: RawTransactionArgument<string>
    ];
}
/**
 * Burn (delete) a capability
 *
 * This permanently revokes the capability. After burning:
 *
 * - No one can decrypt memories for this context
 * - Object is permanently deleted
 *
 * @param cap: The capability to burn (consumed)
 */
export function burnCap(options: BurnCapOptions) {
    const packageAddress = options.package ?? '@local-pkg/pdw';
    const argumentsTypes = [
        `${packageAddress}::capability::MemoryCap`
    ] satisfies string[];
    const parameterNames = ["cap"];
    return (tx: Transaction) => tx.moveCall({
        package: packageAddress,
        module: 'capability',
        function: 'burn_cap',
        arguments: normalizeMoveArguments(options.arguments, argumentsTypes, parameterNames),
    });
}
export interface GetAppIdArguments {
    cap: RawTransactionArgument<string>;
}
export interface GetAppIdOptions {
    package?: string;
    arguments: GetAppIdArguments | [
        cap: RawTransactionArgument<string>
    ];
}
/** Get the app_id from a capability */
export function getAppId(options: GetAppIdOptions) {
    const packageAddress = options.package ?? '@local-pkg/pdw';
    const argumentsTypes = [
        `${packageAddress}::capability::MemoryCap`
    ] satisfies string[];
    const parameterNames = ["cap"];
    return (tx: Transaction) => tx.moveCall({
        package: packageAddress,
        module: 'capability',
        function: 'get_app_id',
        arguments: normalizeMoveArguments(options.arguments, argumentsTypes, parameterNames),
    });
}
export interface GetNonceArguments {
    cap: RawTransactionArgument<string>;
}
export interface GetNonceOptions {
    package?: string;
    arguments: GetNonceArguments | [
        cap: RawTransactionArgument<string>
    ];
}
/** Get the nonce from a capability */
export function getNonce(options: GetNonceOptions) {
    const packageAddress = options.package ?? '@local-pkg/pdw';
    const argumentsTypes = [
        `${packageAddress}::capability::MemoryCap`
    ] satisfies string[];
    const parameterNames = ["cap"];
    return (tx: Transaction) => tx.moveCall({
        package: packageAddress,
        module: 'capability',
        function: 'get_nonce',
        arguments: normalizeMoveArguments(options.arguments, argumentsTypes, parameterNames),
    });
}
export interface GetCapIdArguments {
    cap: RawTransactionArgument<string>;
}
export interface GetCapIdOptions {
    package?: string;
    arguments: GetCapIdArguments | [
        cap: RawTransactionArgument<string>
    ];
}
/** Get the object ID of a capability */
export function getCapId(options: GetCapIdOptions) {
    const packageAddress = options.package ?? '@local-pkg/pdw';
    const argumentsTypes = [
        `${packageAddress}::capability::MemoryCap`
    ] satisfies string[];
    const parameterNames = ["cap"];
    return (tx: Transaction) => tx.moveCall({
        package: packageAddress,
        module: 'capability',
        function: 'get_cap_id',
        arguments: normalizeMoveArguments(options.arguments, argumentsTypes, parameterNames),
    });
}
export interface ComputeSealKeyIdArguments {
    cap: RawTransactionArgument<string>;
    owner: RawTransactionArgument<string>;
}
export interface ComputeSealKeyIdOptions {
    package?: string;
    arguments: ComputeSealKeyIdArguments | [
        cap: RawTransactionArgument<string>,
        owner: RawTransactionArgument<string>
    ];
}
/**
 * Compute the SEAL key_id for this capability
 *
 * This can be called off-chain to get the key_id needed for encryption. key_id =
 * keccak256(owner || nonce)
 *
 * @param cap: Reference to the capability @param owner: Owner address (needed for
 * key derivation) @return: The computed key_id bytes
 */
export function computeSealKeyId(options: ComputeSealKeyIdOptions) {
    const packageAddress = options.package ?? '@local-pkg/pdw';
    const argumentsTypes = [
        `${packageAddress}::capability::MemoryCap`,
        'address'
    ] satisfies string[];
    const parameterNames = ["cap", "owner"];
    return (tx: Transaction) => tx.moveCall({
        package: packageAddress,
        module: 'capability',
        function: 'compute_seal_key_id',
        arguments: normalizeMoveArguments(options.arguments, argumentsTypes, parameterNames),
    });
}
