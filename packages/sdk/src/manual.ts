/**
 * Walrus Memory — Manual Client (Full Client-Side)
 *
 * User-side flow where the SDK handles everything locally:
 * - SEAL encrypt/decrypt via @mysten/seal (user's own Sui wallet)
 * - Walrus upload/download via @mysten/walrus
 * - Embedding via OpenAI-compatible API (user's own key)
 * - Vector registration via Walrus Memory server (Ed25519 signed)
 *
 * @example
 * ```typescript
 * import { MemWalManual } from "@mysten-incubation/memwal"
 *
 * const memwal = MemWalManual.create({
 *     key: process.env.MEMWAL_DELEGATE_KEY!,      // Ed25519 delegate key
 *     suiPrivateKey: process.env.SUI_PRIVATE_KEY!, // suiprivkey1... for SEAL + Walrus
 *     embeddingApiKey: process.env.OPENAI_API_KEY!,
 *     packageId: "0x...",
 *     accountId: "0x...",
 *     registryId: "0x...",
 * })
 *
 * // Remember — all client-side: embed → SEAL encrypt → Walrus upload → register
 * await memwal.rememberManual("I'm allergic to peanuts")
 *
 * // Recall — all client-side: embed → search → download → SEAL decrypt
 * const result = await memwal.recallManual("food allergies")
 * ```
 */

import type {
    MemWalManualConfig,
    WalletSigner,
    RememberManualResult,
    RecallManualResult,
    RecallManualMemory,
    MemWalManualRecallOptions,
    RestoreResult,
    SealServerConfig,
    RelayerVersionMetadata,
} from "./types.js";
import {
    sha256hex,
    hexToBytes,
    bytesToHex,
    normalizePrivateKey,
    u64ToLeHex,
    normalizeServerUrl,
    sanitizeServerError,
    clockDriftErrorFromResponse,
    scoringWeightsToWire,
} from "./utils.js";
import { assertCompatibleRelayer, compatibilityErrorFromStatus } from "./compatibility.js";

// ============================================================
// Constants
// ============================================================

type ResolvedSealServerConfig = Omit<SealServerConfig, "weight"> & {
    weight: number;
};

// Default SEAL server configs per network.
// Keep testnet on the legacy independent servers so Manual mode can decrypt
// data written by the hosted testnet relayer. Committee aggregators remain
// supported through explicit sealServerConfigs.
const DEFAULT_SEAL_SERVER_CONFIGS: Record<string, ResolvedSealServerConfig[]> = {
    mainnet: [
        {
            objectId: "0x145540d931f182fef76467dd8074c9839aea126852d90d18e1556fcbbd1208b6", // Overclock (Open)
            weight: 1,
        },
        {
            objectId: "0xe0eb52eba9261b96e895bbb4deca10dcd64fbc626a1133017adcd5131353fd10", // Studio Mirai (Open)
            weight: 1,
        },
    ],
    testnet: [
        {
            objectId: "0x73d05d62c18d9374e3ea529e8e0ed6161da1a141a94d3f76ae3fe4e99356db75",
            weight: 1,
        },
        {
            objectId: "0xf5d14a81a982144ae441cd7d64b09027f116a468bd36e7eca494f750591623c8",
            weight: 1,
        },
    ],
};

function normalizeSealServerConfigs(configs: SealServerConfig[]): ResolvedSealServerConfig[] {
    return configs.map((config, index) => {
        const objectId = config.objectId?.trim();
        if (!objectId) {
            throw new Error(`MemWalManual: sealServerConfigs[${index}].objectId is required`);
        }

        const weight = config.weight ?? 1;
        if (!Number.isInteger(weight) || weight < 1) {
            throw new Error(`MemWalManual: sealServerConfigs[${index}].weight must be a positive integer`);
        }

        const aggregatorUrl = config.aggregatorUrl?.trim();
        const apiKeyName = config.apiKeyName?.trim();
        const apiKey = config.apiKey?.trim();
        if ((apiKeyName && !apiKey) || (!apiKeyName && apiKey)) {
            throw new Error(
                `MemWalManual: sealServerConfigs[${index}] must provide both apiKeyName and apiKey, or neither`
            );
        }

        return {
            objectId,
            weight,
            ...(aggregatorUrl ? { aggregatorUrl } : {}),
            ...(apiKeyName && apiKey ? { apiKeyName, apiKey } : {}),
        };
    });
}

