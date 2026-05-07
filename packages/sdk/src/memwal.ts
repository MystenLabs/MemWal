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
 * // Remember — returns an accepted background job immediately
 * const accepted = await memwal.remember("I'm allergic to peanuts")
 * await memwal.waitForRememberJob(accepted.job_id)
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
    AnalyzeWaitResult,
    HealthResult,
    RememberManualOptions,
    RememberManualResult,
    RecallManualOptions,
    RecallManualResult,
    RestoreResult,
    RememberBulkItem,
    RememberBulkOptions,
    RememberBulkResult,
    RememberAcceptedResult,
    RememberJobStatus,
    RememberBulkAcceptedResult,
    RememberBulkStatusResult,
    RememberBulkStatusItem,
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

// ENG-1697: SEAL SessionKey cache layout. `bytes` holds the
// base64(JSON(ExportedSessionKey)) envelope transmitted in the
// `x-seal-session` header. `expiresAt` is an absolute epoch-millis
// deadline with a safety margin applied so we refresh before the SEAL
// key servers observe the session as expired.
interface SessionCacheEntry {
    bytes: string;
    expiresAt: number;
}

interface ServerConfig {
    packageId: string;
    network: string;
    suiRpcUrl: string;
}

const SEAL_SESSION_TTL_MIN = 5;
// Refresh 30 seconds before SEAL's 5-minute TTL to avoid the window where
// the client thinks the session is valid but a just-received request hits
// a key server that sees it as expired.
const SEAL_SESSION_SAFETY_MARGIN_MS = 30_000;

type RememberStatusResponse = RememberJobStatus | { error?: string };

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function pollingDelayMs(baseMs: number, attempt: number): number {
    const base = Math.max(100, baseMs);
    const capped = Math.min(10_000, base * 1.5 ** Math.min(attempt, 6));
    const jitter = 0.75 + Math.random() * 0.5;
    return Math.floor(capped * jitter);
}

function isTransientPollingStatus(status: number): boolean {
    return status === 0 || status === 429 || status >= 500;
}

export class MemWal {
    private privateKey: Uint8Array;
    private publicKey: Uint8Array | null = null;
    private serverUrl: string;
    private namespace: string;
    private accountId: string;

    // ENG-1697 state — all internal, never surfaced to user code.
    // The public API (`MemWal.create({ key, accountId })`) is unchanged.
    private sessionCache: SessionCacheEntry | null = null;
    private serverConfig: ServerConfig | null = null;
    /** Single-flight guard so concurrent requests share one SessionKey build. */
    private sessionBuildPromise: Promise<string> | null = null;

    private constructor(config: MemWalConfig) {
        this.privateKey = typeof config.key === "string" ? hexToBytes(config.key) : config.key;
        this.accountId = config.accountId;
        // LOW-22: default to HTTPS for production usage; normalizeServerUrl
        // warns (does not throw) if a user passes plain http:// for a
        // non-localhost host.
        this.serverUrl = normalizeServerUrl(config.serverUrl ?? "https://relayer.memwal.ai/");
        this.namespace = config.namespace ?? "default";
    }

    /**
     * Create a new MemWal client instance.
     *
     * @param config.key - Ed25519 private key (hex string) — the delegate key
     * @param config.serverUrl - Server URL (default: https://relayer.memwal.ai/)
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
        // ENG-1697: drop cached session material too — once destroyed the
        // instance must not leak authorization tokens either.
        this.sessionCache = null;
        this.serverConfig = null;
    }

    // ============================================================
    // Core API
    // ============================================================

    /**
     * Submit a remember request and return as soon as the server accepts the job.
     */
    async rememberAsync(text: string, namespace?: string): Promise<RememberAcceptedResult> {
        return this.signedRequest<RememberAcceptedResult>(
            "POST",
            "/api/remember",
            { text, namespace: namespace ?? this.namespace },
            [200, 202],
        );
    }

