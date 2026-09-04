/**
 * Walrus Memory — V2 namespace PTBs and Seal wrap of the namespace DEK.
 *
 * createNamespace and initializeKey are always separate transactions.
 * Never batch them with createAccount.
 */

import type {
    WalletSigner,
    WrapNamespaceDekOpts,
    WrapNamespaceDekResult,
    GenerateAndWrapNamespaceDekOpts,
    GenerateAndWrapNamespaceDekResult,
    CreateNamespaceOpts,
    CreateNamespaceResult,
    InitializeKeyOpts,
    GrantAccessOpts,
    RevokeAccessOpts,
    RotateKeyOpts,
    CancelUninitializedNamespaceOpts,
} from "./types.js";
import { bytesToHex, namespaceSealKeyId } from "./utils.js";

export { namespaceSealKeyId } from "./utils.js";

const SUI_CLOCK = "0x0000000000000000000000000000000000000000000000000000000000000006";
const MAX_LABEL_BYTES = 64;
const MAX_WRAPPED_DEK_LENGTH = 16384;
const DEK_LENGTH = 32;
const PERMISSION_READ = 1;
const PERMISSION_WRITE = 2;
const PERMISSION_SHARE = 4;

interface TxContext {
    suiClient: any;
    signer: any;
    address: string;
    Transaction: any;
}

function transactionData(result: any): any {
    return result?.Transaction ?? result?.FailedTransaction ?? result;
}

async function buildTxContext(opts: {
    suiPrivateKey?: string;
    walletSigner?: WalletSigner;
    suiClient?: any;
    suiNetwork?: "testnet" | "mainnet";
}): Promise<TxContext> {
    if (!opts.suiPrivateKey && !opts.walletSigner) {
        throw new Error("Provide either suiPrivateKey or walletSigner");
    }
    if (opts.suiPrivateKey && opts.walletSigner) {
        throw new Error("Provide suiPrivateKey OR walletSigner, not both");
    }

    const { Transaction } = await import("@mysten/sui/transactions");

    let suiClient: any;
    if (opts.suiClient) {
        suiClient = opts.suiClient;
    } else {
        const mod = await import("@mysten/sui/client");
        const SuiClient = (mod as any).SuiClient;
        if (typeof SuiClient !== "function") {
            throw new Error(
                "SuiClient not found. For @mysten/sui v2.6.0+, pass suiClient in opts.",
            );
        }
        const network = opts.suiNetwork ?? "mainnet";
        const urls: Record<string, string> = {
            testnet: "https://fullnode.testnet.sui.io:443",
            mainnet: "https://fullnode.mainnet.sui.io:443",
        };
        suiClient = new SuiClient({ url: urls[network] ?? urls.mainnet });
    }

    if (opts.walletSigner) {
        return {
            suiClient,
            signer: opts.walletSigner,
            address: opts.walletSigner.address,
            Transaction,
        };
    }

    const { decodeSuiPrivateKey } = await import("@mysten/sui/cryptography");
    const { Ed25519Keypair } = await import("@mysten/sui/keypairs/ed25519");
    const { secretKey } = decodeSuiPrivateKey(opts.suiPrivateKey!);
    const keypair = Ed25519Keypair.fromSecretKey(secretKey);

    return {
        suiClient,
        signer: keypair,
        address: keypair.getPublicKey().toSuiAddress(),
        Transaction,
    };
}

async function signAndExecute(
    ctx: TxContext,
    tx: any,
): Promise<{ digest: string; effects: any }> {
    let executionResult: any;

    if ("signAndExecuteTransaction" in ctx.signer && typeof ctx.signer.signAndExecuteTransaction === "function" && "address" in ctx.signer) {
        executionResult = await ctx.signer.signAndExecuteTransaction({ transaction: tx });
    } else {
        executionResult = await ctx.suiClient.signAndExecuteTransaction({
            signer: ctx.signer,
            transaction: tx,
        });
    }

    const digest = transactionData(executionResult)?.digest;
    if (typeof digest !== "string" || !digest) {
        throw new Error("Transaction submission returned no digest");
    }

    const txResult = await ctx.suiClient.waitForTransaction({
        digest,
        include: { effects: true, objectTypes: true },
        options: { showEffects: true, showObjectChanges: true },
    });
    const txData = transactionData(txResult);
    const status = txData?.status ?? txData?.effects?.status;
    const success = status?.success === true ||
        (status?.success === undefined && status?.status === "success");
    if (!success) {
        const detail = typeof status?.error === "string"
            ? status.error
            : status?.error
              ? JSON.stringify(status.error)
              : "missing execution status";
        throw new Error(`Transaction ${digest} failed: ${detail}`);
    }

    return { digest, effects: txResult };
}

