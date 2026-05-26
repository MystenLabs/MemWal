#!/usr/bin/env -S npx tsx
/**
 * WALM-52: on-chain audit of upload-relay tip outflow from pool wallets.
 *
 * Independent of any metric the sidecar emits — queries Sui RPC directly so it
 * can validate (or contradict) the `walrus_upload_relay_tip_mist_total` counter
 * and reproduce Henry's "2.67 SUI in 12h" measurement.
 *
 * Output: CSV to stdout —
 *   date,pool_address,relay_tip_mist,relay_tip_sui,upload_count_estimate,other_mist
 *
 * Inputs:
 *   --pool-address <0x...> (repeatable) OR env WALRUS_TIP_POOL_ADDRESSES (comma-sep)
 *   --relay-tip-address <0x...> (repeatable) OR env WALRUS_RELAY_TIP_ADDRESSES (comma-sep)
 *   --from <ISO-8601>   default: now - 24h
 *   --to   <ISO-8601>   default: now
 *   --network <mainnet|testnet>   default: mainnet
 *   --rpc-url <url>     optional override of Sui RPC URL
 *   --page-size <n>     default: 50 (RPC max is typically 50)
 *
 * Example:
 *   # 1. Get the current relay tip recipient (it's per-relay config, not static).
 *   curl -s https://upload-relay.mainnet.walrus.space/v1/tip-config | jq '.send_tip.address'
 *   # 2. Run the audit with that address (today's mainnet value shown; verify before use).
 *   npx tsx walrus-tip-audit.ts \
 *     --pool-address 0xaaa... --pool-address 0xbbb... \
 *     --relay-tip-address 0x765a6ff2c13b47e2603416d0b5a156df498a5c51bc8085be3838e43e06086256 \
 *     --from 2026-05-24T05:00:00Z --to 2026-05-25T05:00:00Z
 *
 * Current known relay-tip recipients (curl /v1/tip-config to confirm — they can change):
 *   mainnet: 0x765a6ff2c13b47e2603416d0b5a156df498a5c51bc8085be3838e43e06086256
 *   testnet: 0x4b6a7439159cf10533147fc3d678cf10b714f2bc998f6cb1f1b0b9594cdc52b6
 */

import { resolve as resolvePath } from "node:path";
import { pathToFileURL } from "node:url";

import { SuiJsonRpcClient, getJsonRpcFullnodeUrl } from "@mysten/sui/jsonRpc";

import {
    SUI_COIN_TYPE,
    extractTipMistFromBalanceChanges,
    type SuiBalanceChange,
} from "./walm52-tip-metrics.js";

// ============================================================
// Pure helpers (testable without Sui RPC)
// ============================================================

export interface AuditWindow {
    fromMs: number;
    toMs: number;
}

export function parseWindow(
    fromArg: string | undefined,
    toArg: string | undefined,
    now: Date = new Date(),
): AuditWindow {
    const toMs = toArg ? Date.parse(toArg) : now.getTime();
    if (Number.isNaN(toMs)) throw new Error(`--to is not a valid ISO date: ${toArg}`);
    const defaultFrom = toMs - 24 * 60 * 60 * 1000;
    const fromMs = fromArg ? Date.parse(fromArg) : defaultFrom;
    if (Number.isNaN(fromMs)) throw new Error(`--from is not a valid ISO date: ${fromArg}`);
    if (fromMs >= toMs) throw new Error(`--from (${fromArg}) must be earlier than --to (${toArg})`);
    return { fromMs, toMs };
}

export function dateStem(ms: number): string {
    return new Date(ms).toISOString().slice(0, 10);
}

export interface AuditTxClassification {
    relayTipMist: bigint;
    poolOutflowMist: bigint;
    hadRelayTip: boolean;
}

/**
 * Classify a single tx's contribution from one pool address's perspective:
 *   - relayTipMist:  positive SUI delta to any known tip recipient
 *   - poolOutflowMist:  magnitude of negative SUI delta owned by poolAddress
 *   - hadRelayTip:  true iff this tx paid a non-zero tip (= 1 upload)
 *
 * "other" outflow is derived at aggregation time as poolOutflow - relayTip.
 */
