/**
 * Backfill `vector_entries.end_epoch` for legacy rows.
 *
 * Rows written before the expiry feature shipped have no `end_epoch`, so the
 * recall filter falls back to "always serve" for them — safe, but means the
 * fix is incomplete until this script runs and fills in real lease state.
 *
 * Strategy: read each blob's `storage.end_epoch` straight from chain via
 * `walrusClient.getBlobObject(objectId)`. That's exact (no timestamp→epoch
 * estimation, no assumption about how many epochs were originally bought) and
 * works for our `deletable: true` blobs (`getVerifiedBlobStatus` doesn't —
 * it omits `endEpoch` for the deletable variant).
 *
 * `getBlobObject` needs the Sui object id, but legacy rows store only
 * `blob_id`. We resolve in this order:
 *   1. Row already has `object_id` (written by post-feature paths) — use it.
 *   2. Otherwise, the sidecar's `/walrus/query-blobs` does a per-owner wallet
 *      scan that returns `blobId` already converted to the base64url form
 *      stored in `vector_entries.blob_id` — so map lookups match the DB
 *      directly with no u256↔base64url encoding step on this side.
 *
 * Safety properties:
 *   - DRY-RUN BY DEFAULT. `--apply` writes; `--limit N` caps rows; `--owner
 *     0x…` scopes to one wallet.
 *   - Re-runnable: the UPDATE is guarded `WHERE end_epoch IS NULL`, so it
 *     can't overwrite a value the live server has written.
 *   - Benchmark rows (`plaintext IS NOT NULL`) are skipped — they have no
 *     Walrus blob.
 *   - We only write `end_epoch = 0` (= "filtered/dead") when the chain itself
 *     confirms the blob is gone (ObjectError.code = notExists/deleted). Any
 *     other failure — transient RPC, unresolved object id, partial scan — is
 *     left NULL for the next run. We never guess in the dead direction.
 *
 * Same env shape as the server so one script can target dev or mainnet:
 *   DATABASE_URL          source DB
 *   SUI_NETWORK           testnet | mainnet — cross-checked against sidecar
 *   SIDECAR_URL           default http://127.0.0.1:9000
 *   SIDECAR_AUTH_TOKEN    required (script aborts early without it)
 *   SUI_RPC_URL           optional fullnode override
 *
 * Usage:
 *   tsx backfill-end-epoch.ts                              # dry-run, all owners
 *   tsx backfill-end-epoch.ts --apply --limit 50           # apply, capped
 *   tsx backfill-end-epoch.ts --apply --owner 0xabc...     # one wallet
 */

import postgres from "postgres";
import { WalrusClient } from "@mysten/walrus";
import { SuiJsonRpcClient, getJsonRpcFullnodeUrl } from "@mysten/sui/jsonRpc";

// ── CLI args ──────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const APPLY = args.includes("--apply");

// Reject a flag whose value is missing or is itself another `--flag` rather
// than silently mis-scoping the run — `--owner` with no value would otherwise
// scan ALL owners, and `--limit` with no value would parse as NaN.
function flagValue(name: string): string | null {
    const i = args.indexOf(name);
    if (i < 0) return null;
    const v = args[i + 1];
    if (v === undefined || v.startsWith("--")) {
        console.error(`[backfill] FATAL: ${name} requires a value`);
        process.exit(1);
    }
    return v;
}
const ONLY_OWNER = flagValue("--owner");
const limitStr = flagValue("--limit");
let ROW_LIMIT: number | null = null;
if (limitStr !== null) {
    const n = parseInt(limitStr, 10);
    if (!Number.isInteger(n) || n < 1) {
        console.error(`[backfill] FATAL: --limit must be a positive integer (got "${limitStr}")`);
        process.exit(1);
    }
    ROW_LIMIT = n;
}

// ── Env ───────────────────────────────────────────────────────────────────
function requireEnv(name: string): string {
    const v = process.env[name];
    if (!v) {
        console.error(`[backfill] FATAL: ${name} not set`);
        process.exit(1);
    }
    return v;
}

const DATABASE_URL = requireEnv("DATABASE_URL");
const SUI_NETWORK = (process.env.SUI_NETWORK || "mainnet") as "mainnet" | "testnet";
const SIDECAR_URL = process.env.SIDECAR_URL || "http://127.0.0.1:9000";
// The sidecar mandates auth; a missing token would 401 every owner and get
// logged as a per-owner "resolve FAILED" — a run that looks successful but
// wrote nothing. Require the token up front instead of degrading silently.
const SIDECAR_AUTH_TOKEN = requireEnv("SIDECAR_AUTH_TOKEN");