function extractCreatedObjectId(effects: any, typeIncludes: string): string {
    let objectId = "";
    const txData = transactionData(effects);
    const objectChanges = txData?.objectChanges ?? [];
    for (const change of objectChanges) {
        if (
            change.type === "created" &&
            change.objectType?.includes(typeIncludes)
        ) {
            objectId = change.objectId;
            break;
        }
    }

    if (!objectId) {
        const objectTypes = txData?.objectTypes ?? {};
        const changedObjects = txData?.effects?.changedObjects ?? [];
        for (const change of changedObjects) {
            if (
                change.idOperation === "Created" &&
                objectTypes[change.objectId]?.includes(typeIncludes)
            ) {
                objectId = change.objectId;
                break;
            }
        }
    }

    if (!objectId) {
        const created = txData?.effects?.created ?? [];
        for (const obj of created) {
            if (obj.owner?.Shared !== undefined) {
                objectId = obj.reference?.objectId ?? "";
                break;
            }
        }
    }

    return objectId;
}

async function executeMoveCall(
    opts: {
        packageId: string;
        suiPrivateKey?: string;
        walletSigner?: WalletSigner;
        suiClient?: any;
        suiNetwork?: "testnet" | "mainnet";
    },
    functionName: string,
    makeArgs: (tx: any) => any[],
): Promise<{ digest: string; effects: any }> {
    const ctx = await buildTxContext(opts);
    const { Transaction } = ctx;
    const tx = new Transaction();
    tx.moveCall({
        target: `${opts.packageId}::namespace::${functionName}`,
        arguments: makeArgs(tx),
    });
    return signAndExecute(ctx, tx);
}

function namespaceCoreArgs(
    tx: any,
    opts: {
        namespaceRegistryId: string;
        accountRegistryId: string;
        accountId: string;
    },
): any[] {
    return [
        tx.object(opts.namespaceRegistryId),
        tx.object(opts.accountRegistryId),
        tx.object(opts.accountId),
    ];
}

function assertLabel(label: string): void {
    if (typeof label !== "string") {
        throw new TypeError("createNamespace: label must be a string");
    }
    const byteLen = new TextEncoder().encode(label).length;
    if (byteLen < 1 || byteLen > MAX_LABEL_BYTES) {
        throw new Error(
            `createNamespace: label must be 1..${MAX_LABEL_BYTES} bytes, got ${byteLen}`,
        );
    }
}

function assertWrappedDek(wrappedDek: Uint8Array, label: string): void {
    if (!(wrappedDek instanceof Uint8Array)) {
        throw new TypeError(`${label} must be Uint8Array`);
    }
    if (wrappedDek.length < 1 || wrappedDek.length > MAX_WRAPPED_DEK_LENGTH) {
        throw new Error(
            `${label} length ${wrappedDek.length} is outside 1..${MAX_WRAPPED_DEK_LENGTH}`,
        );
    }
}

function assertDek(dek: Uint8Array): void {
    if (!(dek instanceof Uint8Array) || dek.length !== DEK_LENGTH) {
        throw new Error(
            `wrapNamespaceDek: dek must be ${DEK_LENGTH} bytes, got ${dek?.length}`,
        );
    }
}

/**
 * Encode grant bits. WRITE implies READ. SHARE without READ is rejected.
 * All-false is rejected (use revokeAccess to clear).
 */
