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
    RememberBulkItem,
    RememberBulkOptions,
    RememberBulkResult,
    RememberBulkItemResult,
} from "./types.js";
import { sha256hex, hexToBytes, bytesToHex, normalizeServerUrl, sanitizeServerError } from "./utils.js";

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
        this.privateKey = typeof config.key === "string" ? hexToBytes(config.key) : config.key;
        this.accountId = config.accountId;
        // LOW-22: default to HTTPS for production usage; normalizeServerUrl
        // warns (does not throw) if a user passes plain http:// for a
        // non-localhost host.
        this.serverUrl = normalizeServerUrl(config.serverUrl ?? "https://api.memwal.com");
        this.namespace = config.namespace ?? "default";
    }

    /**
     * Create a new MemWal client instance.
     *
     * @param config.key - Ed25519 private key (hex string) — the delegate key
     * @param config.serverUrl - Server URL (default: https://api.memwal.com)
     */
    static create(config: MemWalConfig): MemWal {
        return new MemWal(config);
    }

    /**
     * Securely wipe the private and public keys from memory.
     * Prevents key extraction from V8 heap dumps.
     */
    destroy(): void {
        if (this.privateKey) {
            this.privateKey.fill(0);
        }
        if (this.publicKey) {
            this.publicKey.fill(0);
        }
    }

    // ============================================================
    // Core API
    // ============================================================

    /**
     * Remember something — server handles: verify → embed → encrypt → Walrus upload → store.
     *
     * Server now returns **202 Accepted** immediately with a `job_id`.
     * This method transparently polls `GET /api/remember/:job_id` until the
     * pipeline completes (\~3–5 s), then resolves with the final result.
     *
     * The polling is invisible to callers — usage is unchanged:
     * ```typescript
     * const result = await memwal.remember("I'm allergic to peanuts")
     * console.log(result.blob_id) // available once done
     * ```
     *
     * @param text - The text to remember
     * @param namespace - Optional namespace override
     * @param opts.pollIntervalMs - How often to poll (default 1500ms)
     * @param opts.timeoutMs - Max wait time before throwing (default 60_000ms)
     */
    async remember(
        text: string,
        namespace?: string,
        opts: { pollIntervalMs?: number; timeoutMs?: number } = {},
    ): Promise<RememberResult> {
        const { pollIntervalMs = 1500, timeoutMs = 60_000 } = opts;
        const ns = namespace ?? this.namespace;

        // POST → 202 + { job_id }
        const accepted = await this.signedRequest<{ job_id: string; status: string }>(
            "POST",
            "/api/remember",
            { text, namespace: ns },
            [200, 202],
        );

        const jobId = accepted.job_id;
        const deadline = Date.now() + timeoutMs;

        // Poll until done or failed
        while (Date.now() < deadline) {
            await new Promise((r) => setTimeout(r, pollIntervalMs));

            const status = await this.signedRequest<{
                job_id: string;
                status: string;
                owner?: string;
                namespace?: string;
                blob_id?: string;
                error?: string;
            }>("GET", `/api/remember/${jobId}`, {});

            if (status.status === "done") {
                return {
                    id: jobId,
                    blob_id: status.blob_id ?? "",
                    owner: status.owner ?? "",
                    namespace: status.namespace ?? ns,
                };
            }
            if (status.status === "failed") {
                throw Object.assign(
                    new Error(`remember job failed: ${status.error ?? "unknown error"}`),
                    { status: 500, jobId },
                );
            }
            // status is "pending" or "running" — keep polling
        }

        throw Object.assign(
            new Error(`remember job timed out after ${timeoutMs}ms (job_id=${jobId})`),
            { status: 504, jobId },
        );
    }

    /**
     * Remember multiple memories in one batched request (ENG-1408).
     *
     * Server handles: verify → embed + SEAL-encrypt all items concurrently →
     * upload N blobs to Walrus in parallel → 1 PTB per wallet slot for
     * set-metadata + transfer. This collapses `N × (2 + 1)` Sui transactions
     * into roughly `2N + K` where K ≤ wallet pool size.
     *
     * Returns `202 Accepted` immediately with `job_ids[]`; this method then
     * polls the batch status endpoint and resolves
     * once all jobs reach a terminal state (`done`, `failed`, or `timeout`).
     *
     * @param items - Array of `{ text, namespace? }` items (max 20 per call)
     * @param opts.pollIntervalMs - How often to poll each job (default 1500ms)
     * @param opts.timeoutMs - Max total wait (default 120_000ms)
     *
     * @example
     * ```typescript
     * const result = await memwal.rememberBulk([
     *     { text: "I love coffee" },
     *     { text: "I live in Tokyo", namespace: "profile" },
     * ])
     * console.log(`${result.succeeded}/${result.total} stored`)
     * for (const r of result.results) {
     *     if (r.status === "done") console.log(r.blob_id)
     * }
     * ```
     */
    async rememberBulk(
        items: RememberBulkItem[],
        opts: RememberBulkOptions = {},
    ): Promise<RememberBulkResult> {
        if (!Array.isArray(items) || items.length === 0) {
            throw new Error("rememberBulk: items must be a non-empty array");
        }

        const { pollIntervalMs = 1500, timeoutMs = 120_000 } = opts;

        // Normalise namespaces up front so we can echo them back per-item.
        const normalised = items.map((item) => ({
            text: item.text,
            namespace: item.namespace ?? this.namespace,
        }));

        // POST → 202 + { job_ids, total, status }
        const accepted = await this.signedRequest<{
            job_ids: string[];
            total: number;
            status: string;
        }>(
            "POST",
            "/api/remember/bulk",
            { items: normalised },
            [200, 202],
        );

        if (!accepted.job_ids || accepted.job_ids.length !== normalised.length) {
            throw new Error(
                `rememberBulk: server returned ${accepted.job_ids?.length ?? 0} job_ids for ${normalised.length} items`,
            );
        }

        const deadline = Date.now() + timeoutMs;

        const results: RememberBulkItemResult[] = accepted.job_ids.map((jobId, idx) => ({
            id: jobId,
            blob_id: "",
            status: "timeout",
            namespace: normalised[idx].namespace,
            error: `polling timed out after ${timeoutMs}ms`,
        }));
        const pending = new Set(accepted.job_ids);

        while (pending.size > 0 && Date.now() < deadline) {
            await new Promise((r) => setTimeout(r, pollIntervalMs));

            const pendingIds = accepted.job_ids.filter((jobId) => pending.has(jobId));
            if (pendingIds.length === 0) {
                break;
            }

            let batchStatus: {
                results: Array<{
                    job_id: string;
                    status: string;
                    blob_id?: string;
                    error?: string;
                }>;
            };

            try {
                batchStatus = await this.signedRequest<typeof batchStatus>(
                    "POST",
                    "/api/remember/bulk/status",
                    { job_ids: pendingIds },
                );
            } catch (err) {
                const httpStatus = (err as { status?: number }).status ?? 0;
                // Retry on transient failures including 429 rate limit.
                if (httpStatus === 429 || httpStatus >= 500 || httpStatus === 0) {
                    continue;
                }
                throw err;
            }

            const statusById = new Map(batchStatus.results.map((item) => [item.job_id, item]));
            for (const jobId of pendingIds) {
                const status = statusById.get(jobId);
                if (!status) {
                    continue;
                }

                const idx = accepted.job_ids.indexOf(jobId);
                if (status.status === "done") {
                    results[idx] = {
                        id: jobId,
                        blob_id: status.blob_id ?? "",
                        status: "done",
                        namespace: normalised[idx].namespace,
                    };
                    pending.delete(jobId);
                } else if (status.status === "failed") {
                    results[idx] = {
                        id: jobId,
                        blob_id: "",
                        status: "failed",
                        namespace: normalised[idx].namespace,
                        error: status.error ?? "unknown error",
                    };
                    pending.delete(jobId);
                }
            }
        }

        const succeeded = results.filter((r) => r.status === "done").length;

        return {
            results,
            total: results.length,
            succeeded,
            failed: results.length - succeeded,
        };
    }

    /**
     * Recall memories similar to a query — server handles:
     * verify → embed query → search → Walrus download → decrypt → return plaintext
     *
     * @param query - Search query
     * @param limit - Max number of results (default: 10)
     * @returns RecallResult with decrypted text results
     *
     * @example
     * ```typescript
     * const result = await memwal.recall("food allergies")
     * for (const memory of result.results) {
     *     console.log(memory.text, memory.distance)
     * }
     * ```
     */
    async recall(query: string, limit: number = 10, namespace?: string): Promise<RecallResult> {
        return this.signedRequest<RecallResult>("POST", "/api/recall", {
            query,
            limit,
            namespace: namespace ?? this.namespace,
        });
    }

    // ============================================================
    // Manual API (user handles SEAL + embedding + Walrus)
    // ============================================================

    /**
     * Remember (manual mode) — user handles SEAL encrypt, embedding,
     * and Walrus upload externally. Server only stores the vector ↔ blobId mapping.
     *
     * @param opts.blobId - Walrus blob ID (user already uploaded encrypted data)
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
        return this.signedRequest<RememberManualResult>("POST", "/api/remember/manual", {
            blob_id: opts.blobId,
            vector: opts.vector,
            namespace: opts.namespace ?? this.namespace,
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
     *
     * INFO-7: The health endpoint is currently public/unsigned server-side,
     * but we send the same signed-request envelope as every other call so
     * that (a) the channel is authenticated whenever the server opts in, and
     * (b) a MitM cannot trivially forge a "healthy" response for a client
     * that has no way to tell. If the server ignores the signature headers
     * on `/health`, this is still a harmless no-op.
     */
    async health(): Promise<HealthResult> {
        try {
            return await this.signedRequest<HealthResult>("GET", "/health", {});
        } catch (err) {
            // Fall back to a plain GET for servers that reject bodies on GET /health.
            const res = await fetch(`${this.serverUrl}/health`);
            if (!res.ok) {
                throw err instanceof Error
                    ? err
                    : new Error(`Health check failed: ${res.status}`);
            }
            return res.json() as Promise<HealthResult>;
        }
    }

    /**
     * Get the public key (hex string).
     */
    async getPublicKeyHex(): Promise<string> {
        const pk = await this.getPublicKey();
        return bytesToHex(pk);
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
     * Signature format (LOW-23 updated):
     *   "{timestamp}.{method}.{path}.{body_sha256}.{nonce}.{account_id}"
     *
     * Headers: x-public-key, x-signature, x-timestamp, x-nonce, x-account-id
     *
     * The nonce is a UUID v4 generated per-request and tracked server-side
     * in Redis (TTL=600s) to prevent replay attacks.
     *
     * LOW-23: x-account-id is now included in the signed canonical message so
     * an intermediary cannot swap the account hint without invalidating the
     * signature. Server-side verification in services/server/src/auth.rs must
     * use the matching message format.
     */
    /**
     * Make a signed request to the server.
     *
     * @param acceptedStatuses - HTTP status codes to treat as success (default [200]).
     *   Pass [200, 202] for endpoints that return 202 Accepted.
     */
    private async signedRequest<T>(
        method: string,
        path: string,
        body: object,
        acceptedStatuses: number[] = [200],
    ): Promise<T> {
        const ed = await getEd();

        const timestamp = Math.floor(Date.now() / 1000).toString();
        // Canonical body used for both: (a) the HTTP wire body and
        // (b) the SHA-256 digest inside the signed message. GET requests
        // carry no body, so the server will hash an EMPTY byte string —
        // we must sign the same empty string for the signature to verify.
        const bodyStr = method === "GET" ? "" : JSON.stringify(body);
        const bodySha256 = await sha256hex(bodyStr);

        // MED-1 fix: Generate per-request nonce (UUID v4) for replay protection
        const nonce = crypto.randomUUID();

        // LOW-23: Build message to sign — now includes nonce AND account id
        const message = `${timestamp}.${method}.${path}.${bodySha256}.${nonce}.${this.accountId}`;
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
                "x-nonce": nonce,           // MED-1: replay protection
                "x-delegate-key": bytesToHex(this.privateKey),
                "x-account-id": this.accountId,
            },
            body: method === "GET" ? undefined : bodyStr,
        });

        if (!acceptedStatuses.includes(res.status)) {
            // LOW-26: sanitize server error bodies before surfacing to callers.
            const raw = await res.text();
            const { message, serverCode } = sanitizeServerError(res.status, raw);
            const err = new Error(message) as Error & {
                status?: number;
                serverCode?: string;
                cause?: string;
            };
            err.status = res.status;
            if (serverCode) err.serverCode = serverCode;
            // Preserve raw body on `cause` for in-process debugging only.
            err.cause = raw;
            throw err;
        }

        return res.json() as Promise<T>;
    }
}