export function classifyTx(
    balanceChanges: SuiBalanceChange[] | null | undefined,
    poolAddress: string,
    relayTipAddresses: ReadonlySet<string>,
): AuditTxClassification {
    let relayTipMist = 0n;
    for (const tipAddr of relayTipAddresses) {
        relayTipMist += extractTipMistFromBalanceChanges(balanceChanges, tipAddr);
    }
    let poolOutflowMist = 0n;
    if (balanceChanges) {
        const target = poolAddress.trim().toLowerCase();
        for (const change of balanceChanges) {
            if (change.coinType !== SUI_COIN_TYPE) continue;
            const owner = change.owner as { AddressOwner?: unknown };
            if (typeof owner?.AddressOwner !== "string") continue;
            if (owner.AddressOwner.trim().toLowerCase() !== target) continue;
            let amount: bigint;
            try { amount = BigInt(change.amount); } catch { continue; }
            if (amount < 0n) poolOutflowMist += -amount;
        }
    }
    return { relayTipMist, poolOutflowMist, hadRelayTip: relayTipMist > 0n };
}

export interface DailyBucket {
    date: string;
    poolAddress: string;
    relayTipMist: bigint;
    poolOutflowMist: bigint;
    uploadCount: number;
}

export function bucketKey(date: string, poolAddress: string): string {
    return `${date}\t${poolAddress.toLowerCase()}`;
}

export function emitCsv(buckets: Iterable<DailyBucket>): string {
    const header = "date,pool_address,relay_tip_mist,relay_tip_sui,upload_count_estimate,other_mist";
    const rows: string[] = [header];
    const sorted = [...buckets].sort((a, b) => a.date.localeCompare(b.date) || a.poolAddress.localeCompare(b.poolAddress));
    for (const b of sorted) {
        const otherMist = b.poolOutflowMist > b.relayTipMist ? b.poolOutflowMist - b.relayTipMist : 0n;
        const tipSui = (Number(b.relayTipMist) / 1e9).toFixed(6);
        rows.push([b.date, b.poolAddress.toLowerCase(), b.relayTipMist.toString(), tipSui, b.uploadCount.toString(), otherMist.toString()].join(","));
    }
    return rows.join("\n") + "\n";
}

// ============================================================
// CLI parsing
// ============================================================

interface CliArgs {
    poolAddresses: string[];
    relayTipAddresses: string[];
    from?: string;
    to?: string;
    network: "mainnet" | "testnet";
    rpcUrl?: string;
    pageSize: number;
}

const HELP_TEXT = `walrus-tip-audit — on-chain audit of WALM-52 upload-relay tip outflow.

Usage:
  npx tsx services/server/scripts/walrus-tip-audit.ts \\
    --pool-address 0x<addr> [--pool-address 0x<addr>...] \\
    --relay-tip-address 0x<addr> [--relay-tip-address 0x<addr>...] \\
    [--from <ISO-8601>] [--to <ISO-8601>] \\
    [--network mainnet|testnet] [--rpc-url <url>] [--page-size <1-50>]

Required:
  --pool-address          Sui address of a pool wallet (repeatable).
                          Env fallback: WALRUS_TIP_POOL_ADDRESSES (comma-sep).
  --relay-tip-address     Sui address of a known relay tip recipient (repeatable).
                          Env fallback: WALRUS_RELAY_TIP_ADDRESSES (comma-sep).

Optional:
  --from / --to           ISO timestamps. Default: last 24h.
  --network               mainnet (default) or testnet.
  --rpc-url               Override the Sui JSON-RPC URL.
  --page-size             Sui RPC page size, 1..50 (default 50).
  -h, --help              Print this help and exit.

Output: CSV to stdout with header
  date,pool_address,relay_tip_mist,relay_tip_sui,upload_count_estimate,other_mist
`;

function splitEnvList(name: string): string[] {
    const v = process.env[name];
    return v ? v.split(",").map((s) => s.trim()).filter(Boolean) : [];
}