export function permissionBits(
    canRead: boolean,
    canWrite: boolean,
    canShare: boolean,
): number {
    if (!canRead && !canWrite && !canShare) {
        throw new Error(
            "grantAccess: at least one of canRead, canWrite, canShare must be true",
        );
    }
    const read = canRead || canWrite;
    if (canShare && !read) {
        throw new Error("grantAccess: SHARE requires READ");
    }
    return (read ? PERMISSION_READ : 0) |
        (canWrite ? PERMISSION_WRITE : 0) |
        (canShare ? PERMISSION_SHARE : 0);
}

async function resolveSealClient(opts: WrapNamespaceDekOpts | GenerateAndWrapNamespaceDekOpts): Promise<any> {
    if (opts.sealClient) {
        return opts.sealClient;
    }
    const configs = opts.sealServerConfigs;
    if (!configs || configs.length === 0) {
        throw new Error("wrapNamespaceDek: provide sealClient or sealServerConfigs");
    }

    const { SealClient } = await import("@mysten/seal");
    let suiClient = opts.suiClient;
    if (!suiClient) {
        const mod = await import("@mysten/sui/client");
        const SuiClient = (mod as any).SuiClient;
        if (typeof SuiClient !== "function") {
            throw new Error(
                "SuiClient not found. For @mysten/sui v2.6.0+, pass suiClient in opts.",
            );
        }
        const network = opts.suiNetwork ?? "mainnet";
        const urls: Record<string, string> = {
            testnet: "https://fullnode.testnet.sui.io:443",
            mainnet: "https://fullnode.mainnet.sui.io:443",
        };
        suiClient = new SuiClient({ url: urls[network] ?? urls.mainnet });
    }

    return new SealClient({
        suiClient,
        serverConfigs: configs.map((config, index) => {
            const objectId = config.objectId?.trim();
            if (!objectId) {
                throw new Error(
                    `wrapNamespaceDek: sealServerConfigs[${index}].objectId is required`,
                );
            }
            const weight = config.weight ?? 1;
            if (!Number.isInteger(weight) || weight < 1) {
                throw new Error(
                    `wrapNamespaceDek: sealServerConfigs[${index}].weight must be a positive integer`,
                );
            }
            return {
                objectId,
                weight,
                ...(config.aggregatorUrl ? { aggregatorUrl: config.aggregatorUrl } : {}),
                ...(config.apiKeyName && config.apiKey
                    ? { apiKeyName: config.apiKeyName, apiKey: config.apiKey }
                    : {}),
            };
        }),
        verifyKeyServers: true,
    });
}

/**
 * Seal-encrypt a 32-byte namespace DEK. Does not return the raw DEK.
 *
 * `id` is hex of the 40-byte suffix; @mysten/seal may prepend BCS(packageId).
 */
export async function wrapNamespaceDek(
    opts: WrapNamespaceDekOpts,
): Promise<WrapNamespaceDekResult> {
    assertDek(opts.dek);
    if (!Number.isInteger(opts.threshold) || opts.threshold < 1) {
        throw new Error(`wrapNamespaceDek: threshold must be a positive integer`);
    }

    const sealClient = await resolveSealClient(opts);
    const id = bytesToHex(namespaceSealKeyId(opts.namespaceId, opts.keyVersion));
    const result = await sealClient.encrypt({
        threshold: opts.threshold,
        packageId: opts.packageId,
        id,
        data: opts.dek,
    });
    const wrappedDek = result?.encryptedObject instanceof Uint8Array
        ? result.encryptedObject
        : new Uint8Array(result?.encryptedObject ?? []);
    assertWrappedDek(wrappedDek, "wrapNamespaceDek: wrappedDek");
    return { wrappedDek };
}

/**
 * Generate a 32-byte DEK, Seal-wrap it, and return both. Caller must keep
 * `dek` in memory only (dashboard wraps once, then discards).
 */
export async function generateAndWrapNamespaceDek(
    opts: GenerateAndWrapNamespaceDekOpts,
): Promise<GenerateAndWrapNamespaceDekResult> {
    const dek = new Uint8Array(DEK_LENGTH);
    globalThis.crypto.getRandomValues(dek);
    const { wrappedDek } = await wrapNamespaceDek({ ...opts, dek });
    return { dek, wrappedDek };
}

/**
 * Phase 1: reserve a label and share an inactive MemoryNamespace.
 *
 * `{packageId}::namespace::create_namespace(namespaceRegistry, accountRegistry, account, label, clock)`
 */
