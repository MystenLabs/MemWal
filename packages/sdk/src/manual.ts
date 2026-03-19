/**
 * MemWal V2 — Manual Client (Full Client-Side)
 *
 * User-side flow where the SDK handles everything locally:
 * - SEAL encrypt/decrypt via @mysten/seal (user's own Sui wallet)
 * - Walrus upload/download via @mysten/walrus
 * - Embedding via OpenAI-compatible API (user's own key)
 * - Vector registration via MemWal server (Ed25519 signed)
 *
 * @example
 * ```typescript
 * import { MemWalManual } from "@cmdoss/memwal"
 *
 * const memwal = MemWalManual.create({
 *     key: process.env.MEMWAL_DELEGATE_KEY!,      // Ed25519 delegate key
 *     suiPrivateKey: process.env.SUI_PRIVATE_KEY!, // suiprivkey1... for SEAL + Walrus
 *     embeddingApiKey: process.env.OPENAI_API_KEY!,
 *     packageId: "0x...",
 *     accountId: "0x...",
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
    RestoreResult,
} from "./types.js";
import { sha256hex, hexToBytes, bytesToHex } from "./utils.js";

// ============================================================
// Constants
// ============================================================

// Default SEAL key server object IDs per network
// Users can override via SEAL_KEY_SERVERS in their environment
const DEFAULT_KEY_SERVERS: Record<string, string[]> = {
    mainnet: [
        "0x1afb3a57211ceff8f6781757821847e3ddae73f64e78ec8cd9349914ad985475", // NodeInfra (Open)
    ],
    testnet: [
        "0x73d05d62c18d9374e3ea529e8e0ed6161da1a141a94d3f76ae3fe4e99356db75",
        "0xf5d14a81a982144ae441cd7d64b09027f116a468bd36e7eca494f750591623c8",
    ],
};

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
        this.delegatePrivateKey = hexToBytes(config.key);
        this.serverUrl = (config.serverUrl ?? "http://localhost:8000").replace(/\/$/, "");
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
     * @param config.packageId - MemWal contract package ID
     * @param config.accountId - MemWalAccount object ID (for SEAL seal_approve)
     */
    static create(config: MemWalManualConfig): MemWalManual {
        return new MemWalManual(config);
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

    /** Get the owner address — from wallet signer or derived from keypair */
    private async getOwnerAddress(): Promise<string> {
        if (this.walletSigner) {
            return this.walletSigner.address;
        }
        const keypair = await this.getKeypair();
        return keypair.getPublicKey().toSuiAddress();
    }

    /** Sign and execute a transaction — via wallet popup or programmatic keypair */
    private async signAndExecuteTransaction(transaction: any): Promise<{ digest: string }> {
        if (this.walletSigner) {
            return this.walletSigner.signAndExecuteTransaction({ transaction });
        }
        const keypair = await this.getKeypair();
        const suiClient = await this.getSuiClient();
        return suiClient.signAndExecuteTransaction({
            signer: keypair,
            transaction,
        });
    }

    private async getSealClient() {
        if (!this._sealClient) {
            // @ts-ignore — optional peer dependency
            const { SealClient } = await import("@mysten/seal");
            const suiClient = await this.getSuiClient();
            const network = this.config.suiNetwork ?? "mainnet";
            const keyServers = DEFAULT_KEY_SERVERS[network] ?? [];
            if (keyServers.length === 0) {
                throw new Error(
                    `MemWalManual: no SEAL key servers configured for network "${network}". ` +
                    "Please provide sealKeyServers in config or set SEAL_KEY_SERVERS env var."
                );
            }
            this._sealClient = new SealClient({
                suiClient,
                serverConfigs: keyServers.map((id) => ({
                    objectId: id,
                    weight: 1,
                })),
                verifyKeyServers: false,
            });
        }
        return this._sealClient;
    }

    private async getWalrusClient() {
        if (!this._walrusClient) {
            // @ts-ignore — optional peer dependency
            const { WalrusClient } = await import("@mysten/walrus");
            const suiClient = await this.getSuiClient();
            const network = this.config.suiNetwork ?? "mainnet";
            const uploadRelayHost = network === "testnet"
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

        // Step 1 & 2: Embed + SEAL encrypt concurrently
        const [vector, encrypted] = await Promise.all([
            this.embed(text),
            this.sealEncrypt(new TextEncoder().encode(text)),
        ]);

        // Step 3: Send encrypted bytes (base64) + vector to server.
        // Server will upload to Walrus via upload-relay and return the blob_id.
        const encryptedBase64 = btoa(String.fromCharCode(...encrypted));
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
    async recallManual(query: string, limit: number = 10, namespace?: string): Promise<RecallManualResult> {
        if (!query) throw new Error("Query cannot be empty");

        const ns = namespace ?? this.namespace;

        // Step 1: Embed query
        const vector = await this.embed(query);

        // Step 2: Search server
        const searchResult = await this.signedRequest<{ results: { blob_id: string; distance: number }[]; total: number }>(
            "POST",
            "/api/recall/manual",
            { vector, limit, namespace: ns },
        );

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
            (d): d is { blob_id: string; data: Uint8Array; distance: number } => d !== null,
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
        let sessionKey: any;
        try {
            sealClient = await this.getSealClient();
            suiClient = await this.getSuiClient();
            // @ts-ignore — optional peer dependency
            ({ SessionKey, EncryptedObject } = await import("@mysten/seal"));
            ({ Transaction } = await import("@mysten/sui/transactions"));
        } catch (err) {
            console.error('[MemWalManual] Failed to initialize SEAL/SUI clients:', err);
            return { results: [], total: 0 };
        }

        const callerAddress = await this.getOwnerAddress();

        // Create signer (wallet adapter or keypair)
        const signer = await this.createSigner(callerAddress);

        // Create session key ONCE (triggers one wallet popup)
        try {
            sessionKey = await SessionKey.create({
                address: callerAddress,
                packageId: this.config.packageId,
                ttlMin: 30,
                signer,
                suiClient,
            });
        } catch (err) {
            console.error('[MemWalManual] SessionKey.create failed:', err);
            return { results: [], total: 0 };
        }

        // Decrypt each blob sequentially using the shared session key
        const results: RecallManualMemory[] = [];
        for (const blob of downloadedBlobs) {
            try {
                const parsed = EncryptedObject.parse(blob.data);
                const fullId = parsed.id;

                // Build seal_approve PTB
                const idBytes = Array.from(
                    Uint8Array.from(fullId.match(/.{1,2}/g)!.map((b: string) => parseInt(b, 16))),
                );
                const tx = new Transaction();
                tx.moveCall({
                    target: `${this.config.packageId}::account::seal_approve`,
                    arguments: [
                        tx.pure("vector<u8>", idBytes),
                        tx.object(this.config.accountId),
                    ],
                });
                const txBytes = await tx.build({ client: suiClient, onlyTransactionKind: true });

                // Fetch decryption keys using shared session key
                await sealClient.fetchKeys({
                    ids: [fullId],
                    txBytes,
                    sessionKey,
                    threshold: 1,
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
                "MemWalManual: embeddingApiKey is required. " +
                "Provide your OpenAI or OpenRouter API key in config."
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
                "Authorization": `Bearer ${this.config.embeddingApiKey}`,
            },
            body: JSON.stringify({ model, input: text }),
        });

        if (!resp.ok) {
            const errText = await resp.text();
            throw new Error(`Embedding API error (${resp.status}): ${errText}`);
        }

        const data = await resp.json() as { data: { embedding: number[] }[] };
        if (!data.data?.[0]?.embedding) {
            throw new Error("Embedding API returned no data");
        }
        return data.data[0].embedding;
    }

    // ============================================================
    // Internal: SEAL Encrypt
    // ============================================================

    private async sealEncrypt(plaintext: Uint8Array): Promise<Uint8Array> {
        const sealClient = await this.getSealClient();
        const ownerAddress = await this.getOwnerAddress();

        const result = await sealClient.encrypt({
            threshold: 1,
            packageId: this.config.packageId,
            id: ownerAddress,
            data: plaintext,
        });

        return new Uint8Array(result.encryptedObject);
    }

    // ============================================================
    // Internal: Walrus Upload/Download
    // ============================================================

    private async walrusUpload(data: Uint8Array): Promise<string> {
        // Direct HTTP PUT to Walrus publisher (works in both browser and Node.js,
        // unlike @mysten/walrus SDK which uses WASM and requires Node.js)
        const publisherUrl = this.config.walrusPublisherUrl ?? "https://publisher.walrus-mainnet.walrus.space";
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

        const result = await resp.json() as any;
        // Response can be { newlyCreated: { blobObject: { blobId } } }
        // or { alreadyCertified: { blobId } }
        const blobId = result.newlyCreated?.blobObject?.blobId
            ?? result.alreadyCertified?.blobId;

        if (!blobId) {
            throw new Error(`Walrus upload: unexpected response: ${JSON.stringify(result)}`);
        }
        return blobId;
    }

    private async walrusDownload(blobId: string): Promise<Uint8Array> {
        // Direct HTTP fetch to Walrus aggregator (works in both browser and Node.js,
        // unlike @mysten/walrus SDK which requires Node.js APIs)
        const aggregatorUrl = this.config.walrusAggregatorUrl ?? "https://aggregator.walrus-mainnet.walrus.space";
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

    private async signedRequest<T>(
        method: string,
        path: string,
        body: object,
    ): Promise<T> {
        const ed = await import("@noble/ed25519");

        const timestamp = Math.floor(Date.now() / 1000).toString();
        const bodyStr = JSON.stringify(body);
        const bodySha256 = await sha256hex(bodyStr);

        const message = `${timestamp}.${method}.${path}.${bodySha256}`;
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
            },
            body: bodyStr,
        });

        if (!res.ok) {
            const errText = await res.text();
            throw new Error(`MemWal API error (${res.status}): ${errText}`);
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
    async restore(namespace: string, limit: number = 50): Promise<RestoreResult> {
        return this.signedRequest<RestoreResult>("POST", "/api/restore", {
            namespace,
            limit,
        });
    }
}