function parseCliArgs(argv: string[]): CliArgs {
    const poolAddresses: string[] = [];
    const relayTipAddresses: string[] = [];
    let from: string | undefined;
    let to: string | undefined;
    let network: "mainnet" | "testnet" = "mainnet";
    let rpcUrl: string | undefined;
    let pageSize = 50;
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        switch (a) {
            case "--pool-address": poolAddresses.push(argv[++i]); break;
            case "--relay-tip-address": relayTipAddresses.push(argv[++i]); break;
            case "--from": from = argv[++i]; break;
            case "--to": to = argv[++i]; break;
            case "--network": network = argv[++i] as "mainnet" | "testnet"; break;
            case "--rpc-url": rpcUrl = argv[++i]; break;
            case "--page-size": pageSize = Number.parseInt(argv[++i], 10); break;
            case "-h":
            case "--help":
                process.stderr.write(HELP_TEXT);
                process.exit(0);
            default:
                throw new Error(`Unknown arg: ${a}`);
        }
    }
    for (const addr of splitEnvList("WALRUS_TIP_POOL_ADDRESSES")) {
        if (!poolAddresses.includes(addr)) poolAddresses.push(addr);
    }
    for (const addr of splitEnvList("WALRUS_RELAY_TIP_ADDRESSES")) {
        if (!relayTipAddresses.includes(addr)) relayTipAddresses.push(addr);
    }
    if (poolAddresses.length === 0) {
        throw new Error("at least one --pool-address (or WALRUS_TIP_POOL_ADDRESSES) is required");
    }
    if (relayTipAddresses.length === 0) {
        throw new Error("at least one --relay-tip-address (or WALRUS_RELAY_TIP_ADDRESSES) is required");
    }
    if (network !== "mainnet" && network !== "testnet") {
        throw new Error(`--network must be mainnet or testnet, got: ${network}`);
    }
    if (!(pageSize > 0 && pageSize <= 50)) {
        throw new Error(`--page-size must be in (0, 50], got: ${pageSize}`);
    }
    return { poolAddresses, relayTipAddresses, from, to, network, rpcUrl, pageSize };
}

// ============================================================
// Main — walk Sui RPC and emit CSV
// ============================================================

async function main(): Promise<void> {
    const args = parseCliArgs(process.argv.slice(2));
    const window = parseWindow(args.from, args.to);
    const url = args.rpcUrl || getJsonRpcFullnodeUrl(args.network);
    const client = new SuiJsonRpcClient({ url, network: args.network });
    const relayTipSet: ReadonlySet<string> = new Set(args.relayTipAddresses.map((a) => a.trim().toLowerCase()));
    const buckets = new Map<string, DailyBucket>();

    for (const poolAddress of args.poolAddresses) {
        let cursor: string | null | undefined = undefined;
        let stop = false;
        while (!stop) {
            const page = await client.queryTransactionBlocks({
                filter: { FromAddress: poolAddress },
                options: { showBalanceChanges: true },
                order: "descending",
                limit: args.pageSize,
                cursor: cursor ?? null,
            });
            for (const tx of page.data) {
                const ts = tx.timestampMs ? Number(tx.timestampMs) : 0;
                if (ts === 0) continue;
                if (ts < window.fromMs) { stop = true; break; }
                if (ts > window.toMs) continue;
                const cls = classifyTx(tx.balanceChanges as unknown as SuiBalanceChange[] | null, poolAddress, relayTipSet);
                const date = dateStem(ts);
                const key = bucketKey(date, poolAddress);
                let bucket = buckets.get(key);
                if (!bucket) {
                    bucket = { date, poolAddress, relayTipMist: 0n, poolOutflowMist: 0n, uploadCount: 0 };
                    buckets.set(key, bucket);
                }
                bucket.relayTipMist += cls.relayTipMist;
                bucket.poolOutflowMist += cls.poolOutflowMist;
                if (cls.hadRelayTip) bucket.uploadCount += 1;
            }
            if (!page.hasNextPage || !page.nextCursor) break;
            cursor = page.nextCursor;
        }
    }

    process.stdout.write(emitCsv(buckets.values()));
}

// Main-guard: import.meta.url is URL-encoded (e.g. file:///path%20with%20space/...)
// while process.argv[1] is the raw filesystem path. `pathToFileURL` does the
// same encoding so the comparison works for paths with spaces or unicode.
export function isCliEntrypoint(metaUrl: string, argv1: string | undefined): boolean {
    if (!argv1) return false;
    try {
        return metaUrl === pathToFileURL(resolvePath(argv1)).href;
    } catch {
        return false;
    }
}

if (isCliEntrypoint(import.meta.url, process.argv[1])) {
    main().catch((err) => {
        console.error(`walrus-tip-audit error: ${err?.message || err}`);
        process.exit(1);
    });
}