export async function createNamespace(
    opts: CreateNamespaceOpts,
): Promise<CreateNamespaceResult> {
    assertLabel(opts.label);
    const { digest, effects } = await executeMoveCall(
        opts,
        "create_namespace",
        (tx) => [
            ...namespaceCoreArgs(tx, opts),
            tx.pure("string", opts.label),
            tx.object(SUI_CLOCK),
        ],
    );

    const namespaceId = extractCreatedObjectId(effects, "::namespace::MemoryNamespace");
    if (!namespaceId) {
        throw new Error(
            "createNamespace: created MemoryNamespace object id not found in transaction effects",
        );
    }

    return { namespaceId, digest };
}

/**
 * Phase 2: install key version 0 and activate the namespace.
 * Must be a separate transaction from createNamespace.
 *
 * `{packageId}::namespace::initialize_key(..., wrapped_dek, clock)`
 */
export async function initializeKey(
    opts: InitializeKeyOpts,
): Promise<{ digest: string }> {
    assertWrappedDek(opts.wrappedDek, "initializeKey: wrappedDek");
    const { digest } = await executeMoveCall(
        opts,
        "initialize_key",
        (tx) => [
            ...namespaceCoreArgs(tx, opts),
            tx.object(opts.namespaceId),
            tx.pure("vector<u8>", Array.from(opts.wrappedDek)),
            tx.object(SUI_CLOCK),
        ],
    );
    return { digest };
}

/**
 * Grant or replace ACL bits. WRITE implies READ; SHARE without READ is rejected.
 */
export async function grantAccess(
    opts: GrantAccessOpts,
): Promise<{ digest: string }> {
    const bits = permissionBits(opts.canRead, opts.canWrite, opts.canShare);
    const { digest } = await executeMoveCall(
        opts,
        "grant_access",
        (tx) => [
            ...namespaceCoreArgs(tx, opts),
            tx.object(opts.namespaceId),
            tx.pure("address", opts.principal),
            tx.pure("bool", (bits & PERMISSION_READ) !== 0),
            tx.pure("bool", (bits & PERMISSION_WRITE) !== 0),
            tx.pure("bool", (bits & PERMISSION_SHARE) !== 0),
            tx.object(SUI_CLOCK),
        ],
    );
    return { digest };
}

/**
 * Remove all permissions for `principal` and rotate the DEK.
 */
export async function revokeAccess(
    opts: RevokeAccessOpts,
): Promise<{ digest: string }> {
    assertWrappedDek(opts.newWrappedDek, "revokeAccess: newWrappedDek");
    const { digest } = await executeMoveCall(
        opts,
        "revoke_access",
        (tx) => [
            ...namespaceCoreArgs(tx, opts),
            tx.object(opts.namespaceId),
            tx.pure("address", opts.principal),
            tx.pure("vector<u8>", Array.from(opts.newWrappedDek)),
            tx.object(SUI_CLOCK),
        ],
    );
    return { digest };
}

/**
 * Owner-controlled DEK rotation.
 */
export async function rotateKey(
    opts: RotateKeyOpts,
): Promise<{ digest: string }> {
    assertWrappedDek(opts.newWrappedDek, "rotateKey: newWrappedDek");
    const { digest } = await executeMoveCall(
        opts,
        "rotate_key",
        (tx) => [
            ...namespaceCoreArgs(tx, opts),
            tx.object(opts.namespaceId),
            tx.pure("vector<u8>", Array.from(opts.newWrappedDek)),
            tx.object(SUI_CLOCK),
        ],
    );
    return { digest };
}

/**
 * Release an unused two-phase reservation (`public fun`, still PTB-callable).
 */
export async function cancelUninitializedNamespace(
    opts: CancelUninitializedNamespaceOpts,
): Promise<{ digest: string }> {
    const { digest } = await executeMoveCall(
        opts,
        "cancel_uninitialized_namespace",
        (tx) => [
            ...namespaceCoreArgs(tx, opts),
            tx.object(opts.namespaceId),
            tx.object(SUI_CLOCK),
        ],
    );
    return { digest };
}
