/**
 * memwal — SDK Client
 *
 * Ed25519 delegate key based client that communicates with the MemWal
 * Rust server (TEE). All data processing (encryption, embedding, Walrus)
 * happens server-side — the SDK just signs requests and sends text.
 *
 * The SDK only needs a single Ed25519 private key (the "delegate key").
 * The server derives the owner address from the public key via onchain
 * lookup in MemWalAccount.delegate_keys.
 *
 * @example
 * ```typescript
 * import { MemWal } from "@mysten-incubation/memwal"
 *
 * const memwal = MemWal.create({
 *     key: process.env.MEMWAL_PRIVATE_KEY,  // Ed25519 private key (hex)
 *     accountId: process.env.MEMWAL_ACCOUNT_ID, // MemWalAccount object ID
 * })
 *
 * // Remember — server: verify → embed → encrypt → Walrus → store
 * await memwal.remember("I'm allergic to peanuts")
 *
 * // Recall — server: verify → embed query → search → download → decrypt
 * const result = await memwal.recall("food allergies")
 * console.log(result.results[0].text) // "I'm allergic to peanuts"
 * ```
 */

import type {
    MemWalConfig,
    RememberResult,
    RecallResult,
    RecallMemory,
    EmbedResult,
    AnalyzeResult,
    HealthResult,
    RememberManualOptions,
    RememberManualResult,
    RecallManualOptions,
    RecallManualResult,
    RestoreResult,
    RememberOptions,
    RecallOptions,
    MemoryStats,
    ForgetResult,
} from "./types.js";
import { sha256hex, hexToBytes, bytesToHex } from "./utils.js";

// ============================================================
// Ed25519 Signing (lazy-loaded)
// ============================================================

let _ed: typeof import("@noble/ed25519") | null = null;
async function getEd() {
    if (!_ed) {
        _ed = await import("@noble/ed25519");
    }
    return _ed;
}

// ============================================================
// MemWal Client
// ============================================================

export class MemWal {
    private privateKey: Uint8Array;
    private publicKey: Uint8Array | null = null;
    private serverUrl: string;
    private namespace: string;
    private accountId: string;

    private constructor(config: MemWalConfig) {
        this.privateKey = hexToBytes(config.key);
        this.accountId = config.accountId;
        this.serverUrl = (config.serverUrl ?? "http://localhost:8000").replace(/\/$/, "");
        this.namespace = config.namespace ?? "default";
    }

    /**
     * Create a new MemWal client instance.
     *
     * @param config.key - Ed25519 private key (hex string) — the delegate key
     * @param config.serverUrl - Server URL (default: http://localhost:8000)
     */
    static create(config: MemWalConfig): MemWal {
        return new MemWal(config);
    }

    // ============================================================
    // Core API
    // ============================================================

    /**
     * Remember something — server handles: verify → embed → encrypt → Walrus upload → store
     *
     * @param text - The text to remember
     * @param namespaceOrOptions - Namespace string or RememberOptions object
     * @returns RememberResult with id, blob_id, owner, memory_type, importance
     *
     * @example
     * ```typescript
     * // Simple usage (backward compatible)
     * await memwal.remember("I'm allergic to peanuts")
     *
     * // Enriched usage with options
     * await memwal.remember("User prefers dark mode", {
     *   memoryType: 'preference',
     *   importance: 0.8,
     *   tags: ['ui', 'settings'],
     * })
     * ```
     */
    async remember(text: string, namespaceOrOptions?: string | (RememberOptions & { namespace?: string })): Promise<RememberResult> {
        const opts = typeof namespaceOrOptions === 'string'
            ? { namespace: namespaceOrOptions }
            : namespaceOrOptions ?? {};

        return this.signedRequest<RememberResult>("POST", "/api/remember", {
            text,
            namespace: opts.namespace ?? this.namespace,
            ...(opts.memoryType && { memory_type: opts.memoryType }),
            ...(opts.importance !== undefined && { importance: opts.importance }),
            ...(opts.metadata && { metadata: opts.metadata }),
            ...(opts.tags && { tags: opts.tags }),
        });
    }

