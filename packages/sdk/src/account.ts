/**
 * memwal — Account Management
 *
 * On-chain account operations: create account, add/remove delegate keys.
 * Supports both wallet signing (browser) and private key signing (server-side).
 *
 * @example
 * ```typescript
 * import { createAccount, addDelegateKey, generateDelegateKey } from "@cmdoss/memwal/account"
 *
 * // Generate a delegate keypair
 * const delegate = await generateDelegateKey()
 *
 * // Create account (wallet mode — browser)
 * const account = await createAccount({
 *     packageId: "0x...",
 *     registryId: "0x...",
 *     walletSigner,
 * })
 *
 * // Add the delegate key
 * await addDelegateKey({
 *     packageId: "0x...",
 *     accountId: account.accountId,
 *     publicKey: delegate.publicKey,
 *     label: "My Laptop",
 *     walletSigner,
 * })
 *
 * // Now use the delegate key with the SDK
 * const memwal = MemWal.create({ key: delegate.privateKey, accountId: account.accountId })
 * ```
 */

import type {
    WalletSigner,
    CreateAccountOpts,
    CreateAccountResult,
    AddDelegateKeyOpts,
    AddDelegateKeyResult,
    RemoveDelegateKeyOpts,
} from "./types.js";
import { bytesToHex, hexToBytes } from "./utils.js";

// ============================================================
// SUI Clock object (shared, always 0x6)
// ============================================================
const SUI_CLOCK = "0x0000000000000000000000000000000000000000000000000000000000000006";

// ============================================================
// Internal: Build Sui client + signer
// ============================================================

interface TxContext {
    suiClient: any;
    signer: any;
    address: string;
    Transaction: any;
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

    // Build Sui client
    let suiClient: any;
    if (opts.suiClient) {
        suiClient = opts.suiClient;
    } else {
        const mod = await import("@mysten/sui/client");
        const SuiClient = (mod as any).SuiClient;
        if (typeof SuiClient !== "function") {
            throw new Error(
                "SuiClient not found. For @mysten/sui v2.6.0+, pass suiClient in opts."
            );
        }
        const network = opts.suiNetwork ?? "mainnet";
        const urls: Record<string, string> = {
            testnet: "https://fullnode.testnet.sui.io:443",
            mainnet: "https://fullnode.mainnet.sui.io:443",
        };
        suiClient = new SuiClient({ url: urls[network] ?? urls.mainnet });
    }

    // Build signer
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
    if ("signAndExecuteTransaction" in ctx.signer && typeof ctx.signer.signAndExecuteTransaction === "function" && "address" in ctx.signer) {
        // WalletSigner mode
        const result = await ctx.signer.signAndExecuteTransaction({ transaction: tx });
        // Wait for transaction to be confirmed
        const txResult = await ctx.suiClient.waitForTransaction({
            digest: result.digest,
            options: { showEffects: true, showObjectChanges: true },
        });
        return { digest: result.digest, effects: txResult };
    }

    // Keypair mode
    const result = await ctx.suiClient.signAndExecuteTransaction({
        signer: ctx.signer,
        transaction: tx,
    });
    const txResult = await ctx.suiClient.waitForTransaction({
        digest: result.digest,
        options: { showEffects: true, showObjectChanges: true },
    });
    return { digest: result.digest, effects: txResult };
}

// ============================================================
// createAccount
// ============================================================

/**
 * Create a new MemWalAccount on-chain.
 *
 * Calls `{packageId}::account::create_account(registry, clock)`.
 * Each address can only create ONE account (enforced by the contract).
 *
 * @returns CreateAccountResult with accountId, owner, and tx digest
 */
export async function createAccount(
    opts: CreateAccountOpts,
): Promise<CreateAccountResult> {
    const ctx = await buildTxContext(opts);
    const { Transaction } = ctx;

    const tx = new Transaction();
    tx.moveCall({
        target: `${opts.packageId}::account::create_account`,
        arguments: [
            tx.object(opts.registryId),
            tx.object(SUI_CLOCK),
        ],
    });

    const { digest, effects } = await signAndExecute(ctx, tx);

    // Extract the created MemWalAccount object ID from object changes
    let accountId = "";
    const objectChanges = effects?.objectChanges ?? [];
    for (const change of objectChanges) {
        if (
            change.type === "created" &&
            change.objectType?.includes("::account::MemWalAccount")
        ) {
            accountId = change.objectId;
            break;
        }
    }

    if (!accountId) {
        // Fallback: try to find from effects
        const created = effects?.effects?.created ?? [];
        for (const obj of created) {
            if (obj.owner?.Shared !== undefined) {
                accountId = obj.reference?.objectId ?? "";
                break;
            }
        }
    }

    return {
        accountId,
        owner: ctx.address,
        digest,
    };
}

