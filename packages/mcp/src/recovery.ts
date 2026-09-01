/**
 * Recovery for a login that was interrupted after the browser registered our
 * delegate key on-chain but before the callback could save it (WALM-332).
 *
 * `loginFlow` write-aheads the keypair to `login-pending.json` before the
 * browser can act, so the key itself survives losing the process. What does
 * not survive is the metadata the callback would have carried — `accountId`,
 * `walletAddress`, `packageId` — and `credentials.json` is not loadable
 * without them. `GET /api/whoami` closes that gap: the relayer resolves the
 * account from the delegate key during authentication anyway, so it can hand
 * back the identity the key already proves.
 */
import { randomUUID, createHash } from "node:crypto";

import type { MemWalCredentials } from "./auth.js";
import { loadCreds, saveCreds, loadPendingLogin, clearPendingLogin } from "./auth.js";
import { signMessage } from "./crypto.js";
import { log } from "./logger.js";

export type RecoveryOutcome =
    /** Nothing was pending. The overwhelmingly common case. */
    | "no-pending"
    /** Key was registered; `credentials.json` has been rebuilt from it. */
    | "recovered"
    /** A newer sign-in already happened — the pending key is stale. */
    | "superseded"
    /** Relayer would not authenticate the key. Deliberately non-destructive. */
    | "rejected"
    /** Relayer unreachable or erroring. Record kept for a later attempt. */
    | "unavailable";

export interface RecoveryResult {
    outcome: RecoveryOutcome;
    /** Set when a key may be registered on-chain but is not usable locally. */
    strandedPublicKey?: string;
    credentials?: MemWalCredentials;
}

/** Same wall-clock budget as a normal cold-start probe: recovery must never
 * be the reason a client hangs at startup. */
const WHOAMI_TIMEOUT_MS = 10_000;

interface WhoamiResponse {
    account_id: string;
    owner: string;
    package_id: string;
}

function isWhoami(o: unknown): o is WhoamiResponse {
    if (!o || typeof o !== "object") return false;
    const w = o as Record<string, unknown>;
    return (
        typeof w.account_id === "string" &&
        /^0x[0-9a-fA-F]{64}$/.test(w.account_id) &&
        typeof w.owner === "string" &&
        typeof w.package_id === "string"
    );
}

/**
 * Ask the relayer who this delegate key belongs to.
 *
 * The account id is signed as an empty string and its header omitted, because
 * not knowing it is the entire reason we are here. The server defaults the
 * hint to `""` when the header is absent, so both sides build the same
 * canonical message.
 */
/**
 * Build the exact string the relayer will rebuild and verify against.
 *
 * `services/server/src/auth.rs` calls itself the single source of truth for
 * this format, and it is reproduced here rather than imported because the two
 * live in different languages. That duplication is the risk: get it subtly
 * wrong — a trimmed trailing separator, a missing empty field — and every
 * recovery attempt fails with an opaque 401 that no type checker would have
 * caught. Exported so a test can pin it against the identical literal asserted
 * in `routes::accounts::tests::whoami_recovery_request_canonical_message_is_stable`.
 *
 * `accountId` is empty for recovery: not knowing it is the reason we are here,
 * and the server defaults its hint to `""` when the header is absent.
 */
export function canonicalRequestMessage(parts: {
    timestamp: string;
    method: string;
    path: string;
    bodyHash: string;
    nonce: string;
    accountId?: string;
}): string {
    const { timestamp, method, path, bodyHash, nonce, accountId = "" } = parts;
    return `${timestamp}.${method}.${path}.${bodyHash}.${nonce}.${accountId}`;
}

/** sha256 of an empty body. A GET sends none; the server hashes it anyway. */
export const EMPTY_BODY_SHA256 = createHash("sha256").update("").digest("hex");

async function whoami(
    relayerUrl: string,
    privateKeyHex: string,
    publicKeyHex: string,
): Promise<{ status: number; body: unknown } | null> {
    const path = "/api/whoami";
    const timestamp = String(Date.now());
    const nonce = randomUUID();
    const message = canonicalRequestMessage({
        timestamp,
        method: "GET",
        path,
        bodyHash: EMPTY_BODY_SHA256,
        nonce,
    });
    const signature = await signMessage(privateKeyHex, message);

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), WHOAMI_TIMEOUT_MS);
    timer.unref?.();
    try {
        const resp = await fetch(`${relayerUrl.replace(/\/+$/, "")}${path}`, {
            method: "GET",
            headers: {
                "x-public-key": publicKeyHex,
                "x-signature": signature,
                "x-timestamp": timestamp,
                "x-nonce": nonce,
            },
            signal: controller.signal,
        });
        const text = await resp.text();
        let body: unknown = null;
        try {
            body = JSON.parse(text);
        } catch {
            /* non-JSON error page — status is what matters */
        }
        return { status: resp.status, body };
    } catch {
        return null;
    } finally {
        clearTimeout(timer);
    }
}