function resolveSealServerConfigs(config: MemWalManualConfig, network: string): ResolvedSealServerConfig[] {
    if (config.sealServerConfigs !== undefined) {
        return normalizeSealServerConfigs(config.sealServerConfigs);
    }

    if (config.sealKeyServers !== undefined) {
        return normalizeSealServerConfigs(config.sealKeyServers.map((objectId) => ({ objectId })));
    }

    return normalizeSealServerConfigs(DEFAULT_SEAL_SERVER_CONFIGS[network] ?? []);
}

function sealServerConfigTotalWeight(configs: ResolvedSealServerConfig[]): number {
    return configs.reduce((sum, config) => sum + config.weight, 0);
}

/** Encode arbitrary-size bytes without passing the whole payload as function arguments. */
function bytesToBase64(bytes: Uint8Array): string {
    const chunkSize = 0x8000;
    const chunks: string[] = [];
    for (let offset = 0; offset < bytes.length; offset += chunkSize) {
        chunks.push(String.fromCharCode(...bytes.subarray(offset, offset + chunkSize)));
    }
    return btoa(chunks.join(""));
}

// ============================================================
// MemWalManual Client
// ============================================================

export class MemWalManual {
    private delegatePrivateKey: Uint8Array;
    private delegatePublicKey: Uint8Array | null = null;
    private serverUrl: string;
    private config: MemWalManualConfig;
    private walletSigner: WalletSigner | null;
    private namespace: string;
    private relayerVersionMetadata: RelayerVersionMetadata | null = null;
    private compatibilityPromise: Promise<RelayerVersionMetadata> | null = null;

    // Lazily initialized heavy clients (typed as any to avoid peer dep compile errors)
    private _suiClient: any = null;
    private _sealClient: any = null;
    private _walrusClient: any = null;
    private _keypair: any = null;

    private constructor(config: MemWalManualConfig) {
        if (!config.suiPrivateKey && !config.walletSigner) {
            throw new Error("MemWalManual: provide either suiPrivateKey or walletSigner");
        }
        if (config.suiPrivateKey && config.walletSigner) {
            throw new Error("MemWalManual: provide suiPrivateKey OR walletSigner, not both");
        }
        this.delegatePrivateKey =
            typeof config.key === "string"
                ? hexToBytes(normalizePrivateKey(config.key))
                : config.key;
        // LOW-22: default to HTTPS; warn (do not throw) on plaintext HTTP
        // against non-localhost hosts.
        this.serverUrl = normalizeServerUrl(config.serverUrl ?? "https://relayer.memory.walrus.xyz");
        this.walletSigner = config.walletSigner ?? null;
        this.config = config;
        this.namespace = config.namespace ?? "default";
    }

    /**
     * Create a new MemWalManual client.
     *
     * Requires peer dependencies: @mysten/sui, @mysten/seal, @mysten/walrus
     *
     * @param config.key - Ed25519 delegate private key (hex) for server auth
     * @param config.suiPrivateKey - Sui private key (bech32) for SEAL + Walrus (OR walletSigner)
     * @param config.walletSigner - Connected wallet signer from dapp-kit (OR suiPrivateKey)
     * @param config.embeddingApiKey - OpenAI/OpenRouter API key for embeddings
     * @param config.packageId - Immutable first-published package ID used by SEAL
     * @param config.sealPolicyPackageId - Current seal_approve package after an upgrade
     * @param config.registryId - AccountRegistry shared object ID (for SEAL seal_approve)
     * @param config.accountId - Walrus Memory account object ID (for SEAL seal_approve)
     */
    static create(config: MemWalManualConfig): MemWalManual {
        return new MemWalManual(config);
    }

    /**
     * Securely wipe the delegate private and public keys from memory.
     * Prevents key extraction from V8 heap dumps.
     */
    destroy(): void {
        if (this.delegatePrivateKey) {
            this.delegatePrivateKey.fill(0);
        }
        if (this.delegatePublicKey) {
            this.delegatePublicKey.fill(0);
        }
        this.relayerVersionMetadata = null;
        this.compatibilityPromise = null;
    }

    /**
     * Fetch and validate the relayer compatibility contract.
     */
    async compatibility(): Promise<RelayerVersionMetadata> {
        return this.ensureCompatibleRelayer();
    }

    /** Whether this client uses a connected wallet signer (vs raw keypair) */
    get isWalletMode(): boolean {
        return this.walletSigner !== null;
    }

