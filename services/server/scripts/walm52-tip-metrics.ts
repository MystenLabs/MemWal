/**
 * WALM-52: pure helpers for extracting Walrus upload-relay tip outflow from
 * Sui register-tx balance changes. Kept in a standalone module so unit tests
 * can exercise the parsing without spinning up the sidecar.
 */

export type SuiBalanceChangeOwner =
    | { AddressOwner: string }
    | { ObjectOwner: string }
    | { Shared: unknown }
    | "Immutable"
    | unknown;

export interface SuiBalanceChange {
    amount: string;
    coinType: string;
    owner: SuiBalanceChangeOwner;
}

export const SUI_COIN_TYPE = "0x2::sui::SUI";

function normalizeSuiAddress(addr: string): string {
    return addr.trim().toLowerCase();
}

/**
 * Returns the positive SUI MIST amount transferred to `tipRecipient` in the
 * given balance changes. Returns 0n when:
 *   - tipRecipient is null/empty (no-tip mode)
 *   - changes is null/empty (RPC returned no balance changes)
 *   - no positive SUI change is addressed to tipRecipient
 *
 * Negative deltas, non-SUI coin types, and non-AddressOwner entries are ignored.
 */
export function extractTipMistFromBalanceChanges(
    changes: SuiBalanceChange[] | null | undefined,
    tipRecipient: string | null | undefined,
): bigint {
    if (!tipRecipient || !changes || changes.length === 0) return 0n;
    const target = normalizeSuiAddress(tipRecipient);
    let total = 0n;
    for (const change of changes) {
        if (change.coinType !== SUI_COIN_TYPE) continue;
        const owner = change.owner as { AddressOwner?: unknown };
        if (typeof owner?.AddressOwner !== "string") continue;
        if (normalizeSuiAddress(owner.AddressOwner) !== target) continue;
        let amount: bigint;
        try {
            amount = BigInt(change.amount);
        } catch {
            continue;
        }
        if (amount > 0n) total += amount;
    }
    return total;
}

/**
 * Extract a stable, low-cardinality host label from a relay URL for Prometheus
 * labels. Falls back to the raw value if URL parsing fails.
 */
export function relayHostLabel(rawUrl: string): string {
    try {
        return new URL(rawUrl).host;
    } catch {
        return rawUrl;
    }
}

/**
 * Escape a label value per the Prometheus text exposition format:
 *   backslash, double-quote, and newline must be escaped.
 */
export function escapePromLabel(value: string): string {
    return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n");
}

export interface WalmTipMetricsState {
    uploadsTotal: number;
    tipMistTotal: bigint;
}

export interface WalmTipMetricsLabels {
    host: string;
    sendTip: boolean;
}

/**
 * Render the two WALM-52 counters in Prometheus 0.0.4 text exposition format.
 * Single instance, single label set per process — no per-label aggregation.
 */
export function renderWalmTipMetrics(
    state: WalmTipMetricsState,
    labels: WalmTipMetricsLabels,
): string {
    const host = escapePromLabel(labels.host);
    const sendTip = labels.sendTip ? "true" : "false";
    const labelSet = `{host="${host}",send_tip="${sendTip}"}`;
    return [
        "# HELP walrus_upload_relay_uploads_total Register-confirmed Walrus upload-relay attempts since sidecar start.",
        "# TYPE walrus_upload_relay_uploads_total counter",
        `walrus_upload_relay_uploads_total${labelSet} ${state.uploadsTotal}`,
        "# HELP walrus_upload_relay_tip_mist_total SUI MIST paid as upload-relay tip since sidecar start (parsed from register-tx balance changes).",
        "# TYPE walrus_upload_relay_tip_mist_total counter",
        `walrus_upload_relay_tip_mist_total${labelSet} ${state.tipMistTotal.toString()}`,
        "",
    ].join("\n");
}