    /**
     * Poll an accepted remember job until it reaches a terminal state.
     */
    async waitForRememberJob(
        jobId: string,
        opts: { pollIntervalMs?: number; timeoutMs?: number } = {},
    ): Promise<RememberResult> {
        const { pollIntervalMs = 1500, timeoutMs = 60_000 } = opts;
        const deadline = Date.now() + timeoutMs;
        let attempt = 0;

        while (Date.now() < deadline) {
            await sleep(pollingDelayMs(pollIntervalMs, attempt++));

            let status: RememberStatusResponse;

            try {
                status = await this.signedRequest<RememberStatusResponse>(
                    "GET",
                    `/api/remember/${jobId}`,
                    {},
                    [200, 404],
                );
            } catch (err) {
                const httpStatus = (err as { status?: number }).status ?? 0;
                if (isTransientPollingStatus(httpStatus)) {
                    continue;
                }
                throw err;
            }

            if (!("status" in status) || status.status === "not_found") {
                throw Object.assign(new Error(`remember job not found: ${jobId}`), {
                    status: 404,
                    jobId,
                });
            }

            if (status.status === "done") {
                return {
                    id: status.job_id,
                    job_id: status.job_id,
                    blob_id: status.blob_id ?? "",
                    owner: status.owner ?? "",
                    namespace: status.namespace ?? this.namespace,
                };
            }
            if (status.status === "failed") {
                throw Object.assign(
                    new Error(`remember job failed: ${status.error ?? "unknown error"}`),
                    { status: 500, jobId },
                );
            }
        }

        throw Object.assign(
            new Error(`remember job timed out after ${timeoutMs}ms (job_id=${jobId})`),
            { status: 504, jobId },
        );
    }

    /**
     * Remember something and wait for the background job to complete.
     */
    async rememberAndWait(
        text: string,
        namespace?: string,
        opts: { pollIntervalMs?: number; timeoutMs?: number } = {},
    ): Promise<RememberResult> {
        const accepted = await this.rememberAsync(text, namespace);
        return this.waitForRememberJob(accepted.job_id, opts);
    }

    /**
     * Remember something and return as soon as the server accepts the job.
     *
     * The relayer continues embedding, encrypting, uploading, and indexing in the background.
     * Use rememberAndWait() when the caller needs the final blob_id before continuing.
     *
     * @param text - The text to remember
     * @param namespace - Optional namespace override
     */
    async remember(text: string, namespace?: string): Promise<RememberAcceptedResult> {
        return this.rememberAsync(text, namespace);
    }

    /**
     * Remember multiple memories in one batched request (ENG-1408).
     *
     * Server handles: verify → embed + SEAL-encrypt all items concurrently →
     * upload N blobs to Walrus in parallel → 1 PTB per wallet slot for
     * set-metadata + transfer. This collapses `N × (2 + 1)` Sui transactions
     * into roughly `2N + K` where K ≤ wallet pool size.
     *
     * Returns `202 Accepted` immediately with `job_ids[]`.
     *
     * @param items - Array of `{ text, namespace? }` items (max 20 per call)
     *
     * @example
     * ```typescript
     * const accepted = await memwal.rememberBulk([
     *     { text: "I love coffee" },
     *     { text: "I live in Tokyo", namespace: "profile" },
     * ])
     * console.log(accepted.job_ids)
     * ```
     */
    async rememberBulkAsync(items: RememberBulkItem[]): Promise<RememberBulkAcceptedResult> {
        if (!Array.isArray(items) || items.length === 0) {
            throw new Error("rememberBulkAsync: items must be a non-empty array");
        }

        const normalised = items.map((item) => ({
            text: item.text,
            namespace: item.namespace ?? this.namespace,
        }));

        const accepted = await this.signedRequest<RememberBulkAcceptedResult>(
            "POST",
            "/api/remember/bulk",
            { items: normalised },
            [200, 202],
        );

        if (!accepted.job_ids || accepted.job_ids.length !== normalised.length) {
            throw new Error(
                `rememberBulkAsync: server returned ${accepted.job_ids?.length ?? 0} job_ids for ${normalised.length} items`,
            );
        }

        return accepted;
    }

    async getRememberBulkStatus(jobIds: string[]): Promise<RememberBulkStatusResult> {
        return this.signedRequest<RememberBulkStatusResult>(
            "POST",
            "/api/remember/bulk/status",
            { job_ids: jobIds },
        );
    }