    // ============================================================
    // Lazy Client Initialization
    // All @mysten/* imports are dynamic to avoid requiring peer deps at
    // compile time. Users who only use the server-mode MemWal class
    // don't need these packages installed.
    // ============================================================

    private async getSuiClient() {
        if (!this._suiClient) {
            // Prefer externally-provided client (e.g. from dapp-kit's useSuiClient())
            if (this.config.suiClient) {
                this._suiClient = this.config.suiClient;
            } else {
                // Fallback: create client via dynamic import
                // @ts-ignore — optional peer dependency
                const mod = await import("@mysten/sui/client");
                const SuiClient = (mod as any).SuiClient;
                if (typeof SuiClient !== "function") {
                    throw new Error(
                        "SuiClient not found in @mysten/sui/client. " +
                            "For @mysten/sui v2.6.0+, pass suiClient in config " +
                            "(e.g. from dapp-kit's useSuiClient())"
                    );
                }
                const network = this.config.suiNetwork ?? "mainnet";
                const urls: Record<string, string> = {
                    testnet: "https://fullnode.testnet.sui.io:443",
                    mainnet: "https://fullnode.mainnet.sui.io:443",
                };
                this._suiClient = new SuiClient({
                    url: urls[network] ?? urls.mainnet,
                });
            }
        }
        return this._suiClient;
    }

    private async getKeypair() {
        if (this.walletSigner) {
            throw new Error("getKeypair() not available in wallet signer mode");
        }
        if (!this._keypair) {
            const { decodeSuiPrivateKey } = await import("@mysten/sui/cryptography");
            const { Ed25519Keypair } = await import("@mysten/sui/keypairs/ed25519");
            const { secretKey } = decodeSuiPrivateKey(this.config.suiPrivateKey!);
            this._keypair = Ed25519Keypair.fromSecretKey(secretKey);
        }
        return this._keypair;
    }

    /** Get the transaction signer address from the wallet or configured keypair. */
    private async getSignerAddress(): Promise<string> {
        if (this.walletSigner) {
            return this.walletSigner.address;
        }
        const keypair = await this.getKeypair();
        return keypair.getPublicKey().toSuiAddress();
    }

    private async getSealClient() {
        if (!this._sealClient) {
            // @ts-ignore — optional peer dependency
            const { SealClient } = await import("@mysten/seal");
            const suiClient = await this.getSuiClient();
            const network = this.config.suiNetwork ?? "mainnet";
            const serverConfigs = resolveSealServerConfigs(this.config, network);
            if (serverConfigs.length === 0) {
                throw new Error(
                    `MemWalManual: no SEAL key servers configured for network "${network}". ` +
                        "Please provide sealServerConfigs or sealKeyServers in config."
                );
            }
            this._sealClient = new SealClient({
                suiClient,
                serverConfigs,
                verifyKeyServers: true,
            });
        }
        return this._sealClient;
    }

    /** MED-10: SEAL threshold — defaults to 2, capped to configured server weight. */
    private get sealThreshold(): number {
        if (this.config.sealThreshold !== undefined) {
            return this.config.sealThreshold;
        }
        const network = this.config.suiNetwork ?? "mainnet";
        const totalWeight = sealServerConfigTotalWeight(resolveSealServerConfigs(this.config, network));
        return totalWeight > 0 ? Math.min(2, totalWeight) : 2;
    }

    private async getWalrusClient() {
        if (!this._walrusClient) {
            // @ts-ignore — optional peer dependency
            const { WalrusClient } = await import("@mysten/walrus");
            const suiClient = await this.getSuiClient();
            const network = this.config.suiNetwork ?? "mainnet";
            const uploadRelayHost =
                network === "testnet"
                    ? "https://upload-relay.testnet.walrus.space"
                    : "https://upload-relay.mainnet.walrus.space";
            this._walrusClient = new WalrusClient({
                network: network as any,
                suiClient,
                uploadRelay: {
                    host: uploadRelayHost,
                    sendTip: { max: 10_000_000 },
                },
            });
        }
        return this._walrusClient;
    }

    // ============================================================
    // Core Manual API
    // ============================================================

