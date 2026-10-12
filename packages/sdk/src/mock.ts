import type {
    AnalyzeOptions,
    AnalyzeResult,
    AnalyzeWaitResult,
    EmbedResult,
    HealthResult,
    RecallOptions,
    RecallParams,
    RecallResult,
    RelayerVersionMetadata,
    RememberAcceptedResult,
    RememberBulkAcceptedResult,
    RememberBulkItem,
    RememberBulkItemResult,
    RememberBulkOptions,
    RememberBulkResult,
    RememberBulkStatusResult,
    RememberJobStatus,
    RememberResult,
    RestoreResult,
    NamespacesResult,
    ListNamespacesOptions,
} from "./types.js";
import { applyTokenBudget, estimateTokens } from "./tokens.js";

export interface MemWalMockSeed {
    text: string;
    namespace?: string;
    blobId?: string;
}

export interface MemWalMockConfig {
    /** Default namespace, matching MemWalConfig (default: "default"). */
    namespace?: string;
    /** Stable owner value returned by result objects (default: "mock-owner"). */
    owner?: string;
    /** Optional records loaded synchronously when the mock is created. */
    initialMemories?: MemWalMockSeed[];
}

interface MockMemory {
    id: string;
    jobId: string;
    blobId: string;
    text: string;
    namespace: string;
    sequence: number;
}

/**
 * Fixed base for synthesised namespace timestamps. `MockMemory` carries no
 * clock, so `updated_at` is derived from insertion order instead — keeping
 * mock runs reproducible while preserving the real relayer's property that
 * later writes sort later.
 */
const MOCK_NAMESPACE_EPOCH_MS = Date.UTC(2026, 0, 1);

const MOCK_VERSION: RelayerVersionMetadata = {
    relayerVersion: "memwal-mock",
    apiVersion: "1.0.0",
    minSupportedSdk: { typescript: "0.0.0", python: "0.0.0", mcp: "0.0.0" },
    featureFlags: { offlineMock: true },
    deprecations: [],
    build: {},
};

function tokenize(text: string): Set<string> {
    return new Set(
        text
            .normalize("NFKC")
            .toLowerCase()
            .match(/[\p{L}\p{N}]+/gu) ?? []
    );
}

function distance(queryTokens: Set<string>, text: string): number {
    if (queryTokens.size === 0) return 1;
    const memoryTokens = tokenize(text);
    let matches = 0;
    for (const token of queryTokens) {
        if (memoryTokens.has(token)) matches += 1;
    }
    return 1 - matches / queryTokens.size;
}

function validateText(text: string, field = "text"): void {
    if (typeof text !== "string" || text.trim().length === 0) {
        throw new Error(`${field} cannot be empty`);
    }
}

const MAX_IDEMPOTENCY_KEY_BYTES = 255;

function validateIdempotencyKey(key: string | undefined): void {
    if (key === undefined) return;
    if (key.length === 0) {
        throw new Error("idempotency_key cannot be empty (omit it instead)");
    }
    if (new TextEncoder().encode(key).length > MAX_IDEMPOTENCY_KEY_BYTES) {
        throw new Error(
            `idempotency_key exceeds maximum length of ${MAX_IDEMPOTENCY_KEY_BYTES} bytes`,
        );
    }
}

/** How many semantic candidates `sort: "recent"` reorders. Mirrors `RecallSort::candidate_limit`. */
function recentCandidateLimit(limit: number): number {
    return Math.max(Math.min(limit * 5, 50), limit);
}

/**
 * Deterministic, dependency-free in-memory implementation of the core MemWal API.
 * It never opens a socket, reads credentials, or contacts Sui/Walrus. Recall uses
 * token-overlap distance so tests are stable across machines and runs.
 */
export class MemWalMock {
    private readonly owner: string;
    private readonly namespace: string;
    private readonly memories: MockMemory[] = [];
    private readonly jobs = new Map<string, MockMemory>();
    /** idempotency key → job id. Released when that job's memory is forgotten. */
    private readonly idempotency = new Map<string, string>();
    private sequence = 0;

