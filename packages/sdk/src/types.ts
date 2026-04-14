/**
 * memwal — Core Types
 *
 * Ed25519 delegate key based SDK that communicates with
 * the MemWal Rust server (TEE).
 */

// ============================================================
// Config
// ============================================================

export interface MemWalConfig {
    /**
     * Ed25519 private key — the delegate key from app.memwal.com.
     * MED-17: Accepts hex string or raw Uint8Array for ergonomic use
     * with hardware wallets / Uint8Array-native environments.
     */
    key: string | Uint8Array;
    /** MemWalAccount object ID on Sui (ensures correct account when delegate key exists in multiple accounts) */
    accountId: string;
    /** Server URL (default: http://localhost:8000) */
    serverUrl?: string;
    /** Default namespace for memory isolation (default: "default") */
    namespace?: string;
    /**
     * MED-17: Optional destroy callback — called to zero-fill key material
     * when the client is done. Best-effort in JS environments.
     * @example client.destroy() // clears sensitive key from memory
     */
    onDestroy?: () => void;
}

// ============================================================
// API Types
// ============================================================

/** Result from remember() */
export interface RememberResult {
    id: string;
    blob_id: string;
    owner: string;
    namespace: string;
}

/** A single recalled memory */
export interface RecallMemory {
    blob_id: string;
    text: string;
    distance: number;
}

/** Result from recall() */
export interface RecallResult {
    results: RecallMemory[];
    total: number;
}

/** Result from embed() */
export interface EmbedResult {
    vector: number[];
}

/** A single extracted fact */
export interface AnalyzedFact {
    text: string;
    id: string;
    blob_id: string;
}

/** Result from analyze() */
export interface AnalyzeResult {
    facts: AnalyzedFact[];
    total: number;
    owner: string;
}

/** Server health response */
export interface HealthResult {
    status: string;
    version: string;
}

// ============================================================
// Manual Flow Types — Lightweight (user provides pre-computed data)
// ============================================================

/** Options for rememberManual() on MemWal class */
export interface RememberManualOptions {
    /** Walrus blob ID (user already uploaded encrypted data) */
    blobId: string;
    /** Embedding vector (user already generated) */
    vector: number[];
    /** Namespace (default: config namespace or "default") */
    namespace?: string;
}

/** Result from rememberManual() */
export interface RememberManualResult {
    id: string;
    blob_id: string;
    owner: string;
    namespace: string;
}

/** Options for recallManual() on MemWal class */
export interface RecallManualOptions {
    /** Pre-computed query embedding vector */
    vector: number[];
    /** Max number of results (default: 10) */
    limit?: number;
    /** Namespace (default: config namespace or "default") */
    namespace?: string;
}

/** A single search hit — raw blobId + distance (no decrypted text) */
export interface RecallManualHit {
    blob_id: string;
    distance: number;
}

/** Result from restore() */
export interface RestoreResult {
    restored: number;
    skipped: number;
    total: number;
    namespace: string;
    owner: string;
}

// ============================================================
// Full Client-Side Manual Flow — MemWalManual class
// ============================================================