// ============================================================
// addDelegateKey
// ============================================================

/**
 * Add a delegate key to a MemWalAccount.
 *
 * Calls `{packageId}::account::add_delegate_key(account, public_key, sui_address, label, clock)`.
 * Only the account owner can add delegate keys.
 *
 * @param opts.publicKey - Ed25519 public key (32 bytes Uint8Array or hex string)
 * @param opts.label - Human-readable label (e.g. "MacBook Pro", "Production Server")
 * @returns AddDelegateKeyResult with digest, publicKey hex, and derived suiAddress
 */
export async function addDelegateKey(
    opts: AddDelegateKeyOpts,
): Promise<AddDelegateKeyResult> {
    const ctx = await buildTxContext(opts);
    const { Transaction } = ctx;

    // Normalize public key to Uint8Array
    const pkBytes: Uint8Array =
        typeof opts.publicKey === "string"
            ? hexToBytes(opts.publicKey)
            : opts.publicKey;

    if (pkBytes.length !== 32) {
        throw new Error(`Invalid Ed25519 public key length: ${pkBytes.length} (expected 32)`);
    }

    // Derive Sui address from the public key
    const { blake2b } = await import("@noble/hashes/blake2.js");
    const input = new Uint8Array(33);
    input[0] = 0x00; // Ed25519 scheme flag
    input.set(pkBytes, 1);
    const addressBytes = blake2b(input, { dkLen: 32 });
    const suiAddress = "0x" + bytesToHex(addressBytes);

    const tx = new Transaction();
    tx.moveCall({
        target: `${opts.packageId}::account::add_delegate_key`,
        arguments: [
            tx.object(opts.accountId),
            tx.pure("vector<u8>", Array.from(pkBytes)),
            tx.pure("address", suiAddress),
            tx.pure("string", opts.label),
            tx.object(SUI_CLOCK),
        ],
    });

    const { digest } = await signAndExecute(ctx, tx);

    return {
        digest,
        publicKey: bytesToHex(pkBytes),
        suiAddress,
    };
}

// ============================================================
// removeDelegateKey
// ============================================================

/**
 * Remove a delegate key from a MemWalAccount.
 *
 * Calls `{packageId}::account::remove_delegate_key(account, public_key)`.
 * Only the account owner can remove delegate keys.
 *
 * @param opts.publicKey - Ed25519 public key to remove (32 bytes Uint8Array or hex string)
 */
export async function removeDelegateKey(
    opts: RemoveDelegateKeyOpts,
): Promise<{ digest: string }> {
    const ctx = await buildTxContext(opts);
    const { Transaction } = ctx;

    const pkBytes: Uint8Array =
        typeof opts.publicKey === "string"
            ? hexToBytes(opts.publicKey)
            : opts.publicKey;

    if (pkBytes.length !== 32) {
        throw new Error(`Invalid Ed25519 public key length: ${pkBytes.length} (expected 32)`);
    }

    const tx = new Transaction();
    tx.moveCall({
        target: `${opts.packageId}::account::remove_delegate_key`,
        arguments: [
            tx.object(opts.accountId),
            tx.pure("vector<u8>", Array.from(pkBytes)),
        ],
    });

    const { digest } = await signAndExecute(ctx, tx);
    return { digest };
}

// ============================================================
// generateDelegateKey
// ============================================================

/**
 * Generate a new Ed25519 delegate keypair.
 *
 * Returns the private key (hex), public key (bytes), and derived Sui address.
 * The private key can be used with `MemWal.create({ key })`.
 *
 * @example
 * ```typescript
 * const delegate = await generateDelegateKey()
 * console.log(delegate.privateKey)  // hex string — store securely!
 * console.log(delegate.suiAddress)  // 0x... — use in addDelegateKey
 *
 * // Use with SDK
 * const memwal = MemWal.create({ key: delegate.privateKey, accountId: "0x..." })
 * ```
 */
export async function generateDelegateKey(): Promise<{
    privateKey: string;
    publicKey: Uint8Array;
    suiAddress: string;
}> {
    const ed = await import("@noble/ed25519");
    const { blake2b } = await import("@noble/hashes/blake2.js");

    // Generate random 32-byte private key
    const privateKeyBytes = new Uint8Array(32);
    globalThis.crypto.getRandomValues(privateKeyBytes);
    const publicKey = await ed.getPublicKeyAsync(privateKeyBytes);

    // Derive Sui address
    const input = new Uint8Array(33);
    input[0] = 0x00; // Ed25519 scheme flag
    input.set(publicKey, 1);
    const addressBytes = blake2b(input, { dkLen: 32 });
    const suiAddress = "0x" + bytesToHex(addressBytes);

    return {
        privateKey: bytesToHex(privateKeyBytes),
        publicKey,
        suiAddress,
    };
}
