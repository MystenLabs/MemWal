/**
 * In-process MemWal client, built from `credentials.json`.
 *
 * Reloads the file on every lookup so a completed `memwal_login` is picked
 * up without a client restart. Logout destroys the client so later memory
 * tools cannot keep signing with a key the user just deleted.
 */
import { MemWal } from "@mysten-incubation/memwal";
import { clearCreds, loadCreds, type MemWalCredentials } from "./auth.js";

export interface MemoryClient {
    rememberAndWait(
        text: string,
        namespace?: string,
        opts?: { timeoutMs?: number },
    ): Promise<{ blob_id: string; namespace: string }>;
    rememberBulkAndWait(
        items: { text: string; namespace?: string }[],
        opts?: { timeoutMs?: number },
    ): Promise<{
        results: { status: string; blob_id?: string; error?: string }[];
        succeeded: number;
        total: number;
        failed: number;
    }>;
    recall(params: {
        query: string;
        limit?: number;
        namespace?: string;
        maxDistance?: number;
    }): Promise<{
        results: { text: string; distance: number; created_at?: unknown }[];
        dropped_count?: number;
    }>;
    analyzeAndWait(
        text: string,
        namespace?: string,
        opts?: { timeoutMs?: number },
    ): Promise<{
        facts: { text: string }[];
        results: { status: string; blob_id?: string }[];
        succeeded: number;
        failed: number;
    }>;
    restore(
        namespace: string,
        limit?: number,
    ): Promise<{
        namespace: string;
        total: number;
        restored: number;
        skipped: number;
        failed?: number;
        truncated?: boolean;
    }>;
    health(): Promise<{
        status: string;
        version: string;
        write_ready?: boolean;
        writes?: string;
    }>;
    destroy(): void;
}

export type ClientFactory = (creds: MemWalCredentials) => MemoryClient;

const defaultFactory: ClientFactory = (creds) =>
    MemWal.create({
        key: creds.delegatePrivateKey,
        accountId: creds.accountId,
        serverUrl: creds.relayerUrl,
    });

let factory: ClientFactory = defaultFactory;
let cached: { creds: MemWalCredentials; client: MemoryClient } | null = null;

/** Test seam. Pass `undefined` to restore the real SDK factory. */
export function setClientFactory(next?: ClientFactory): void {
    factory = next ?? defaultFactory;
    dropClient();
}

function sameCreds(a: MemWalCredentials, b: MemWalCredentials): boolean {
    return (
        a.delegatePrivateKey === b.delegatePrivateKey &&
        a.accountId === b.accountId &&
        a.relayerUrl === b.relayerUrl
    );
}

export function dropClient(): void {
    try {
        cached?.client.destroy();
    } catch {
        /* already torn down */
    }
    cached = null;
}

/**
 * Return a live SDK client for the credentials currently on disk, or null
 * when the file is missing. Recreates the client when the file's key,
 * account, or relayer URL changes.
 */
export function getClient(): MemoryClient | null {
    const creds = loadCreds();
    if (!creds) {
        dropClient();
        return null;
    }
    if (cached && sameCreds(cached.creds, creds)) return cached.client;
    dropClient();
    const client = factory(creds);
    cached = { creds, client };
    return client;
}

/** Currently-cached credentials, if a client is live. */
export function currentCreds(): MemWalCredentials | null {
    return cached?.creds ?? loadCreds();
}

/**
 * Delete the credentials file and destroy the in-process client.
 * A relayer 401 must NOT call this — that was a creds-wipe DoS.
 */
export function logout(): ReturnType<typeof clearCreds> {
    const result = clearCreds();
    dropClient();
    return result;
}