type LegacyRow = { id: string; owner: string; blob_id: string; object_id: string | null };
type QueryBlob = { blobId: string; objectId: string };

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Catch the most plausible operator footgun before touching the DB: a
// mismatched SUI_NETWORK env (testnet DB + mainnet env, or a SIDECAR_URL
// pointing at the wrong sidecar) would silently make every owner's wallet
// scan return zero blobs — every row left NULL, run looks like a clean
// no-op but is actually miscoverage. The sidecar reports `suiNetwork` on the
// current-epoch endpoint already; one call here and bail on mismatch.
async function assertSidecarNetworkMatches(): Promise<void> {
    const url = `${SIDECAR_URL}/walrus/current-epoch`;
    let resp: Response;
    try {
        resp = await fetch(url, {
            headers: { authorization: `Bearer ${SIDECAR_AUTH_TOKEN}` },
        });
    } catch (e: any) {
        console.error(`[backfill] FATAL: sidecar unreachable at ${SIDECAR_URL}: ${e?.message || e}`);
        process.exit(1);
    }
    if (resp.status === 401 || resp.status === 403) {
        console.error(`[backfill] FATAL: sidecar rejected auth (${resp.status}) — check SIDECAR_AUTH_TOKEN`);
        process.exit(1);
    }
    if (!resp.ok) {
        console.error(`[backfill] FATAL: sidecar /walrus/current-epoch ${resp.status} ${await resp.text()}`);
        process.exit(1);
    }
    const body = (await resp.json()) as { epoch: number; suiNetwork?: string };
    if (body.suiNetwork && body.suiNetwork !== SUI_NETWORK) {
        console.error(
            `[backfill] FATAL: SUI_NETWORK env is "${SUI_NETWORK}" but sidecar at ${SIDECAR_URL} ` +
                `reports network "${body.suiNetwork}". Refusing to run — this would silently miscover ` +
                `every owner. Fix SUI_NETWORK or SIDECAR_URL and retry.`,
        );
        process.exit(1);
    }
    console.log(`[backfill] sidecar check ok: network=${body.suiNetwork ?? "?"}, current_epoch=${body.epoch}`);
}

// Per-owner pacing + retry config, overridable via env. A per-owner wallet
// scan is several getOwnedObjects pages; firing many back-to-back trips the
// RPC's 429 limit (observed in practice). A small inter-owner delay plus
// exponential backoff on 429/503 keeps a one-shot run within the limits
// without losing rows — the script is re-runnable, so any owner we still
// can't resolve is just picked up next pass.
const OWNER_DELAY_MS = Number(process.env.BACKFILL_OWNER_DELAY_MS || 1500);
const MAX_RETRIES = Number(process.env.BACKFILL_MAX_RETRIES || 5);

// ── Sidecar resolver: blob_id → object_id, per owner ────────────────────────
// The sidecar returns each blob's `blobId` already converted to base64url
// (matching what vector_entries.blob_id stores), so the map keys line up with
// the DB directly — no conversion on this side.

// Distinct error class so the per-owner catch can re-throw auth failures up to
// main(). An auth misconfig affects every owner; logging it per-owner as a
// "resolve FAILED" would mislead the operator into thinking it's recoverable.
class SidecarAuthError extends Error {}

async function resolveOwnerBlobMap(owner: string): Promise<Map<string, string>> {
    const url = `${SIDECAR_URL}/walrus/query-blobs`;
    let attempt = 0;
    for (;;) {
        const resp = await fetch(url, {
            method: "POST",
            headers: {
                "content-type": "application/json",
                authorization: `Bearer ${SIDECAR_AUTH_TOKEN}`,
            },
            // NO `limit` field — the sidecar has a fast path that activates
            // when limit>0 and caps at 100 candidates (newest first), which
            // would silently miss older blobs on a heavy wallet. We want
            // the exhaustive getOwnedObjects scan.
            body: JSON.stringify({ owner }),
        });
        if (resp.ok) {
            const data = (await resp.json()) as { blobs: QueryBlob[]; total: number };
            const map = new Map<string, string>();
            for (const b of data.blobs) {
                if (b.blobId && b.objectId) map.set(b.blobId, b.objectId);
            }
            return map;
        }
        // Auth rejection is global, not per-owner — fail the whole run loudly.
        if (resp.status === 401 || resp.status === 403) {
            throw new SidecarAuthError(
                `sidecar rejected auth (${resp.status}) — check SIDECAR_AUTH_TOKEN`,
            );
        }
        const bodyText = await resp.text();
        // The sidecar wraps upstream RPC 429/503 in a 500 whose body carries the
        // real status, so check both the HTTP code and the body text.
        const rateLimited = resp.status === 429 || resp.status === 503 ||
            /\b(429|503)\b/.test(bodyText);
        if (rateLimited && attempt < MAX_RETRIES) {
            const backoff = Math.min(30_000, 1000 * 2 ** attempt) + Math.floor(Math.random() * 500);
            console.warn(`[backfill] owner=${short(owner)} rate-limited (attempt ${attempt + 1}/${MAX_RETRIES}); backoff ${backoff}ms`);
            await sleep(backoff);
            attempt++;
            continue;
        }
        throw new Error(`query-blobs failed for owner=${owner}: ${resp.status} ${bodyText}`);
    }
}