/**
 * Attempt to turn a stranded pending login into usable credentials.
 *
 * Never throws, and never deletes a record that might still be recoverable —
 * a stranded key is the user's paid-for property, and the cost of keeping it
 * around until its TTL is a file that grants nothing.
 */
export async function recoverPendingLogin(): Promise<RecoveryResult> {
    const pending = loadPendingLogin();
    if (!pending) return { outcome: "no-pending" };

    // Ordering guard. If a later sign-in already succeeded, its credentials
    // are the user's current intent and must not be rolled back to an older
    // stranded key. Note this compares against the *pending* record's start
    // time, so a login begun after the last successful one still wins.
    const existing = loadCreds();
    if (existing && Date.parse(existing.createdAt) >= Date.parse(pending.createdAt)) {
        log.warn("login.pending.superseded", {
            publicKey: pending.delegatePublicKeyHex,
        });
        clearPendingLogin();
        return { outcome: "superseded", strandedPublicKey: pending.delegatePublicKeyHex };
    }

    const res = await whoami(
        pending.relayerUrl,
        pending.delegatePrivateKey,
        pending.delegatePublicKeyHex,
    );

    if (res === null) {
        log.warn("login.pending.relayer_unreachable", {
            publicKey: pending.delegatePublicKeyHex,
        });
        return { outcome: "unavailable", strandedPublicKey: pending.delegatePublicKeyHex };
    }

    if (res.status !== 200 || !isWhoami(res.body)) {
        // Deliberately NOT destructive. A 401 is ambiguous: it means "this key
        // is not registered" on mainnet, but on testnet the registry scan is
        // disabled outright and a *genuinely registered* key is rejected for
        // want of an x-account-id hint (services/server/src/auth.rs — "x-account-id
        // is required for delegate-key authentication on testnet"). Clearing
        // here would destroy a recoverable key in exactly that environment, so
        // the record is left for its TTL to retire.
        log.warn("login.pending.rejected", {
            publicKey: pending.delegatePublicKeyHex,
            status: res.status,
        });
        return { outcome: "rejected", strandedPublicKey: pending.delegatePublicKeyHex };
    }

    const creds: MemWalCredentials = {
        delegatePrivateKey: pending.delegatePrivateKey,
        delegatePublicKeyHex: pending.delegatePublicKeyHex,
        delegateAddress: pending.delegateAddress,
        walletAddress: res.body.owner,
        accountId: res.body.account_id,
        packageId: res.body.package_id,
        relayerUrl: pending.relayerUrl,
        label: pending.label,
        createdAt: new Date().toISOString(),
        version: 1,
    };
    saveCreds(creds);
    clearPendingLogin();
    log.info("login.pending.recovered", {
        accountId: creds.accountId,
        delegateAddress: creds.delegateAddress,
    });
    return { outcome: "recovered", credentials: creds };
}

/**
 * The line to show the user when a stranded key could not be reclaimed.
 *
 * Names the key, because the actionable step is revoking it from the
 * dashboard — a user told only "login failed" has no way to find the
 * registration they paid for.
 */
export function formatStrandedLoginNotice(result: RecoveryResult): string | null {
    if (!result.strandedPublicKey) return null;
    if (result.outcome === "recovered" || result.outcome === "no-pending") return null;

    const key = result.strandedPublicKey;
    const lines = [
        `⚠️  Your last Walrus Memory sign-in did not finish.`,
        ``,
        `A delegate key may have been registered on-chain without being saved locally:`,
        `  ${key}`,
        ``,
    ];
    if (result.outcome === "superseded") {
        lines.push(
            `You have since signed in again, so your current credentials are fine.`,
            `Revoke the key above from the dashboard if you don't recognise it.`,
        );
    } else if (result.outcome === "unavailable") {
        lines.push(
            `The relayer could not be reached to check. This will be retried on the`,
            `next start — no action needed yet.`,
        );
    } else {
        lines.push(
            `The relayer did not accept it. Run \`memwal_login\` to sign in again,`,
            `then revoke the key above from the dashboard so it isn't left dangling.`,
        );
    }
    return lines.join("\n");
}
