/**
 * MemWal V2 — SDK Client
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
 * import { MemWal } from "@cmdoss/memwal-v2"
 *
 * const memwal = MemWal.create({
 *     key: process.env.MEMWAL_PRIVATE_KEY,  // Ed25519 private key (hex)
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
} from "./types.js";

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

let _crypto: typeof import("crypto") | null = null;
async function getCrypto() {
    if (!_crypto) {
        _crypto = await import("crypto");
    }
    return _crypto;
}

// ============================================================
// MemWal Client
// ============================================================

export class MemWal {
    private privateKey: Uint8Array;
    private publicKey: Uint8Array | null = null;
    private serverUrl: string;

    private constructor(config: MemWalConfig) {
        this.privateKey = hexToBytes(config.key);
        this.serverUrl = (config.serverUrl ?? "http://localhost:3001").replace(/\/$/, "");
    }

    /**
     * Create a new MemWal client instance.
     *
     * @param config.key - Ed25519 private key (hex string) — the delegate key
     * @param config.serverUrl - Server URL (default: http://localhost:3001)
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
     * @returns RememberResult with id, blobId, owner
     *
     * @example
     * ```typescript
     * const result = await memwal.remember("I'm allergic to peanuts")
     * console.log(result.blobId) // "TY8mW0yr..."
     * ```
     */
    async remember(text: string): Promise<RememberResult> {
        return this.signedRequest<RememberResult>("POST", "/api/remember", {
            text,
        });
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
    async recall(query: string, limit: number = 10): Promise<RecallResult> {
        return this.signedRequest<RecallResult>("POST", "/api/recall", {
            query,
            limit,
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
    async analyze(text: string): Promise<AnalyzeResult> {
        return this.signedRequest<AnalyzeResult>("POST", "/api/analyze", {
            text,
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
        const crypto = await getCrypto();

        const timestamp = Math.floor(Date.now() / 1000).toString();
        const bodyStr = JSON.stringify(body);
        const bodySha256 = crypto
            .createHash("sha256")
            .update(bodyStr)
            .digest("hex");

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

// ============================================================
// Hex Helpers
// ============================================================

function hexToBytes(hex: string): Uint8Array {
    const clean = hex.startsWith("0x") ? hex.slice(2) : hex;
    const bytes = new Uint8Array(clean.length / 2);
    for (let i = 0; i < bytes.length; i++) {
        bytes[i] = parseInt(clean.substr(i * 2, 2), 16);
    }
    return bytes;
}

function bytesToHex(bytes: Uint8Array): string {
    return Array.from(bytes)
        .map((b) => b.toString(16).padStart(2, "0"))
        .join("");
}