    private constructor(config: MemWalMockConfig = {}) {
        this.owner = config.owner ?? "mock-owner";
        this.namespace = config.namespace ?? "default";
        if (!this.namespace) throw new Error("namespace cannot be empty");
        for (const seed of config.initialMemories ?? []) {
            this.store(seed.text, seed.namespace, seed.blobId);
        }
    }

    static create(config: MemWalMockConfig = {}): MemWalMock {
        return new MemWalMock(config);
    }

    destroy(): void {
        this.memories.length = 0;
        this.jobs.clear();
        this.idempotency.clear();
    }

    async rememberAsync(
        text: string,
        namespace?: string,
        options: { idempotencyKey?: string } = {}
    ): Promise<RememberAcceptedResult> {
        const memory = this.store(text, namespace, undefined, options.idempotencyKey);
        return { job_id: memory.jobId, status: "done" };
    }

    async remember(
        text: string,
        namespace?: string,
        options: { idempotencyKey?: string } = {}
    ): Promise<RememberAcceptedResult> {
        return this.rememberAsync(text, namespace, options);
    }

    async getRememberStatus(jobId: string): Promise<RememberJobStatus> {
        const memory = this.jobs.get(jobId);
        if (!memory) return { job_id: jobId, status: "not_found" };
        return {
            job_id: jobId,
            status: "done",
            owner: this.owner,
            namespace: memory.namespace,
            blob_id: memory.blobId,
        };
    }

    async waitForRememberJob(
        jobId: string,
        _opts: { pollIntervalMs?: number; timeoutMs?: number } = {}
    ): Promise<RememberResult> {
        const memory = this.jobs.get(jobId);
        if (!memory) throw new Error(`Remember job not found: ${jobId}`);
        return this.toRememberResult(memory);
    }

    async rememberAndWait(
        text: string,
        namespace?: string,
        opts: { pollIntervalMs?: number; timeoutMs?: number; idempotencyKey?: string } = {}
    ): Promise<RememberResult> {
        const accepted = await this.rememberAsync(text, namespace, {
            idempotencyKey: opts.idempotencyKey,
        });
        return this.waitForRememberJob(accepted.job_id, opts);
    }

    async rememberBulkAsync(
        items: RememberBulkItem[]
    ): Promise<RememberBulkAcceptedResult> {
        if (!Array.isArray(items) || items.length === 0) {
            throw new Error("rememberBulkAsync: items must be a non-empty array");
        }
        const jobIds = items.map(
            (item) => this.store(item.text, item.namespace).jobId
        );
        return { job_ids: jobIds, total: jobIds.length, status: "done" };
    }

    async rememberBulk(
        items: RememberBulkItem[]
    ): Promise<RememberBulkAcceptedResult> {
        return this.rememberBulkAsync(items);
    }

    async getRememberBulkStatus(
        jobIds: string[]
    ): Promise<RememberBulkStatusResult> {
        return {
            results: jobIds.map((jobId) => {
                const memory = this.jobs.get(jobId);
                return memory
                    ? { job_id: jobId, status: "done", blob_id: memory.blobId }
                    : { job_id: jobId, status: "not_found" };
            }),
        };
    }

    async waitForRememberJobs(
        jobIds: string[],
        namespaces: string[] = [],
        _opts: RememberBulkOptions = {}
    ): Promise<RememberBulkResult> {
        const results: RememberBulkItemResult[] = jobIds.map((jobId, index) => {
            const memory = this.jobs.get(jobId);
            return memory
                ? {
                      id: jobId,
                      blob_id: memory.blobId,
                      status: "done",
                      namespace: memory.namespace,
                  }
                : {
                      id: jobId,
                      blob_id: "",
                      status: "failed",
                      namespace: namespaces[index] ?? this.namespace,
                      error: "Remember job not found",
                  };
        });
        const succeeded = results.filter(
            (result) => result.status === "done"
        ).length;
        return {
            results,
            total: results.length,
            succeeded,
            failed: results.length - succeeded,
        };
    }

