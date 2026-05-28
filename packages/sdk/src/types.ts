/**
 * Walrus Memory — Core Types
 *
 * Ed25519 delegate key based SDK that communicates with
 * the Walrus Memory Rust server (TEE).
 */

// ============================================================
// Config
// ============================================================

export interface MemWalConfig {
    /** Ed25519 private key (hex string or Uint8Array). This is the Walrus Memory delegate key. */
    key: string | Uint8Array;
    /** Walrus Memory account object ID on Sui (ensures correct account when delegate key exists in multiple accounts) */
    accountId: string;
    /** Server URL (default: https://relayer.memwal.ai) */
    serverUrl?: string;
    /** Default namespace for memory isolation (default: "default") */
    namespace?: string;
}

// ============================================================
// API Types
// ============================================================

/** Result from remember() / rememberAsync() */
export interface RememberAcceptedResult {
    job_id: string;
    status: string;
}

/** Status returned for an async remember job */
export interface RememberJobStatus {
    job_id: string;
    status: "pending" | "running" | "uploaded" | "done" | "failed" | "not_found";
    owner?: string;
    namespace?: string;
    blob_id?: string;
    error?: string;
}

/** Result from rememberAndWait() / waitForRememberJob() */
export interface RememberResult {
    /** Stable server job_id used as the vector row id. */
    id: string;
    /** Async job id returned by remember(). */
    job_id?: string;
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

/** Options for recall(). */
export interface RecallOptions {
    /** Max number of nearest memories to request from the relayer (default: 10). */
    limit?: number;
    /** Alias for limit, useful when describing top-K search behaviour. */
    topK?: number;
    /** Namespace override (default: config namespace or "default"). */
    namespace?: string;
    /** Drop memories whose distance is greater than or equal to this value. */
    maxDistance?: number;
}

/** Recommended object-style recall input — preferred over positional args. */
export interface RecallParams extends RecallOptions {
    /** Search query text. */
    query: string;
}

/** Optional composite-scoring weights for recall ranking. */
export interface ScoringWeights {
    /** Weight applied to semantic similarity (`1.0 - distance`). Default: 1. */
    semantic?: number;
    /** Weight applied to recency decay. Default: 0. */
    recency?: number;
    /** Half-life for the recency term, in days. Default: 30. */
    recencyHalfLifeDays?: number;
    /** Weight applied to memory importance. Default: 0. */
    importance?: number;
}

/** Result from rememberBulk() / rememberBulkAsync() */
export interface RememberBulkAcceptedResult {
    job_ids: string[];
    total: number;
    status: string;
}

/** Per-item status returned from the bulk status endpoint */
export interface RememberBulkStatusItem {
    job_id: string;
    status: "pending" | "running" | "uploaded" | "done" | "failed" | "not_found";
    blob_id?: string;
    error?: string;
}

/** Result from getRememberBulkStatus() */
export interface RememberBulkStatusResult {
    results: RememberBulkStatusItem[];
}

/** One item in a bulk remember request */
export interface RememberBulkItem {
    /** The text to remember */
    text: string;
    /** Optional per-item namespace override (falls back to client default) */
    namespace?: string;
}

/** Options for remember bulk polling behaviour */
export interface RememberBulkOptions {
    /** How often to poll each job_id (default: 1500ms) */
    pollIntervalMs?: number;
    /** Max total wait time before throwing (default: 120_000ms) */
    timeoutMs?: number;
}

/** Per-item result returned from rememberBulkAndWait() / waitForRememberJobs() */
export interface RememberBulkItemResult {
    /** job_id returned by the server */
    id: string;
    /** Walrus blob_id once the job completes ("" if failed) */
    blob_id: string;
    /** Final status reported by the server: "done" | "failed" | "timeout" */
    status: "done" | "failed" | "timeout";
    /** Namespace the memory was stored under */
    namespace: string;
    /** Error message if status !== "done" */
    error?: string;
}

/** Result from rememberBulkAndWait() / waitForRememberJobs() */
export interface RememberBulkResult {
    /** One result per input item, in the same order */
    results: RememberBulkItemResult[];
    /** Total items submitted */
    total: number;
    /** Count of items that reached status=done */
    succeeded: number;
    /** Count of items that failed or timed out */
    failed: number;
}

/** Result from embed() */
export interface EmbedResult {
    vector: number[];
}

/** A fact extracted by analyze() and accepted for background storage. */
export interface AnalyzedFact {
    text: string;
    /** Stable job id/vector row id for this extracted fact. */
    id: string;
    /** Polling id for this extracted fact. */
    job_id?: string;
    /** Walrus blob_id once the background job completes. */
    blob_id?: string;
}

/** Result from analyze() */
export interface AnalyzeResult {
    job_ids: string[];
    facts: AnalyzedFact[];
    fact_count: number;
    status: string;
    owner: string;
}

/** Result from analyzeAndWait() */
export interface AnalyzeWaitResult extends RememberBulkResult {
    facts: AnalyzedFact[];
    owner: string;
}

/** Server health response */
export interface HealthResult extends Partial<RelayerVersionMetadata> {
    status: string;
    /** Backward-compatible relayer package version alias. */
    version: string;
    /** "production" or "benchmark" when returned by modern relayers. */
    mode?: string;
    prompt_versions?: {
        extract: string;
        ask: string;
    };
}

/** Minimum SDK versions accepted by a relayer API contract. */
export interface MinSupportedSdk {
    typescript: string;
    python: string;
    mcp: string;
}

/** Public deprecation metadata returned by GET /version and GET /health. */
export interface RelayerDeprecationNotice {
    surface: string;
    deprecatedSince: string;
    removalApiVersion: string;
    guidance: string;
}

/** Public build metadata returned by GET /version and GET /health. */
export interface RelayerBuildMetadata {
    commit?: string;
    buildTimestamp?: string;
}

/** Runtime compatibility metadata returned by GET /version. */
export interface RelayerVersionMetadata {
    relayerVersion: string;
    apiVersion: string;
    minSupportedSdk: MinSupportedSdk;
    featureFlags: Record<string, boolean>;
    deprecations: RelayerDeprecationNotice[];
    build: RelayerBuildMetadata;
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
    /** Optional composite-scoring weights applied before returning hits. */
    scoringWeights?: ScoringWeights;
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

/** Full @mysten/seal server config. Committee servers require aggregatorUrl. */
export interface SealServerConfig {
    /** On-chain SEAL key server or committee object ID */
    objectId: string;
    /** Server weight for threshold encryption. Defaults to 1. */
    weight?: number;
    /** Committee aggregator URL. Required for committee mode servers. */
    aggregatorUrl?: string;
    /** Optional API key header name for permissioned key servers */
    apiKeyName?: string;
    /** Optional API key value for permissioned key servers */
    apiKey?: string;
}

/** Config for MemWalManual (full client-side: SEAL + Walrus + embedding) */
export interface MemWalManualConfig {
    /** Ed25519 delegate private key (hex or Uint8Array) for server auth */
    key: string | Uint8Array;
    /** Server URL (default: https://relayer.memwal.ai) */
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
    /** Walrus Memory contract package ID on Sui */
    packageId: string;
    /** Walrus Memory account object ID (for SEAL seal_approve) */
    accountId: string;
    /** Sui network (default: mainnet) */
    suiNetwork?: "testnet" | "mainnet";
    /**
     * Full SEAL server configs, including committee aggregators.
     * Takes priority over legacy sealKeyServers when provided.
     */
    sealServerConfigs?: SealServerConfig[];
    /**
     * Legacy custom SEAL independent key server object IDs.
     * Array of on-chain object IDs, e.g. ["0x..."].
     * If omitted, uses sealServerConfigs or built-in defaults for the selected suiNetwork.
     */
    sealKeyServers?: string[];
    /**
     * SEAL threshold — number of key server shares required for encrypt/decrypt.
     * Must be ≤ the total configured SEAL server weight.
     * Default: 2, capped to the total configured SEAL server weight.
     */
    sealThreshold?: number;
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

/** Options for MemWalManual.recallManual(). */
export interface MemWalManualRecallOptions {
    /** Max number of results (default: 10). */
    limit?: number;
    /** Namespace (default: config namespace or "default"). */
    namespace?: string;
    /** Optional composite-scoring weights applied before returning hits. */
    scoringWeights?: ScoringWeights;
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
    /** Walrus Memory contract package ID on Sui */
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
    /** Created Walrus Memory account object ID */
    accountId: string;
    /** Owner Sui address */
    owner: string;
    /** Transaction digest */
    digest: string;
}

/** Options for addDelegateKey() */
export interface AddDelegateKeyOpts extends AccountTxOpts {
    /** Walrus Memory account object ID */
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
    /** Walrus Memory account object ID */
    accountId: string;
    /** Ed25519 public key to remove (32 bytes Uint8Array or hex string) */
    publicKey: Uint8Array | string;
}