    async waitForRememberJobs(
        jobIds: string[],
        namespaces: string[] = [],
        opts: RememberBulkOptions = {},
    ): Promise<RememberBulkResult> {
        const { pollIntervalMs = 1500, timeoutMs = 120_000 } = opts;
        const deadline = Date.now() + timeoutMs;
        const results: RememberBulkItemResult[] = jobIds.map((jobId, idx) => ({
            id: jobId,
            blob_id: "",
            status: "timeout",
            namespace: namespaces[idx] ?? this.namespace,
            error: `polling timed out after ${timeoutMs}ms`,
        }));
        const pending = new Set(jobIds);
        let attempt = 0;

        while (pending.size > 0 && Date.now() < deadline) {
            await sleep(pollingDelayMs(pollIntervalMs, attempt++));

            const pendingIds = jobIds.filter((jobId) => pending.has(jobId));
            if (pendingIds.length === 0) {
                break;
            }

            let batchStatus: RememberBulkStatusResult;

            try {
                batchStatus = await this.getRememberBulkStatus(pendingIds);
            } catch (err) {
                const httpStatus = (err as { status?: number }).status ?? 0;
                if (isTransientPollingStatus(httpStatus)) {
                    continue;
                }
                throw err;
            }

            const statusById = new Map<string, RememberBulkStatusItem[]>();
            for (const item of batchStatus.results) {
                const bucket = statusById.get(item.job_id);
                if (bucket) {
                    bucket.push(item);
                } else {
                    statusById.set(item.job_id, [item]);
                }
            }

            for (const jobId of pendingIds) {
                const status = statusById.get(jobId)?.shift();
                if (!status) {
                    continue;
                }

                const idx = jobIds.indexOf(jobId);
                if (status.status === "done") {
                    results[idx] = {
                        id: jobId,
                        blob_id: status.blob_id ?? "",
                        status: "done",
                        namespace: namespaces[idx] ?? this.namespace,
                    };
                    pending.delete(jobId);
                } else if (status.status === "failed" || status.status === "not_found") {
                    results[idx] = {
                        id: jobId,
                        blob_id: "",
                        status: "failed",
                        namespace: namespaces[idx] ?? this.namespace,
                        error:
                            status.status === "not_found"
                                ? "job not found"
                                : status.error ?? "unknown error",
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
     * Remember multiple memories and return as soon as the server accepts the jobs.
     */
    async rememberBulk(items: RememberBulkItem[]): Promise<RememberBulkAcceptedResult> {
        return this.rememberBulkAsync(items);
    }

    /**
     * Remember multiple memories and wait until every job reaches a terminal state.
     */
    async rememberBulkAndWait(
        items: RememberBulkItem[],
        opts: RememberBulkOptions = {},
    ): Promise<RememberBulkResult> {
        const namespaces = items.map((item) => item.namespace ?? this.namespace);
        const accepted = await this.rememberBulkAsync(items);
        return this.waitForRememberJobs(accepted.job_ids, namespaces, opts);
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
        const ac = new AbortController();
        const tid = setTimeout(() => ac.abort(), 15000);
        try {
            return await this.signedRequest<RecallResult>("POST", "/api/recall", {
                query,
                limit,
                namespace: namespace ?? this.namespace,
            }, { signal: ac.signal });
        } finally {
            clearTimeout(tid);
        }
    }

    // ============================================================
    // Manual API (user handles SEAL + embedding + Walrus)
    // ============================================================

    /**
     * Remember (manual mode) — user handles SEAL encrypt, embedding,
     * and Walrus upload externally. Server only stores the vector ↔ blobId mapping.
     *
     * Trust boundary (ENG-1696): the delegate private key is NOT transmitted on
     * this request. Manual-mode handlers on the server never invoke SEAL
     * decrypt, so the key stays client-side as the name implies.
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
        return this.signedRequest<RememberManualResult>(
            "POST",
            "/api/remember/manual",
            {
                blob_id: opts.blobId,
                vector: opts.vector,
                namespace: opts.namespace ?? this.namespace,
            },
            { includeDelegateKey: false },
        );
    }

    /**
     * Recall (manual mode) — user provides a pre-computed query vector.
     * Server returns matching blobIds + distances.
     * User then downloads from Walrus + SEAL decrypts on their own.
     *
     * Trust boundary (ENG-1696): the delegate private key is NOT transmitted on
     * this request. Server returns blob IDs only; decryption happens entirely
     * on the client.
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
        return this.signedRequest<RecallManualResult>(
            "POST",
            "/api/recall/manual",
            {
                vector: opts.vector,
                limit: opts.limit ?? 10,
                namespace: opts.namespace ?? this.namespace,
            },
            { includeDelegateKey: false },
        );
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
     * Analyze conversation text and return as soon as extracted facts are accepted.
     *
     * The relayer extracts facts synchronously, returns one job_id per fact, then
     * embeds, encrypts, uploads, and indexes each fact in the background.
     *
     * @param text - Conversation text to analyze
     * @returns AnalyzeResult with extracted facts and accepted job_ids
     *
     * @example
     * ```typescript
     * const result = await memwal.analyze("I love coffee and live in Tokyo")
     * console.log(result.job_ids)
     * ```
     */
    async analyze(text: string, namespace?: string): Promise<AnalyzeResult> {
        return this.signedRequest<AnalyzeResult>("POST", "/api/analyze", {
            text,
            namespace: namespace ?? this.namespace,
        }, [200, 202]);
    }

    /**
     * Analyze conversation text and wait until every extracted fact is stored.
     */
    async analyzeAndWait(
        text: string,
        namespace?: string,
        opts: RememberBulkOptions = {},
    ): Promise<AnalyzeWaitResult> {
        const accepted = await this.analyze(text, namespace);
        const namespaces = accepted.job_ids.map(() => namespace ?? this.namespace);
        const completed = await this.waitForRememberJobs(accepted.job_ids, namespaces, opts);
        return {
            ...completed,
            facts: accepted.facts,
            owner: accepted.owner,
        };
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

    // ============================================================
    // ENG-1697: SEAL SessionKey discovery & build
    //
    // The SDK used to transmit the raw delegate private key in
    // `x-delegate-key` on every request. That credential, once captured,
    // lets an attacker retroactively decrypt every ciphertext the account
    // ever produced (until the user rotates on-chain) and sign arbitrary
    // Sui transactions from the delegate address.
    //
    // We now build a SEAL `SessionKey` on the client (ephemeral, scoped to
    // a single `packageId`, 5-minute TTL, signed by the delegate key) and
    // ship only the exported session bytes via `x-seal-session`. The raw
    // private key never leaves the client.
    //
    // `packageId` is fetched from the server's public `/config` endpoint
    // the first time it's needed so the user API (`new MemWal({ key,
    // accountId })`) stays unchanged — past users upgrading to v0.4 do not
    // have to touch their config.
    //
    // Requires `@mysten/seal` and `@mysten/sui` peer dependencies.
    // ============================================================

    private async fetchServerConfig(): Promise<ServerConfig> {
        if (this.serverConfig) return this.serverConfig;
        const res = await fetch(`${this.serverUrl}/config`, { method: "GET" });
        if (!res.ok) {
            throw new Error(`GET /config returned ${res.status}`);
        }
        const body = (await res.json()) as Partial<ServerConfig>;
        if (!body.packageId || !body.network || !body.suiRpcUrl) {
            throw new Error("GET /config response missing packageId / network / suiRpcUrl");
        }
        this.serverConfig = {
            packageId: body.packageId,
            network: body.network,
            suiRpcUrl: body.suiRpcUrl,
        };
        return this.serverConfig;
    }

    private async buildSealSessionInner(): Promise<string> {
        const cfg = await this.fetchServerConfig();
        // @mysten/sui renamed/moved `SuiClient` between minor versions:
        //   - pre-2.6:  `SuiClient` in `@mysten/sui/client`
        //   - 2.6+:     `SuiJsonRpcClient` in `@mysten/sui/jsonRpc`
        // Probe both paths so the SDK works across the supported range.
        const sealMod = (await import("@mysten/seal")) as any;
        const ed25519Mod = (await import("@mysten/sui/keypairs/ed25519")) as any;
        const SessionKey = sealMod.SessionKey;
        const Ed25519Keypair = ed25519Mod.Ed25519Keypair;

        let SuiClient: any = undefined;
        try {
            const mod = (await import("@mysten/sui/client")) as any;
            SuiClient = mod.SuiClient;
        } catch {
            /* not present on this version */
        }
        if (typeof SuiClient !== "function") {
            try {
                const mod = (await import("@mysten/sui/jsonRpc")) as any;
                SuiClient = mod.SuiJsonRpcClient ?? mod.SuiClient;
            } catch {
                /* not present on this version either */
            }
        }
        if (typeof SuiClient !== "function" || typeof Ed25519Keypair !== "function") {
            throw new Error(
                "SuiClient/SuiJsonRpcClient or Ed25519Keypair not found in @mysten/sui. " +
                "Ensure @mysten/sui >=2.5.0 and @mysten/seal >=1.1.0 are installed."
            );
        }

        const keypair = Ed25519Keypair.fromSecretKey(this.privateKey);
        const suiClient = new SuiClient({ url: cfg.suiRpcUrl });

        const session = await SessionKey.create({
            address: keypair.getPublicKey().toSuiAddress(),
            packageId: cfg.packageId,
            ttlMin: SEAL_SESSION_TTL_MIN,
            signer: keypair,
            suiClient: suiClient as any,
        });

        // Eagerly sign the personal message so the exported envelope is
        // fully self-contained. `SessionKey.create()` defers this signing
        // until first use, which would break the migration: the sidecar
        // imports without a signer and must be able to get a certificate
        // from the exported state alone. Calling
        // setPersonalMessageSignature() here populates the
        // `personalMessageSignature` field in the subsequent export().
        const personalMessage = session.getPersonalMessage();
        const signResult = await keypair.signPersonalMessage(personalMessage);
        await session.setPersonalMessageSignature(signResult.signature);

        const exported = session.export();
        // SEAL intentionally installs a throwing `toJSON` on the
        // exported object to catch accidental serialization. The
        // migration to `x-seal-session` IS the intended on-wire
        // format, so we project the primitive fields into a fresh
        // object before stringifying. The sidecar's
        // `SessionKey.import()` expects this exact shape.
        const jsonStr = JSON.stringify({
            address: exported.address,
            packageId: exported.packageId,
            mvrName: exported.mvrName,
            creationTimeMs: exported.creationTimeMs,
            ttlMin: exported.ttlMin,
            personalMessageSignature: exported.personalMessageSignature,
            sessionKey: exported.sessionKey,
        });
        const bytes =
            typeof btoa === "function"
                ? btoa(jsonStr)
                : Buffer.from(jsonStr, "utf8").toString("base64");

        this.sessionCache = {
            bytes,
            expiresAt:
                Date.now() +
                SEAL_SESSION_TTL_MIN * 60_000 -
                SEAL_SESSION_SAFETY_MARGIN_MS,
        };
        return bytes;
    }

    private async buildSealSession(): Promise<string> {
        // Fast path: cached session still fresh.
        if (this.sessionCache && Date.now() < this.sessionCache.expiresAt) {
            return this.sessionCache.bytes;
        }
        // Single-flight: concurrent requests share one build.
        if (this.sessionBuildPromise) return this.sessionBuildPromise;

        this.sessionBuildPromise = this.buildSealSessionInner().finally(() => {
            this.sessionBuildPromise = null;
        });
        return this.sessionBuildPromise;
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
     *
     * ENG-1696: Callers set `includeDelegateKey: false` on Manual-mode routes
     * so the delegate private key is not transmitted. Manual-mode docstrings
     * promise the key stays client-side; the server does not need it on those
     * routes because Manual-mode handlers never invoke SEAL decrypt.
     *
     * ENG-1697: On Relayer-mode routes the SDK builds a SEAL SessionKey
     * client-side (emitted via `x-seal-session`). The SessionKey is ephemeral
     * (5-min TTL, scoped to the server's `packageId`) so a wire capture has
     * a bounded blast radius. Requires `@mysten/seal` and `@mysten/sui`.
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
        acceptedStatusesOrOptions: number[] | { includeDelegateKey?: boolean; signal?: AbortSignal } = [200],
        requestOptions: { includeDelegateKey?: boolean; signal?: AbortSignal } = {},
    ): Promise<T> {
        const acceptedStatuses = Array.isArray(acceptedStatusesOrOptions)
            ? acceptedStatusesOrOptions
            : [200];
        const options = Array.isArray(acceptedStatusesOrOptions)
            ? requestOptions
            : acceptedStatusesOrOptions;
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
        const headers: Record<string, string> = {
            "Content-Type": "application/json",
            "x-public-key": bytesToHex(publicKey),
            "x-signature": bytesToHex(signature),
            "x-timestamp": timestamp,
            "x-nonce": nonce,           // MED-1: replay protection
            "x-account-id": this.accountId,
        };
        // ENG-1696 / ENG-1697: attach a SEAL credential only on Relayer-
        // mode routes where the server needs it for server-side SEAL
        // decrypt. Manual-mode methods (rememberManual, recallManual) opt
        // out and transmit no decrypt credential at all.
        if (options.includeDelegateKey !== false) {
            headers["x-seal-session"] = await this.buildSealSession();
        }
        const res = await fetch(url, {
            method,
            headers,
            body: method === "GET" ? undefined : bodyStr,
            signal: options.signal,
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