    async rememberBulkAndWait(
        items: RememberBulkItem[],
        opts: RememberBulkOptions = {}
    ): Promise<RememberBulkResult> {
        const accepted = await this.rememberBulkAsync(items);
        const namespaces = items.map(
            (item) => item.namespace ?? this.namespace
        );
        return this.waitForRememberJobs(accepted.job_ids, namespaces, opts);
    }

    countTokens(text: string): number {
        return estimateTokens(text);
    }

    async recall(params: RecallParams): Promise<RecallResult>;
    async recall(
        query: string,
        limitOrOptions?: number | RecallOptions,
        namespace?: string
    ): Promise<RecallResult>;
    async recall(
        queryOrParams: string | RecallParams,
        limitOrOptions: number | RecallOptions | undefined = 10,
        namespace?: string
    ): Promise<RecallResult> {
        let query: string;
        let options: RecallOptions;
        if (typeof queryOrParams === "object") {
            const { query: objectQuery, ...rest } = queryOrParams;
            query = objectQuery;
            options = rest;
        } else {
            query = queryOrParams;
            if (limitOrOptions == null) {
                options = { limit: 10, namespace };
            } else if (typeof limitOrOptions === "number") {
                options = { limit: limitOrOptions, namespace };
            } else {
                // Positional namespace fills an options object that omitted it.
                // An explicit options.namespace still wins. (#1038)
                options = { ...limitOrOptions };
                if (options.namespace === undefined && namespace !== undefined) {
                    options.namespace = namespace;
                }
            }
        }
        validateText(query, "query");
        const resolvedNamespace = options.namespace ?? this.namespace;
        const resolvedLimit = options.topK ?? options.limit ?? 10;
        if (!Number.isInteger(resolvedLimit) || resolvedLimit < 0) {
            throw new Error("limit must be a non-negative integer");
        }
        const queryTokens = tokenize(query);
        const semantic = this.memories
            .filter((memory) => memory.namespace === resolvedNamespace)
            .map((memory) => ({
                memory,
                distance: distance(queryTokens, memory.text),
            }))
            .filter((entry) =>
                options.maxDistance === undefined
                    ? true
                    : entry.distance < options.maxDistance
            )
            .sort(
                (left, right) =>
                    left.distance - right.distance ||
                    left.memory.sequence - right.memory.sequence
            );
        // `recent` reorders a bounded semantic window by write time, then
        // truncates. Relevance keeps the cosine order. (#1124)
        const ordered =
            options.sort === "recent"
                ? semantic
                      .slice(0, recentCandidateLimit(resolvedLimit))
                      .sort(
                          (left, right) =>
                              right.memory.sequence - left.memory.sequence ||
                              left.distance - right.distance,
                      )
                : semantic;
        const ranked = ordered
            .slice(0, resolvedLimit)
            .map(({ memory, distance: memoryDistance }) => ({
                blob_id: memory.blobId,
                text: memory.text,
                distance: memoryDistance,
            }));

        if (typeof options.maxTokens === "number") {
            const { results, meta } = applyTokenBudget(
                ranked,
                options.maxTokens,
                options.truncationStrategy,
                options.countTokens
            );
            return { results, total: results.length, meta };
        }

        return { results: ranked, total: ranked.length };
    }

    async analyze(
        text: string,
        namespaceOrOptions?: string | AnalyzeOptions
    ): Promise<AnalyzeResult> {
        validateText(text);
        const namespace =
            typeof namespaceOrOptions === "string"
                ? namespaceOrOptions
                : namespaceOrOptions?.namespace;
        const memory = this.store(text, namespace);
        return {
            job_ids: [memory.jobId],
            facts: [
                {
                    text,
                    id: memory.id,
                    job_id: memory.jobId,
                    blob_id: memory.blobId,
                },
            ],
            fact_count: 1,
            status: "done",
            owner: this.owner,
        };
    }

