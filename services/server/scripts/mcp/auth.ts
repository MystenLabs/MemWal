/**
 * =============================================================================
 * MCP AUTH — Delegate-key Bearer resolution
 * =============================================================================
 * MemWal MCP authenticates each session with a delegate key (Ed25519 private)
 * passed via the `Authorization: Bearer <hex>` header. The MemWalAccount id
 * comes from a second header (`X-MemWal-Account-Id`) so the same delegate key
 * can be registered against multiple accounts.
 *
 * No OAuth flow — MemWal's on-chain delegate-key model IS the auth. The
 * relayer already verifies the delegate key is registered against the account
 * on its first signed request, so we don't repeat that check here.
 *
 * Session key (stable across reconnects):
 *     delegate:${account_id}:${delegate_pubkey_hex}
 * =============================================================================
 */
import { MemWal } from "@mysten-incubation/memwal";

export interface MemWalSession {
    accountId: string;
    delegateKeyHex: string;
    delegatePubKeyHex: string;
    namespace?: string;
    memwal: MemWal;
    authMethod: "delegate-key";
}

export interface AuthResolution {
    session: MemWalSession;
    sessionKey: string;
}

export class McpAuthError extends Error {
    readonly status: number;
    constructor(message: string, status = 401) {
        super(message);
        this.name = "McpAuthError";
        this.status = status;
    }
}

const HEX64_RE = /^(0x)?[0-9a-fA-F]{64}$/;

/**
 * Derive the Ed25519 public-key hex from a private-key hex (32-byte seed).
 * Lazy import so we don't pull crypto into module init.
 */
async function publicKeyHex(privateKeyHex: string): Promise<string> {
    const { getPublicKeyAsync } = await import("@noble/ed25519");
    const seedHex = privateKeyHex.startsWith("0x")
        ? privateKeyHex.slice(2)
        : privateKeyHex;
    const seed = hexToBytes(seedHex);
    const pub = await getPublicKeyAsync(seed);
    return bytesToHex(pub);
}

function hexToBytes(hex: string): Uint8Array {
    const out = new Uint8Array(hex.length / 2);
    for (let i = 0; i < out.length; i++) {
        out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
    }
    return out;
}

function bytesToHex(b: Uint8Array): string {
    return Array.from(b)
        .map((x) => x.toString(16).padStart(2, "0"))
        .join("");
}

/**
 * Resolve auth from incoming HTTP headers.
 *
 * Required headers:
 *     Authorization: Bearer <ed25519-private-key-hex>     (64 hex chars)
 *     X-MemWal-Account-Id: 0x<sui-object-id>             (66 chars)
 * Optional:
 *     X-MemWal-Namespace: <namespace>                    (default per-tool)
 *
 * Throws McpAuthError on missing / malformed credentials.
 */
export async function resolveAuth(
    headers: Headers,
    serverUrl: string
): Promise<AuthResolution> {
    const authHeader = headers.get("authorization");
    if (!authHeader || !authHeader.toLowerCase().startsWith("bearer ")) {
        throw new McpAuthError(
            "Missing Authorization: Bearer <delegate-key-hex> header"
        );
    }
    const rawKey = authHeader.slice("bearer ".length).trim();
    if (!HEX64_RE.test(rawKey)) {
        throw new McpAuthError(
            "Bearer token must be a 64-char hex Ed25519 private key (32-byte seed)"
        );
    }
    const delegateKeyHex = rawKey.startsWith("0x") ? rawKey.slice(2) : rawKey;

    const accountId = headers.get("x-memwal-account-id");
    if (!accountId || !/^0x[0-9a-fA-F]{64}$/.test(accountId)) {
        throw new McpAuthError(
            "Missing or malformed X-MemWal-Account-Id header (0x-prefixed 64-hex Sui object id)"
        );
    }

    const namespace = headers.get("x-memwal-namespace") ?? undefined;
    const delegatePubKeyHex = await publicKeyHex(delegateKeyHex);

    const memwal = MemWal.create({
        key: delegateKeyHex,
        accountId,
        serverUrl,
        namespace,
    });

    const session: MemWalSession = {
        accountId,
        delegateKeyHex,
        delegatePubKeyHex,
        namespace,
        memwal,
        authMethod: "delegate-key",
    };

    // Session key stable across reconnects from same {account, delegate}. We
    // don't include namespace because the same client can call multiple
    // namespaces in one session via per-tool overrides.
    const sessionKey = `delegate:${accountId}:${delegatePubKeyHex}`;

    return { session, sessionKey };
}