    /**
     * Recall memories similar to a query — server handles:
     * verify → embed query → search → Walrus download → decrypt → return plaintext
     *
     * @param query - Search query
     * @param limitOrOptions - Max results (number) or RecallOptions object
     * @returns RecallResult with decrypted text results, scored and ranked
     *
     * @example
     * ```typescript
     * // Simple usage (backward compatible)
     * const result = await memwal.recall("food allergies")
     *
     * // Enriched usage with filtering and scoring
     * const result = await memwal.recall("food allergies", {
     *   limit: 5,
     *   memoryTypes: ['fact', 'biographical'],
     *   minImportance: 0.3,
     *   scoringWeights: { semantic: 0.6, importance: 0.3, recency: 0.1 },
     * })
     * ```
     */
    async recall(query: string, limitOrOptions?: number | RecallOptions, namespace?: string): Promise<RecallResult> {
        const opts: RecallOptions = typeof limitOrOptions === 'number'
            ? { limit: limitOrOptions, namespace }
            : limitOrOptions ?? {};

        return this.signedRequest<RecallResult>("POST", "/api/recall", {
            query,
            limit: opts.limit ?? 10,
            namespace: opts.namespace ?? namespace ?? this.namespace,
            ...(opts.memoryTypes && { memory_types: opts.memoryTypes }),
            ...(opts.minImportance !== undefined && { min_importance: opts.minImportance }),
            ...(opts.includeExpired !== undefined && { include_expired: opts.includeExpired }),
            ...(opts.scoringWeights && { scoring_weights: opts.scoringWeights }),
        });
    }

    // ============================================================
    // Manual API (user handles SEAL + embedding + Walrus)
    // ============================================================

    /**
     * Remember (manual mode) — user handles SEAL encrypt, embedding,
     * and Walrus upload externally. Server only stores the vector ↔ blobId mapping.
     *
     * @param opts.blobId - Walrus blob ID (legacy mode, user already uploaded encrypted data)
     * @param opts.encryptedData - Base64 encrypted payload (new mode, server uploads to Walrus)
     * @param opts.vector - Embedding vector (user already generated, e.g. 1536-dim)
     * @returns RememberManualResult with id, blob_id, owner
     *
     * @example
     * ```typescript
     * // 1. User encrypts + uploads + embeds on their own
     * const blobId = await myWalrusUpload(sealEncryptedData)
     * const vector = await myEmbeddingModel.embed(text)
     *
     * // 2. Register vector mapping with server
     * const result = await memwal.rememberManual({ blobId, vector })
     * ```
     */
    async rememberManual(opts: RememberManualOptions): Promise<RememberManualResult> {
        if (!opts.blobId && !opts.encryptedData) {
            throw new Error("rememberManual requires either blobId or encryptedData");
        }
        return this.signedRequest<RememberManualResult>("POST", "/api/remember/manual", {
            vector: opts.vector,
            namespace: opts.namespace ?? this.namespace,
            ...(opts.blobId && { blob_id: opts.blobId }),
            ...(opts.encryptedData && { encrypted_data: opts.encryptedData }),
        });
    }

    /**
     * Recall (manual mode) — user provides a pre-computed query vector.
     * Server returns matching blobIds + distances.
     * User then downloads from Walrus + SEAL decrypts on their own.
     *
     * @param opts.vector - Pre-computed query embedding vector
     * @param opts.limit - Max results (default: 10)
     * @returns RecallManualResult with blob_id + distance pairs (no decrypted text)
     *
     * @example
     * ```typescript
     * // 1. User generates query embedding
     * const queryVector = await myEmbeddingModel.embed("food allergies")
     *
     * // 2. Search for similar vectors
     * const hits = await memwal.recallManual({ vector: queryVector })
     *
     * // 3. User downloads + decrypts each result
     * for (const hit of hits.results) {
     *     const encrypted = await walrus.download(hit.blob_id)
     *     const plaintext = await seal.decrypt(encrypted)
     *     console.log(plaintext, hit.distance)
     * }
     * ```
     */
    async recallManual(opts: RecallManualOptions): Promise<RecallManualResult> {
        return this.signedRequest<RecallManualResult>("POST", "/api/recall/manual", {
            vector: opts.vector,
            limit: opts.limit ?? 10,
            namespace: opts.namespace ?? this.namespace,
        });
    }

    /**
     * Generate an embedding vector for text (no storage).
     *
     * @param text - Text to embed
     * @returns EmbedResult with vector
     */
    async embed(text: string): Promise<EmbedResult> {
        return this.signedRequest<EmbedResult>("POST", "/api/embed", { text });
    }

    /**
     * Analyze conversation text — server uses LLM to extract facts, then
     * stores each one (embed → encrypt → Walrus → store).
     *
     * @param text - Conversation text to analyze
     * @returns AnalyzeResult with extracted and stored facts
     *
     * @example
     * ```typescript
     * const result = await memwal.analyze("I love coffee and live in Tokyo")
     * console.log(result.facts) // ["User loves coffee", "User lives in Tokyo"]
     * ```
     */
    async analyze(text: string, namespace?: string): Promise<AnalyzeResult> {
        return this.signedRequest<AnalyzeResult>("POST", "/api/analyze", {
            text,
            namespace: namespace ?? this.namespace,
        });
    }