    async analyzeAndWait(
        text: string,
        namespaceOrOptions?: string | AnalyzeOptions,
        opts: RememberBulkOptions = {}
    ): Promise<AnalyzeWaitResult> {
        const analyzed = await this.analyze(text, namespaceOrOptions);
        const namespace =
            typeof namespaceOrOptions === "string"
                ? namespaceOrOptions
                : namespaceOrOptions?.namespace;
        const settled = await this.waitForRememberJobs(
            analyzed.job_ids,
            analyzed.job_ids.map(() => namespace ?? this.namespace),
            opts
        );
        return { ...settled, facts: analyzed.facts, owner: this.owner };
    }

    async embed(text: string): Promise<EmbedResult> {
        validateText(text);
        const vector = new Array<number>(16).fill(0);
        for (const token of tokenize(text)) {
            let hash = 2166136261;
            for (const char of token) {
                hash ^= char.codePointAt(0) ?? 0;
                hash = Math.imul(hash, 16777619);
            }
            vector[(hash >>> 0) % vector.length] += 1;
        }
        const magnitude = Math.hypot(...vector) || 1;
        return { vector: vector.map((value) => value / magnitude) };
    }

    async restore(namespace: string, _limit = 10): Promise<RestoreResult> {
        return {
            restored: 0,
            skipped: 0,
            failed: 0,
            total: 0,
            namespace,
            owner: this.owner,
            truncated: false,
        };
    }

    async listNamespaces(options: ListNamespacesOptions = {}): Promise<NamespacesResult> {
        // The relayer rejects limit < 1 with this message. slice(0, 0) would
        // otherwise report has_more with a null cursor, and slice(0, -1)
        // would drop the last namespace. (#1144, #1145)
        if (
            options.limit !== undefined &&
            (!Number.isInteger(options.limit) || options.limit < 1)
        ) {
            throw new Error("limit must be positive");
        }
        const grouped = new Map<string, { count: number; bytes: number; sequence: number }>();
        for (const memory of this.memories) {
            const entry = grouped.get(memory.namespace) ?? { count: 0, bytes: 0, sequence: 0 };
            entry.count += 1;
            entry.bytes += new TextEncoder().encode(memory.text).length;
            entry.sequence = Math.max(entry.sequence, memory.sequence);
            grouped.set(memory.namespace, entry);
        }

        const all = [...grouped.entries()]
            .map(([name, entry]) => ({
                id: `mock-ns-${name}`,
                name,
                memory_count: entry.count,
                storage_used: entry.bytes,
                updated_at: new Date(
                    MOCK_NAMESPACE_EPOCH_MS + entry.sequence * 1000
                ).toISOString(),
            }))
            .sort((a, b) =>
                a.updated_at === b.updated_at
                    ? a.name.localeCompare(b.name)
                    : a.updated_at.localeCompare(b.updated_at)
            );

        // Match the relayer's URL_SAFE_NO_PAD JSON cursor and snapshot walk.
        const cursor: { updated_at: string; namespace: string; snapshot_at?: string | null } | null =
            options.cursor === undefined ? null : JSON.parse(new TextDecoder().decode(
                Uint8Array.from(
                    atob(options.cursor.replace(/-/g, "+").replace(/_/g, "/")),
                    (char) => char.charCodeAt(0),
                ),
            ));
        const snapshotAt = cursor?.snapshot_at ?? new Date(
            MOCK_NAMESPACE_EPOCH_MS + this.sequence * 1000,
        ).toISOString();
        const remaining = all.filter((ns) =>
            Date.parse(ns.updated_at) <= Date.parse(snapshotAt) &&
            (!cursor || Date.parse(ns.updated_at) > Date.parse(cursor.updated_at) ||
                (Date.parse(ns.updated_at) === Date.parse(cursor.updated_at) &&
                    ns.name > cursor.namespace))
        );
        const page = remaining.slice(0, options.limit ?? remaining.length);
        const hasMore = remaining.length > page.length;
        const last = page.at(-1);
        const watermark = last ? { updated_at: last.updated_at, namespace: last.name } : cursor;
        const nextCursor = watermark ? btoa(Array.from(new TextEncoder().encode(JSON.stringify({
            updated_at: watermark.updated_at,
            namespace: watermark.namespace,
            snapshot_at: hasMore ? snapshotAt : null,
        })), (byte) => String.fromCharCode(byte)).join(""))
            .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "") : null;

