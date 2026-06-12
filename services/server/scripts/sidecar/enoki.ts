/**
 * Enoki sponsored-transaction API client.
 *
 * `callEnoki` wraps the raw HTTP API with transient-error retries;
 * `executeWithEnokiSponsor` is the high-level sponsor → sign → execute
 * path with optional direct-sign fallback.
 */

import { Buffer } from "buffer";
import type { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import type { Transaction } from "@mysten/sui/transactions";
import { getEnokiRetryDelayMs, isSponsoredTransactionInvalidatedMessage } from "../enoki-retry.js";
import {
    ENOKI_API_BASE_URL,
    ENOKI_API_KEY,
    ENOKI_FALLBACK_TO_DIRECT_SIGN,
    ENOKI_NETWORK,
    ENOKI_TRANSIENT_BASE_DELAY_MS,
    ENOKI_TRANSIENT_MAX_ATTEMPTS,
    ENOKI_TRANSIENT_MAX_DELAY_MS,
} from "./config.js";
import { suiClient } from "./clients.js";
import { errorMessage, sleep, truncateForLog } from "./util.js";

type EnokiDataWrapper<T> = { data: T };
export type EnokiSponsorResponse = { bytes: string; digest: string };
export type EnokiExecuteResponse = { digest: string };

export function redactEnokiPath(path: string): string {
    return path.replace(/\/transaction-blocks\/sponsor\/[^/?]+/, "/transaction-blocks/sponsor/<digest>");
}

export function summarizeEnokiError(text: string): Record<string, unknown> {
    try {
        const parsed = JSON.parse(text) as { errors?: Array<{ code?: string; message?: string }> };
        if (Array.isArray(parsed.errors)) {
            return {
                errors: parsed.errors.map((err) => ({
                    code: err.code,
                    message: truncateForLog(err.message || ""),
                    hasMoveAbort: /moveabort/i.test(err.message || ""),
                    hasBalanceSplit: /balance.*split|split.*balance/i.test(err.message || ""),
                })),
            };
        }
    } catch {
        // Fall through to raw body summary.
    }
    return { body: truncateForLog(text) };
}

export function isMoveAbortBalanceSplit(message: string): boolean {
    return /moveabort/i.test(message) && /balance.*split|split.*balance/i.test(message);
}

export async function callEnoki<T>(path: string, payload: unknown): Promise<T> {
    if (!ENOKI_API_KEY) {
        throw new Error("ENOKI_API_KEY is not configured");
    }

    for (let attempt = 1; ; attempt += 1) {
        let resp: globalThis.Response;
        try {
            resp = await fetch(`${ENOKI_API_BASE_URL}${path}`, {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    Authorization: `Bearer ${ENOKI_API_KEY}`,
                },
                body: JSON.stringify(payload),
            });
        } catch (err) {
            const retryDelayMs = getEnokiRetryDelayMs({
                attempt,
                maxAttempts: ENOKI_TRANSIENT_MAX_ATTEMPTS,
                baseDelayMs: ENOKI_TRANSIENT_BASE_DELAY_MS,
                maxDelayMs: ENOKI_TRANSIENT_MAX_DELAY_MS,
                transportError: true,
            });
            if (retryDelayMs === null) throw err;
            console.warn(`[enoki] transport_retry ${JSON.stringify({
                path: redactEnokiPath(path),
                network: ENOKI_NETWORK,
                attempt,
                maxAttempts: ENOKI_TRANSIENT_MAX_ATTEMPTS,
                retryDelayMs,
                error: errorMessage(err),
            })}`);
            await sleep(retryDelayMs);
            continue;
        }

        const text = await resp.text();
        if (!resp.ok) {
            const retryDelayMs = getEnokiRetryDelayMs({
                attempt,
                maxAttempts: ENOKI_TRANSIENT_MAX_ATTEMPTS,
                baseDelayMs: ENOKI_TRANSIENT_BASE_DELAY_MS,
                maxDelayMs: ENOKI_TRANSIENT_MAX_DELAY_MS,
                status: resp.status,
                retryAfter: resp.headers.get("retry-after"),
                body: text,
            });
            console.error(`[enoki] api_error ${JSON.stringify({
                path: redactEnokiPath(path),
                status: resp.status,
                network: ENOKI_NETWORK,
                attempt,
                maxAttempts: ENOKI_TRANSIENT_MAX_ATTEMPTS,
                retryDelayMs,
                ...summarizeEnokiError(text),
            })}`);
            if (retryDelayMs !== null) {
                await sleep(retryDelayMs);
                continue;
            }
            throw new Error(`Enoki API error (${resp.status}): ${text}`);
        }

        const parsed = JSON.parse(text) as EnokiDataWrapper<T>;
        return parsed.data;
    }
}

async function executeSponsoredTransactionOnce(
    tx: Transaction,
    signer: Ed25519Keypair,
    allowedAddresses?: string[],
): Promise<string> {
    const txKindBytes = await tx.build({
        client: suiClient as any,
        onlyTransactionKind: true,
    });

    const sponsored = await callEnoki<EnokiSponsorResponse>("/transaction-blocks/sponsor", {
        network: ENOKI_NETWORK,
        transactionBlockKindBytes: Buffer.from(txKindBytes).toString("base64"),
        sender: signer.toSuiAddress(),
        ...(allowedAddresses?.length ? { allowedAddresses } : {}),
    });

    const signature = await signer.signTransaction(
        new Uint8Array(Buffer.from(sponsored.bytes, "base64"))
    );

    // Defense-in-depth — encode digest before path interpolation.
    const encodedSponsoredDigest = encodeURIComponent(sponsored.digest);
    const executed = await callEnoki<EnokiExecuteResponse>(
        `/transaction-blocks/sponsor/${encodedSponsoredDigest}`,
        {
            digest: sponsored.digest,
            signature: signature.signature,
        }
    );

    return executed.digest;
}

export async function executeWithEnokiSponsor(
    tx: Transaction,
    signer: Ed25519Keypair,
    allowedAddresses?: string[],
): Promise<string> {
    if (!ENOKI_API_KEY) {
        if (!ENOKI_FALLBACK_TO_DIRECT_SIGN) {
            throw new Error("ENOKI_API_KEY is not configured and ENOKI_FALLBACK_TO_DIRECT_SIGN=false");
        }

        console.warn("[enoki-sponsor] ENOKI_API_KEY not configured, falling back to direct signing");
        const direct = await suiClient.signAndExecuteTransaction({
            signer,
            transaction: tx,
        });
        return direct.digest;
    }

    let sponsorError: unknown;
    try {
        return await executeSponsoredTransactionOnce(tx, signer, allowedAddresses);
    } catch (err: any) {
        if (isSponsoredTransactionInvalidatedMessage(errorMessage(err))) {
            console.warn(`[enoki-sponsor] sponsored tx invalidated; retrying sponsor/execute once: ${err?.message || err}`);
            try {
                return await executeSponsoredTransactionOnce(tx, signer, allowedAddresses);
            } catch (retryErr: any) {
                sponsorError = retryErr;
            }
        } else {
            sponsorError = err;
        }
    }

    {
        const err = sponsorError;
        const errMsg = errorMessage(err);
        if (!ENOKI_FALLBACK_TO_DIRECT_SIGN) {
            console.error(`[enoki-sponsor] sponsor failed and fallback disabled: ${errMsg}`);
            throw err;
        }

        console.warn(`[enoki-sponsor] sponsor failed, falling back to direct signing: ${errMsg}`);
        const direct = await suiClient.signAndExecuteTransaction({
            signer,
            transaction: tx,
        });
        return direct.digest;
    }
}