/** Config for MemWalManual (full client-side: SEAL + Walrus + embedding) */
export interface MemWalManualConfig {
    /**
     * Ed25519 delegate private key for server auth.
     * MED-17: Accepts hex string or raw Uint8Array.
     */
    key: string | Uint8Array;
    /** Server URL (default: http://localhost:8000) */
    serverUrl?: string;
    /**
     * Sui private key (bech32 suiprivkey1...) for SEAL + Walrus signing.
     * Provide EITHER this OR `walletSigner` — not both.
     */
    suiPrivateKey?: string;
    /**
     * Connected wallet signer (e.g. from dapp-kit).
     * Use this when the user's wallet is already connected in the browser.
     * Provide EITHER this OR `suiPrivateKey` — not both.
     */
    walletSigner?: WalletSigner;
    /**
     * Pre-configured Sui client instance (e.g. from dapp-kit's useSuiClient()).
     * If omitted, the SDK will try to create one internally.
     * Recommended for browser environments where @mysten/sui v2.x removed SuiClient.
     */
    suiClient?: any;
    /** OpenAI/OpenRouter API key for embeddings (required for client-side embedding) */
    embeddingApiKey: string;
    /** OpenAI-compatible API base URL (default: https://api.openai.com/v1) */
    embeddingApiBase?: string;
    /** Embedding model name (default: text-embedding-3-small) */
    embeddingModel?: string;
    /** MemWal contract package ID on Sui */
    packageId: string;
    /** MemWalAccount object ID (for SEAL seal_approve) */
    accountId: string;
    /** Sui network (default: mainnet) */
    suiNetwork?: "testnet" | "mainnet";
    /**
     * Custom SEAL key server object IDs (overrides built-in defaults per network).
     * Array of on-chain object IDs, e.g. ["0x..."].
     * If omitted, uses built-in defaults for the selected suiNetwork.
     */
    sealKeyServers?: string[];
    /** Walrus storage epochs (default: 50) */
    walrusEpochs?: number;
    /** Walrus aggregator URL for direct blob downloads (default: mainnet aggregator) */
    walrusAggregatorUrl?: string;
    /** Walrus publisher URL for direct blob uploads (default: mainnet publisher) */
    walrusPublisherUrl?: string;
    /** Default namespace for memory isolation (default: "default") */
    namespace?: string;
}

/**
 * Wallet signer interface — pass a connected wallet adapter.
 * Compatible with @mysten/dapp-kit's useSignAndExecuteTransaction.
 */
export interface WalletSigner {
    /** Wallet address (Sui address, 0x...) */
    address: string;
    /** Sign and execute a transaction, returns the digest */
    signAndExecuteTransaction: (input: {
        transaction: any;
    }) => Promise<{ digest: string }>;
    /** Sign a personal message (for SEAL SessionKey) */
    signPersonalMessage: (input: {
        message: Uint8Array;
    }) => Promise<{ signature: string }>;
}

/** A recalled memory with decrypted text (from MemWalManual.recallManual) */
export interface RecallManualMemory {
    blob_id: string;
    text: string;
    distance: number;
}

/** Result from recallManual() — full client-side variant with decrypted text */
export interface RecallManualResult {
    results: (RecallManualHit | RecallManualMemory)[];
    total: number;
}

// ============================================================
// Account Management Types
// ============================================================

/** Base options for on-chain account transactions */
interface AccountTxOpts {
    /** MemWal contract package ID on Sui */
    packageId: string;
    /**
     * Sui private key (bech32 suiprivkey1...) for signing.
     * Provide EITHER this OR `walletSigner` — not both.
     */
    suiPrivateKey?: string;
    /**
     * Connected wallet signer (e.g. from dapp-kit).
     * Provide EITHER this OR `suiPrivateKey` — not both.
     */
    walletSigner?: WalletSigner;
    /**
     * Pre-configured Sui client instance.
     * If omitted, the SDK will create one internally.
     */
    suiClient?: any;
    /** Sui network (default: mainnet) */
    suiNetwork?: "testnet" | "mainnet";
}

/** Options for createAccount() */
export interface CreateAccountOpts extends AccountTxOpts {
    /** AccountRegistry shared object ID */
    registryId: string;
}

/** Result from createAccount() */
export interface CreateAccountResult {
    /** Created MemWalAccount object ID */
    accountId: string;
    /** Owner Sui address */
    owner: string;
    /** Transaction digest */
    digest: string;
}

/** Options for addDelegateKey() */
export interface AddDelegateKeyOpts extends AccountTxOpts {
    /** MemWalAccount object ID */
    accountId: string;
    /** Ed25519 public key (32 bytes Uint8Array or hex string) */
    publicKey: Uint8Array | string;
    /** Human-readable label (e.g. "MacBook Pro", "Production Server") */
    label: string;
}

/** Result from addDelegateKey() */
export interface AddDelegateKeyResult {
    /** Transaction digest */
    digest: string;
    /** Public key hex */
    publicKey: string;
    /** Derived Sui address for this delegate key */
    suiAddress: string;
}

/** Options for removeDelegateKey() */
export interface RemoveDelegateKeyOpts extends AccountTxOpts {
    /** MemWalAccount object ID */
    accountId: string;
    /** Ed25519 public key to remove (32 bytes Uint8Array or hex string) */
    publicKey: Uint8Array | string;
}
