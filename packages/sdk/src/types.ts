/**
 * MemWal V2 — Core Types
 *
 * Ed25519 delegate key based SDK that communicates with
 * the MemWal Rust server (TEE).
 */

// ============================================================
// Config
// ============================================================

export interface MemWalConfig {
    /** Ed25519 private key (hex string). This is the delegate key from app.memwal.com */
    key: string;
    /** Server URL (default: http://localhost:8000) */
    serverUrl?: string;
    /** Default namespace for memory isolation (default: "default") */
    namespace?: string;
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
    /** Ed25519 delegate private key (hex) for server auth */
    key: string;
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