async function main() {
    console.log(
        `[backfill] start network=${SUI_NETWORK} apply=${APPLY} ` +
            `owner=${ONLY_OWNER ?? "*"} limit=${ROW_LIMIT ?? "none"} sidecar=${SIDECAR_URL}`,
    );
    if (!APPLY) console.log("[backfill] DRY-RUN — no writes. Pass --apply to persist.");

    // Cross-check the sidecar's network matches our SUI_NETWORK env BEFORE
    // opening the DB pool / doing any work. Bails hard on mismatch.
    await assertSidecarNetworkMatches();

    const sql = postgres(DATABASE_URL, { max: 4 });

    // Sanity-check: confirm migration 010 has been applied to this DB. Without
    // the end_epoch + object_id columns the script can't run; without a clear
    // up-front error the operator sees a raw "column does not exist" postgres
    // stack from much further down. Catch it here and tell them why.
    try {
        const cols: { column_name: string }[] = await sql`
            SELECT column_name FROM information_schema.columns
            WHERE table_schema = 'public' AND table_name = 'vector_entries'
              AND column_name IN ('end_epoch', 'object_id')
        `;
        const have = new Set(cols.map((r) => r.column_name));
        const missing = ["end_epoch", "object_id"].filter((c) => !have.has(c));
        if (missing.length > 0) {
            console.error(
                `[backfill] FATAL: vector_entries is missing column(s) [${missing.join(", ")}] — ` +
                    `migration 010 has not been applied to ${maskUrl(DATABASE_URL)}. ` +
                    `Deploy the server (which auto-runs 010) before running the backfill.`,
            );
            await sql.end({ timeout: 5 });
            process.exit(1);
        }
    } catch (e: any) {
        console.error(`[backfill] FATAL: schema check failed: ${e?.message || e}`);
        await sql.end({ timeout: 5 });
        process.exit(1);
    }
    const suiClient = new SuiJsonRpcClient({
        url: process.env.SUI_RPC_URL || getJsonRpcFullnodeUrl(SUI_NETWORK),
        network: SUI_NETWORK,
    });
    const walrusClient = new WalrusClient({ network: SUI_NETWORK, suiClient: suiClient as any });

    // Drain the pool on every exit path — including a re-thrown
    // SidecarAuthError or an unexpected DB error mid-run.
    try {
    // Rows needing backfill: production only (plaintext IS NULL), not yet set.
    const rows: LegacyRow[] = await sql`
        SELECT id, owner, blob_id, object_id
        FROM vector_entries
        WHERE end_epoch IS NULL
          AND plaintext IS NULL
          ${ONLY_OWNER ? sql`AND owner = ${ONLY_OWNER}` : sql``}
        ORDER BY owner, id
        ${ROW_LIMIT ? sql`LIMIT ${ROW_LIMIT}` : sql``}
    `;
    console.log(`[backfill] ${rows.length} candidate row(s)`);

    // Group by owner so each owner's expensive blob scan runs once.
    const byOwner = new Map<string, LegacyRow[]>();
    for (const r of rows) {
        const list = byOwner.get(r.owner) ?? [];
        list.push(r);
        byOwner.set(r.owner, list);
    }

    const stats = { set: 0, markedGone: 0, leftNull: 0, skippedHaveObjId: 0, errors: 0 };

    let ownerIdx = 0;
    for (const [owner, ownerRows] of byOwner) {
        // Pace owners apart so consecutive wallet scans don't trip the RPC
        // 429 limit. Skipped before the first owner.
        if (ownerIdx > 0 && OWNER_DELAY_MS > 0) await sleep(OWNER_DELAY_MS);
        ownerIdx++;

        // Build the blob_id → object_id map for rows that don't already carry it.
        let ownerMap: Map<string, string> | null = null;
        const needResolve = ownerRows.some((r) => !r.object_id);
        if (needResolve) {
            try {
                ownerMap = await resolveOwnerBlobMap(owner);
                console.log(`[backfill] owner=${short(owner)} resolved ${ownerMap.size} blob(s) on-chain`);
            } catch (e: any) {
                // Auth failure is global config, not a per-owner transient —
                // abort the whole run so it's not mistaken for a partial success.
                if (e instanceof SidecarAuthError) throw e;
                console.error(`[backfill] owner=${short(owner)} resolve FAILED (leaving rows NULL for re-run): ${e?.message || e}`);
                stats.errors += ownerRows.length;
                stats.leftNull += ownerRows.length;
                continue;
            }
        }

        for (const row of ownerRows) {
            const objectId = row.object_id ?? ownerMap?.get(row.blob_id) ?? null;
            if (row.object_id) stats.skippedHaveObjId++;

            if (!objectId) {
                // Object id unresolvable. The blob isn't owned by this wallet
                // anymore (transferred away) or never appeared in the scan.
                // We can't confirm it's gone, so DON'T guess — leave NULL.
                console.warn(`[backfill] row=${row.id} blob=${short(row.blob_id)} owner=${short(owner)} unresolved → leave NULL`);
                stats.leftNull++;
                continue;
            }

            let endEpoch: number | null = null;
            try {
                const blobObj = await walrusClient.getBlobObject(objectId);
                const raw = (blobObj as any)?.storage?.end_epoch;
                endEpoch = typeof raw === "number" ? raw : Number(raw);
                if (!Number.isFinite(endEpoch)) endEpoch = null;
            } catch (e: any) {
                // Asymmetric, IRREVERSIBLE decision: distinguish "the blob is
                // genuinely gone" (write end_epoch=0 ⇒ filtered from recall
                // forever; the re-run guard `WHERE end_epoch IS NULL` will
                // never revisit it) from "transient failure" (leave NULL ⇒
                // safe, picked up on the next pass).
                //
                // We classify on the SDK's structured error code, not on the
                // error message text. @mysten/sui throws `ObjectError` with
                // `.code ∈ {notExists, deleted, dynamicFieldNotFound,
                // displayError, unknown}` — only `notExists` and `deleted`
                // are unambiguously "gone". Everything else (transport
                // 429/503, unknown, display errors) is treated as transient.
                // The message regex is a fallback for non-ObjectError throws
                // and even then only fires on the two confirmed phrasings.
                const code: string | undefined =
                    typeof e?.code === "string" ? e.code : undefined;
                const msg = String(e?.message || e);
                const goneByCode = code === "notExists" || code === "deleted";
                const goneByMessage =
                    code === undefined &&
                    /\bobject\b.*\b(does not exist|has been deleted)\b/i.test(msg);
                if (goneByCode || goneByMessage) {
                    endEpoch = 0;
                    console.warn(`[backfill] row=${row.id} blob GONE (${code ?? "by-message"}) → end_epoch=0`);
                } else {
                    console.error(`[backfill] row=${row.id} getBlobObject error (leave NULL, retry later) code=${code ?? "-"}: ${msg}`);
                    stats.errors++;
                    stats.leftNull++;
                    continue;
                }
            }

            if (endEpoch === null) {
                console.warn(`[backfill] row=${row.id} blobObject had no usable end_epoch → leave NULL`);
                stats.leftNull++;
                continue;
            }

            if (endEpoch === 0) stats.markedGone++;
            else stats.set++;

            const verb = endEpoch === 0 ? "GONE→0" : `end_epoch=${endEpoch}`;
            console.log(`[backfill] ${APPLY ? "SET " : "WOULD "}row=${row.id} obj=${short(objectId)} ${verb}`);

            if (APPLY) {
                // Re-runnable guard: only fill if still NULL (never clobber a
                // value Part B wrote since this run started).
                await sql`
                    UPDATE vector_entries
                    SET end_epoch = ${endEpoch}, object_id = COALESCE(object_id, ${objectId})
                    WHERE id = ${row.id} AND end_epoch IS NULL
                `;
            }
        }
    }

    console.log(
        `[backfill] done. set=${stats.set} markedGone=${stats.markedGone} ` +
            `leftNull=${stats.leftNull} alreadyHadObjId=${stats.skippedHaveObjId} errors=${stats.errors}` +
            (APPLY ? "" : "  (dry-run — nothing written)"),
    );
    } finally {
        await sql.end({ timeout: 5 });
    }
}

function short(s: string): string {
    return s.length > 12 ? `${s.slice(0, 6)}…${s.slice(-4)}` : s;
}

// Hide the password in a DB URL for log/error output ("postgres://u:***@h:p/db").
function maskUrl(url: string): string {
    return url.replace(/(:\/\/[^:/@]+:)[^@]+(@)/, "$1***$2");
}

main().catch((e) => {
    console.error("[backfill] FATAL:", e);
    process.exit(1);
});