    /**
     * Restore a namespace — server downloads all blobs from Walrus,
     * decrypts with delegate key, re-embeds, and re-indexes.
     *
     * @param namespace - Namespace to restore
     * @returns RestoreResult with count of restored entries
     *
     * @example
     * ```typescript
     * const result = await memwal.restore("my-app")
     * console.log(`Restored ${result.restored} memories`)
     * ```
     */
    async restore(namespace: string, limit: number = 50): Promise<RestoreResult> {
        return this.signedRequest<RestoreResult>("POST", "/api/restore", {
            namespace,
            limit,
        });
    }

    /**
     * Check server health.
     */
    async health(): Promise<HealthResult> {
        const res = await fetch(`${this.serverUrl}/health`);
        if (!res.ok) {
            throw new Error(`Health check failed: ${res.status}`);
        }
        return res.json();
    }

    /**
     * Get the public key (hex string).
     */
    async getPublicKeyHex(): Promise<string> {
        const pk = await this.getPublicKey();
        return bytesToHex(pk);
    }

    // ============================================================
    // Memory Management API
    // ============================================================

    /**
     * Get memory statistics for a namespace.
     *
     * @param namespace - Namespace to get stats for (default: config namespace)
     * @returns MemoryStats with counts, types breakdown, importance stats
     *
     * @example
     * ```typescript
     * const stats = await memwal.stats()
     * console.log(`Total: ${stats.total}, Avg importance: ${stats.avg_importance}`)
     * ```
     */
    async stats(namespace?: string): Promise<MemoryStats> {
        return this.signedRequest<MemoryStats>("POST", "/api/stats", {
            namespace: namespace ?? this.namespace,
        });
    }

    /**
     * Selectively forget memories matching a semantic query.
     * Performs soft-deletion (memories are invalidated, not permanently deleted).
     *
     * @param query - Semantic query to find memories to forget
     * @param options - Limit and similarity threshold
     * @returns ForgetResult with count of forgotten memories
     *
     * @example
     * ```typescript
     * const result = await memwal.forget("peanut allergy")
     * console.log(`Forgot ${result.forgotten} memories`)
     * ```
     */
    async forget(
        query: string,
        options?: { limit?: number; threshold?: number; namespace?: string },
    ): Promise<ForgetResult> {
        return this.signedRequest<ForgetResult>("POST", "/api/forget", {
            query,
            limit: options?.limit ?? 5,
            threshold: options?.threshold ?? 0.8,
            namespace: options?.namespace ?? this.namespace,
        });
    }

    /**
     * Trigger manual memory consolidation — merge duplicates, resolve conflicts.
     *
     * @param namespace - Namespace to consolidate (default: config namespace)
     * @param limit - Max memories to process (default: 50)
     *
     * @example
     * ```typescript
     * await memwal.consolidate()
     * ```
     */
    async consolidate(namespace?: string, limit?: number): Promise<void> {
        await this.signedRequest<unknown>("POST", "/api/consolidate", {
            namespace: namespace ?? this.namespace,
            limit: limit ?? 50,
        });
    }

    // ============================================================
    // Internal: Signed HTTP Requests
    // ============================================================

    private async getPublicKey(): Promise<Uint8Array> {
        if (!this.publicKey) {
            const ed = await getEd();
            this.publicKey = await ed.getPublicKeyAsync(this.privateKey);
        }
        return this.publicKey;
    }

    /**
     * Make a signed request to the server.
     *
     * Signature format: "{timestamp}.{method}.{path}.{body_sha256}"
     * Headers: x-public-key, x-signature, x-timestamp
     *
     * The server uses x-public-key to look up the owner via onchain
     * MemWalAccount.delegate_keys — no need to send owner in the body.
     */
    private async signedRequest<T>(
        method: string,
        path: string,
        body: object,
    ): Promise<T> {
        const ed = await getEd();

        const timestamp = Math.floor(Date.now() / 1000).toString();
        const bodyStr = JSON.stringify(body);
        const bodySha256 = await sha256hex(bodyStr);

        // Build message to sign
        const message = `${timestamp}.${method}.${path}.${bodySha256}`;
        const msgBytes = new TextEncoder().encode(message);

        // Sign with Ed25519
        const signature = await ed.signAsync(msgBytes, this.privateKey);
        const publicKey = await this.getPublicKey();

        // Make HTTP request
        const url = `${this.serverUrl}${path}`;
        const res = await fetch(url, {
            method,
            headers: {
                "Content-Type": "application/json",
                "x-public-key": bytesToHex(publicKey),
                "x-signature": bytesToHex(signature),
                "x-timestamp": timestamp,
                "x-delegate-key": bytesToHex(this.privateKey),
                "x-account-id": this.accountId,
            },
            body: bodyStr,
        });

        if (!res.ok) {
            const errText = await res.text();
            throw new Error(`MemWal API error (${res.status}): ${errText}`);
        }

        return res.json() as Promise<T>;
    }
}