    /**
     * Remember (hybrid flow):
     * 1. Embed text (OpenAI/OpenRouter)
     * 2. SEAL encrypt locally (no wallet signature needed)
     * 3. Send {encrypted_data, vector} to server — server handles Walrus upload relay
     */
    async rememberManual(text: string, namespace?: string): Promise<RememberManualResult> {
        if (!text) throw new Error("Text cannot be empty");

        const ns = namespace ?? this.namespace;

        // Step 1 & 2: Embed + SEAL encrypt concurrently. Namespace produces a
        // distinct SEAL identity, but delegates remain authorized account-wide.
        const [vector, encrypted] = await Promise.all([
            this.embed(text),
            this.sealEncrypt(new TextEncoder().encode(text), ns),
        ]);

        // Step 3: Send encrypted bytes (base64) + vector to server.
        // Server will upload to Walrus via upload-relay and return the blob_id.
        const encryptedBase64 = bytesToBase64(encrypted);
        return this.signedRequest<RememberManualResult>("POST", "/api/remember/manual", {
            encrypted_data: encryptedBase64,
            vector,
            namespace: ns,
        });
    }

    /**
     * Recall (manual/full client-side):
     * 1. Embed query (OpenAI)
     * 2. Search server for matching vectors
     * 3. Download blobs from Walrus
     * 4. SEAL decrypt each blob
     */
    async recallManual(query: string, limit?: number, namespace?: string): Promise<RecallManualResult>;
    async recallManual(query: string, options?: MemWalManualRecallOptions): Promise<RecallManualResult>;
    async recallManual(
        query: string,
        limitOrOptions: number | MemWalManualRecallOptions = 10,
        namespace?: string
    ): Promise<RecallManualResult> {
        if (!query) throw new Error("Query cannot be empty");

        const options = typeof limitOrOptions === "number" ? { limit: limitOrOptions, namespace } : limitOrOptions;
        const limit = options.limit ?? 10;
        const ns = options.namespace ?? this.namespace;

        // Step 1: Embed query
        const vector = await this.embed(query);

        // Step 2: Search server
        const searchResult = await this.signedRequest<{
            results: { blob_id: string; distance: number }[];
            total: number;
        }>("POST", "/api/recall/manual", {
            vector,
            limit,
            namespace: ns,
            scoring_weights: scoringWeightsToWire(options.scoringWeights),
        });

        if (searchResult.results.length === 0) {
            return { results: [], total: 0 };
        }

        // Step 3: Download all encrypted blobs from Walrus concurrently
        const downloadTasks = searchResult.results.map(async (hit) => {
            try {
                const data = await this.walrusDownload(hit.blob_id);
                return { blob_id: hit.blob_id, data, distance: hit.distance };
            } catch (err) {
                console.error(`[MemWalManual] Walrus download failed for ${hit.blob_id}:`, err);
                return null;
            }
        });
        const downloadedBlobs = (await Promise.all(downloadTasks)).filter(
            (d): d is { blob_id: string; data: Uint8Array; distance: number } => d !== null
        );

        if (downloadedBlobs.length === 0) {
            return { results: [], total: 0 };
        }

        // Step 4: Create ONE SEAL SessionKey (one wallet popup), then decrypt all blobs
        let sealClient: any;
        let suiClient: any;
        let SessionKey: any;
        let EncryptedObject: any;
        let Transaction: any;
        let normalizeSuiAddress: (address: string) => string;
        let sessionKey: any;
        try {
            sealClient = await this.getSealClient();
            suiClient = await this.getSuiClient();
            // @ts-ignore — optional peer dependency
            ({ SessionKey, EncryptedObject } = await import("@mysten/seal"));
            ({ Transaction } = await import("@mysten/sui/transactions"));
            ({ normalizeSuiAddress } = await import("@mysten/sui/utils"));
        } catch (err) {
            console.error("[MemWalManual] Failed to initialize SEAL/SUI clients:", err);
            return { results: [], total: 0 };
        }

        const immutablePackageId = normalizeSuiAddress(this.config.packageId);
        const parsedBlobs: ({ parsed: any } & (typeof downloadedBlobs)[number])[] = [];
        for (const blob of downloadedBlobs) {
            let parsed: any;
            try {
                parsed = EncryptedObject.parse(blob.data);
            } catch (err) {
                console.error(`[MemWalManual] SEAL decrypt failed for ${blob.blob_id}:`, err);
                continue;
            }
            if (normalizeSuiAddress(parsed.packageId) !== immutablePackageId) {
                console.error(
                    `[MemWalManual] Skipping ciphertext ${blob.blob_id}: packageId does not match ` +
                        "the configured immutable packageId"
                );
                continue;
            }
            parsedBlobs.push({ ...blob, parsed });
        }
        if (parsedBlobs.length === 0) {
            return { results: [], total: 0 };
        }

        const callerAddress = await this.getSignerAddress();

        // Create signer (wallet adapter or keypair)
        const signer = await this.createSigner(callerAddress);

        // Create session key ONCE (triggers one wallet popup)
        // HIGH-7 / LOW-13: Reduced from 30 to 5 minutes to limit the exposure
        // window if a session token is compromised.
        try {
            sessionKey = await SessionKey.create({
                address: callerAddress,
                packageId: this.config.packageId,
                ttlMin: 5,
                signer,
                suiClient,
            });
        } catch (err) {
            console.error("[MemWalManual] SessionKey.create failed:", err);
            return { results: [], total: 0 };
        }

        // Decrypt each blob sequentially using the shared session key
        const results: RecallManualMemory[] = [];
        for (const blob of parsedBlobs) {
            try {
                const fullId = blob.parsed.id;

                // Build seal_approve PTB. hexToBytes rejects empty, odd-length,
                // and non-hex ids instead of coercing NaN to 0.
                const idBytes = Array.from(hexToBytes(fullId));
                const tx = new Transaction();
                tx.moveCall({
                    target: `${this.config.sealPolicyPackageId ?? this.config.packageId}::account::seal_approve`,
                    arguments: [
                        tx.pure("vector<u8>", idBytes),
                        tx.object(this.config.registryId),
                        tx.object(this.config.accountId),
                    ],
                });
                const txBytes = await tx.build({
                    client: suiClient,
                    onlyTransactionKind: true,
                });

                // Fetch decryption keys using shared session key
                await sealClient.fetchKeys({
                    ids: [fullId],
                    txBytes,
                    sessionKey,
                    threshold: this.sealThreshold,
                });

                // Decrypt locally
                const plaintext = await sealClient.decrypt({
                    data: blob.data,
                    sessionKey,
                    txBytes,
                });
                const text = new TextDecoder().decode(plaintext);
                results.push({ blob_id: blob.blob_id, text, distance: blob.distance });
            } catch (err) {
                console.error(`[MemWalManual] SEAL decrypt failed for ${blob.blob_id}:`, err);
            }
        }

        return { results, total: results.length };
    }