        return {
            namespaces: page,
            next_cursor: nextCursor,
            has_more: hasMore,
            // Matches the live relayer's current wire-format version.
            snapshot_version: 2,
        };
    }

    async health(): Promise<HealthResult> {
        return { status: "ok", version: "memwal-mock", ...MOCK_VERSION };
    }

    async compatibility(): Promise<RelayerVersionMetadata> {
        return structuredClone(MOCK_VERSION);
    }

    /** Delete one mock record by blob id. Returns whether a record was removed. */
    forget(blobId: string): boolean {
        const index = this.memories.findIndex(
            (memory) => memory.blobId === blobId
        );
        if (index < 0) return false;
        const [memory] = this.memories.splice(index, 1);
        this.jobs.delete(memory.jobId);
        this.releaseIdempotency(memory.jobId);
        return true;
    }

    /** Clear one namespace, or every mock record when omitted. */
    clear(namespace?: string): number {
        const removed = this.memories.filter(
            (memory) =>
                namespace === undefined || memory.namespace === namespace
        );
        if (namespace === undefined) {
            this.memories.length = 0;
        } else {
            for (let index = this.memories.length - 1; index >= 0; index -= 1) {
                if (this.memories[index].namespace === namespace)
                    this.memories.splice(index, 1);
            }
        }
        for (const memory of removed) {
            this.jobs.delete(memory.jobId);
            this.releaseIdempotency(memory.jobId);
        }
        return removed.length;
    }

    private store(
        text: string,
        namespace?: string,
        blobId?: string,
        idempotencyKey?: string,
    ): MockMemory {
        validateText(text);
        validateIdempotencyKey(idempotencyKey);
        const resolvedNamespace = namespace ?? this.namespace;
        if (!resolvedNamespace) throw new Error("namespace cannot be empty");
        if (idempotencyKey !== undefined) {
            const existingId = this.idempotency.get(idempotencyKey);
            const existing = existingId ? this.jobs.get(existingId) : undefined;
            if (existing) {
                if (existing.text !== text || existing.namespace !== resolvedNamespace) {
                    throw new Error(
                        "idempotency_key was already used for a request with different content",
                    );
                }
                return existing;
            }
            if (existingId) this.idempotency.delete(idempotencyKey);
        }
        this.sequence += 1;
        const suffix = this.sequence.toString().padStart(6, "0");
        const memory: MockMemory = {
            id: `mock-job-${suffix}`,
            jobId: `mock-job-${suffix}`,
            blobId: blobId ?? `mock-blob-${suffix}`,
            text,
            namespace: resolvedNamespace,
            sequence: this.sequence,
        };
        this.memories.push(memory);
        this.jobs.set(memory.jobId, memory);
        if (idempotencyKey !== undefined) this.idempotency.set(idempotencyKey, memory.jobId);
        return memory;
    }

    private releaseIdempotency(jobId: string): void {
        for (const [key, id] of this.idempotency) {
            if (id === jobId) this.idempotency.delete(key);
        }
    }

    private toRememberResult(memory: MockMemory): RememberResult {
        return {
            id: memory.id,
            job_id: memory.jobId,
            blob_id: memory.blobId,
            owner: this.owner,
            namespace: memory.namespace,
        };
    }
}