    // ============================================================
    // Internal: Signer Factory
    // ============================================================

    /** Create a signer adapter — either from wallet or keypair */
    private async createSigner(callerAddress: string): Promise<any> {
        if (this.walletSigner) {
            const ws = this.walletSigner;
            return {
                toSuiAddress: () => callerAddress,
                getPublicKey: () => ({ toSuiAddress: () => callerAddress }),
                sign: async (data: Uint8Array) => {
                    const result = await ws.signPersonalMessage({ message: data });
                    return { signature: result.signature };
                },
                signPersonalMessage: async (data: Uint8Array) => {
                    const result = await ws.signPersonalMessage({ message: data });
                    return { signature: result.signature };
                },
            };
        }
        return this.getKeypair();
    }

    // ============================================================
    // Internal: Embedding
    // ============================================================

    private async embed(text: string): Promise<number[]> {
        if (!this.config.embeddingApiKey) {
            throw new Error(
                "MemWalManual: embeddingApiKey is required. " + "Provide your OpenAI or OpenRouter API key in config."
            );
        }

        const apiBase = (this.config.embeddingApiBase ?? "https://api.openai.com/v1").replace(/\/$/, "");
        const isOpenRouter = apiBase.includes("openrouter.ai");
        const defaultModel = isOpenRouter ? "openai/text-embedding-3-small" : "text-embedding-3-small";
        const model = this.config.embeddingModel ?? defaultModel;

        const resp = await fetch(`${apiBase}/embeddings`, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                Authorization: `Bearer ${this.config.embeddingApiKey}`,
            },
            body: JSON.stringify({ model, input: text }),
        });

        if (!resp.ok) {
            const errText = await resp.text();
            throw new Error(`Embedding API error (${resp.status}): ${errText}`);
        }

        const data = (await resp.json()) as { data: { embedding: number[] }[] };
        if (!data.data?.[0]?.embedding) {
            throw new Error("Embedding API returned no data");
        }
        return data.data[0].embedding;
    }

    // ============================================================
    // Internal: SEAL Encrypt
    // ============================================================

    /**
     * SEAL-encrypt a payload.
     *
     * Namespace scoping: the `id` passed to SEAL includes the namespace, so
     * namespaces receive distinct keys. `seal_approve` authorizes delegates at
     * account scope, however, so this does not isolate delegates from each
     * other's namespaces.
     *
     * ENG-1725 fix: The on-chain `seal_approve` matches the tail of the id
     * against `bcs::to_bytes(account.owner)` for every caller — owner and
     * delegate alike. The id MUST therefore carry the owner's 32 raw address
     * bytes at that position (in hex form on the SEAL side, raw on the Move
     * side). The previous LOW-24 layout — `hex(accountId) || hex(namespace)`
     * — used the MemWalAccount object id (not the owner address) and put the
     * namespace last, so the match always failed and owners could no longer
     * recall their own manually-remembered data.
     *
     * Rotation: SEAL hands out one reusable secret key per identity, so an id
     * fixed at `owner` would let any delegate that ever fetched the key keep
     * decrypting new memories forever — removal on chain would not touch the
     * copy in their hands. Tailing the id with the account's
     * `access_counter_version` means a revocation bumps the counter, which
     * changes the identity, which yields a key they cannot fetch.
     *
     * Layout:
     *   id = hex(utf8(namespace)) || hex(ownerAddress[2:]) || hex(u64le(counter))
     *
     * - namespace is the prefix, so different namespaces use different SEAL
     *   keys. It is an organization boundary, not an authorization boundary:
     *   every account delegate may request every namespace key.
     * - owner address (32 bytes) then counter (8 bytes) are the tail →
     *   `seal_approve` parses the counter off the end and rebuilds the
     *   expected `owner ‖ counter` suffix to compare.
     *
     * NOTE: Ciphertext written between the original LOW-24 fix and the
     * ENG-1725 fix (id = accountHex + nsHex) is unrecoverable by the owner
     * caller. There is no production data in that window per the team.
     */
    private async sealEncrypt(plaintext: Uint8Array, namespace: string): Promise<Uint8Array> {
        const sealClient = await this.getSealClient();

        // Build a namespace-scoped SEAL id tailing with the owner's address
        // bytes then the rotation counter, so the on-chain `seal_approve`
        // suffix check passes. Hex-encoded throughout so the id is a stable
        // ASCII hex string.
        const { ownerHex, counter } = await this.fetchSealIdentity();
        const nsHex = bytesToHex(new TextEncoder().encode(namespace));
        const scopedId = `${nsHex}${ownerHex}${u64ToLeHex(counter)}`;

        const result = await sealClient.encrypt({
            threshold: this.sealThreshold,
            packageId: this.config.packageId,
            id: scopedId,
            data: plaintext,
        });

        return new Uint8Array(result.encryptedObject);
    }

    /**
     * Read the account owner and SEAL rotation counter fresh from chain.
     *
     * Deliberately not cached, and it must stay that way: the counter's only
     * job is to stop a just-removed delegate from reading what comes next, and
     * a cached value would encrypt the next memory under the identity that
     * delegate already holds a key for. One read per encrypt is the price of
     * the property. Recall does not need this — `EncryptedObject.parse` gives
     * back the id the blob was written under.
     */
    private async fetchSealIdentity(): Promise<{
        ownerHex: string;
        counter: bigint;
    }> {
        const suiClient = await this.getSuiClient();
        // getSuiClient() can hand back either client generation, and they
        // disagree on both the request and the response: the v2 gRPC/JSON-RPC
        // clients take { objectId, include } and answer { object: { json } },
        // while the legacy client takes { id, options } and answers
        // { data: { content: { fields } } }. Send both key sets — each client
        // ignores the one it does not know — and read whichever came back.
        const res: any = await suiClient.getObject({
            objectId: this.config.accountId,
            id: this.config.accountId,
            include: { json: true },
            options: { showContent: true },
        });
        const fields = res?.object?.json ?? res?.data?.content?.fields;
        const objectType = res?.object?.type ?? res?.data?.type ?? res?.data?.content?.type;
        const typeParts = typeof objectType === "string" ? objectType.split("::") : [];
        const typePackageHex = typeParts[0]?.replace(/^0x/i, "") ?? "";
        const configuredPackageHex = this.config.packageId.replace(/^0x/i, "");
        const packageMatches =
            /^[0-9a-fA-F]{1,64}$/.test(typePackageHex) &&
            /^[0-9a-fA-F]{1,64}$/.test(configuredPackageHex) &&
            typePackageHex.padStart(64, "0").toLowerCase() === configuredPackageHex.padStart(64, "0").toLowerCase();
        if (!packageMatches || typeParts[1] !== "account" || typeParts[2] !== "MemWalAccount") {
            throw new Error(
                `MemWalManual: object ${this.config.accountId} is not a ` +
                    `${this.config.packageId}::account::MemWalAccount.`
            );
        }
        if (fields?.active !== true) {
            throw new Error(`MemWalManual: account ${this.config.accountId} is not active; refusing to encrypt.`);
        }
        const owner = fields?.owner;
        if (typeof owner !== "string") {
            throw new Error(
                `MemWalManual: account ${this.config.accountId} has no owner field. ` +
                    "packageId/accountId may point at different contracts."
            );
        }
        const ownerHex = owner.replace(/^0x/i, "");
        if (!/^[0-9a-fA-F]{1,64}$/.test(ownerHex)) {
            throw new Error(`MemWalManual: account ${this.config.accountId} has an invalid owner field.`);
        }

        const rawCounter = fields?.access_counter_version;
        if (rawCounter === undefined || rawCounter === null) {
            throw new Error(
                `MemWalManual: account ${this.config.accountId} has no access_counter_version field. ` +
                    "This account predates SEAL identity rotation, or packageId/accountId point at different contracts."
            );
        }
        return {
            ownerHex: ownerHex.padStart(64, "0").toLowerCase(),
            counter: BigInt(rawCounter),
        };
    }

    // ============================================================
    // Internal: Walrus Upload/Download
    // ============================================================

    private async walrusUpload(data: Uint8Array): Promise<string> {
        // Direct HTTP PUT to Walrus publisher (works in both browser and Node.js,
        // unlike @mysten/walrus SDK which uses WASM and requires Node.js)
        const network = this.config.suiNetwork ?? "mainnet";
        const defaultPublisher =
            network === "testnet"
                ? "https://publisher.walrus-testnet.walrus.space"
                : "https://publisher.walrus-mainnet.walrus.space";
        const publisherUrl = this.config.walrusPublisherUrl ?? defaultPublisher;
        const epochs = this.config.walrusEpochs ?? 50;

        const resp = await fetch(`${publisherUrl}/v1/blobs?epochs=${epochs}&deletable=true`, {
            method: "PUT",
            headers: { "Content-Type": "application/octet-stream" },
            body: data as unknown as BodyInit,
        });

        if (!resp.ok) {
            const errText = await resp.text();
            throw new Error(`Walrus upload failed (${resp.status}): ${errText}`);
        }

        const result = (await resp.json()) as any;
        // Response can be { newlyCreated: { blobObject: { blobId } } }
        // or { alreadyCertified: { blobId } }
        const blobId = result.newlyCreated?.blobObject?.blobId ?? result.alreadyCertified?.blobId;

        if (!blobId) {
            throw new Error(`Walrus upload: unexpected response: ${JSON.stringify(result)}`);
        }
        return blobId;
    }

    private async walrusDownload(blobId: string): Promise<Uint8Array> {
        // Direct HTTP fetch to Walrus aggregator (works in both browser and Node.js,
        // unlike @mysten/walrus SDK which requires Node.js APIs)
        const network = this.config.suiNetwork ?? "mainnet";
        const defaultAggregator =
            network === "testnet"
                ? "https://aggregator.walrus-testnet.walrus.space"
                : "https://aggregator.walrus-mainnet.walrus.space";
        const aggregatorUrl = this.config.walrusAggregatorUrl ?? defaultAggregator;
        const resp = await fetch(`${aggregatorUrl}/v1/blobs/${blobId}`);
        if (!resp.ok) {
            throw new Error(`Walrus download failed (${resp.status}): ${await resp.text()}`);
        }
        const buffer = await resp.arrayBuffer();
        return new Uint8Array(buffer);
    }

    // ============================================================
    // Internal: Signed HTTP Requests (same pattern as MemWal class)
    // ============================================================

    private async getDelegatePublicKey(): Promise<Uint8Array> {
        if (!this.delegatePublicKey) {
            const ed = await import("@noble/ed25519");
            this.delegatePublicKey = await ed.getPublicKeyAsync(this.delegatePrivateKey);
        }
        return this.delegatePublicKey;
    }

    private async ensureCompatibleRelayer(): Promise<RelayerVersionMetadata> {
        if (this.relayerVersionMetadata) return this.relayerVersionMetadata;
        if (this.compatibilityPromise) return this.compatibilityPromise;

        this.compatibilityPromise = this.fetchCompatibilityMetadata().finally(() => {
            this.compatibilityPromise = null;
        });
        return this.compatibilityPromise;
    }

    private async fetchCompatibilityMetadata(): Promise<RelayerVersionMetadata> {
        const versionRes = await fetch(`${this.serverUrl}/version`, {
            method: "GET",
        });
        let body: Partial<RelayerVersionMetadata>;

        if (versionRes.ok) {
            body = (await versionRes.json()) as Partial<RelayerVersionMetadata>;
        } else if (versionRes.status === 404 || versionRes.status === 405) {
            const healthRes = await fetch(`${this.serverUrl}/health`, {
                method: "GET",
            });
            if (!healthRes.ok) {
                throw new Error(
                    `Walrus Memory compatibility check failed: GET /version returned ` +
                        `${versionRes.status}, and GET /health returned ${healthRes.status}`
                );
            }
            body = (await healthRes.json()) as Partial<RelayerVersionMetadata>;
        } else {
            throw new Error(`Walrus Memory compatibility check failed: GET /version returned ${versionRes.status}`);
        }

        assertCompatibleRelayer(body, this.serverUrl);
        this.relayerVersionMetadata = body;
        return body;
    }

    /**
     * Make a signed request to the server.
     *
     * Signature format (LOW-1 + MED-1 + LOW-23):
     *   "{timestamp}.{method}.{path_and_query}.{body_sha256}.{nonce}.{account_id}"
     *
     * Headers sent: x-public-key, x-signature, x-timestamp, x-nonce, x-account-id.
     */
    private async signedRequest<T>(method: string, path: string, body: object): Promise<T> {
        await this.ensureCompatibleRelayer();
        const ed = await import("@noble/ed25519");

        const timestamp = Math.floor(Date.now() / 1000).toString();
        const bodyStr = JSON.stringify(body);
        const bodySha256 = await sha256hex(bodyStr);

        // MED-1: per-request nonce for replay protection.
        const nonce = crypto.randomUUID();

        // LOW-23: include x-account-id in the canonical signed message so an
        // intermediary cannot rebind a signed request to a different account.
        const message = `${timestamp}.${method}.${path}.${bodySha256}.${nonce}.${this.config.accountId}`;
        const msgBytes = new TextEncoder().encode(message);

        const signature = await ed.signAsync(msgBytes, this.delegatePrivateKey);
        const publicKey = await this.getDelegatePublicKey();

        const url = `${this.serverUrl}${path}`;
        const res = await fetch(url, {
            method,
            headers: {
                "Content-Type": "application/json",
                "x-public-key": bytesToHex(publicKey),
                "x-signature": bytesToHex(signature),
                "x-timestamp": timestamp,
                "x-nonce": nonce,
                "x-account-id": this.config.accountId,
            },
            body: bodyStr,
        });

        if (!res.ok) {
            // LOW-26: sanitize server error bodies before re-throwing.
            const raw = await res.text();
            const compatibilityError = compatibilityErrorFromStatus(res.status, raw);
            if (compatibilityError) throw compatibilityError;

            // Surface a stale-timestamp rejection (401 + x-auth-error) as an
            // actionable clock-drift error rather than an opaque server error.
            const clockDriftError = clockDriftErrorFromResponse(res);
            if (clockDriftError) throw clockDriftError;

            const { message: sanitized, serverCode } = sanitizeServerError(res.status, raw);
            const err = new Error(sanitized) as Error & {
                status?: number;
                serverCode?: string;
                cause?: string;
            };
            err.status = res.status;
            if (serverCode) err.serverCode = serverCode;
            err.cause = raw;
            throw err;
        }

        return res.json() as Promise<T>;
    }

    // ============================================================
    // Restore
    // ============================================================

    /**
     * Restore a namespace — server downloads all blobs from Walrus,
     * decrypts with delegate key, re-embeds, and re-indexes.
     *
     * @param namespace - Namespace to restore
     * @returns RestoreResult with count of restored entries
     */
    async restore(namespace: string, limit: number = 10): Promise<RestoreResult> {
        const result = await this.signedRequest<RestoreResult>("POST", "/api/restore", {
            namespace,
            limit,
        });
        // Relayers older than WALM-319 omit `truncated` entirely — treat
        // "not present" as "not known to be truncated" rather than drop
        // the field or require every relayer version to send it.
        return { ...result, truncated: result.truncated ?? false };
    }
}
