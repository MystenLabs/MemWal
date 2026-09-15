/**
 * Tool-result copy for the stdio memory tools.
 *
 * Shapes match the relayer sidecar (`services/server/scripts/mcp/tools/`)
 * so the agent ↔ stdio contract does not change when calls go through the
 * SDK instead of the SSE bridge.
 */

const SIDECAR_CAP_SATURATES_AT_LIMIT = 20;

/** Canonical Walruscan explorer URL for a blob. */
export function walruscanBlobUrl(blobId: string): string {
    const network = process.env.SUI_NETWORK === "testnet" ? "testnet" : "mainnet";
    return `https://walruscan.com/${network}/blob/${blobId}`;
}

/** One-line footer for write-tool results that list several blob ids. */
export function explorerFooter(): string {
    return `Explorer: ${walruscanBlobUrl("<blob_id>")} for any blob_id above.`;
}

/**
 * Name the relayer this process dialled in a `memwal_health` result.
 *
 * Rewrites an existing `relayer=` field rather than appending a second one.
 */
export function annotateHealthResult(
    result: { content?: unknown; isError?: unknown },
    relayerUrl: string,
): void {
    if (result.isError) return;
    if (!Array.isArray(result.content)) return;
    const block = (result.content as { type?: string; text?: string }[]).find(
        (c) => c?.type === "text" && typeof c.text === "string",
    );
    if (!block || typeof block.text !== "string") return;
    const existing = /\brelayer=\S+/;
    block.text = existing.test(block.text)
        ? block.text.replace(existing, `relayer=${relayerUrl}`)
        : `${block.text} relayer=${relayerUrl}`;
}

/** Key deciding whether two recall hits say the same thing. */
function dedupeKey(text: string): string {
    return text.trim().replace(/\s+/g, " ").toLowerCase();
}

/**
 * Collapse results carrying identical text, keeping the first (best-ranked)
 * occurrence.
 */
export function collapseDuplicates<T extends { text: string }>(
    results: T[],
): { unique: T[]; collapsed: number } {
    const seen = new Map<string, T>();
    for (const item of results) {
        const key = dedupeKey(item.text);
        if (!seen.has(key)) seen.set(key, item);
    }
    const unique = [...seen.values()];
    return { unique, collapsed: results.length - unique.length };
}

export function emptyRecallText(resultCount: number, dropped: number): string {
    if (resultCount > 0) {
        const unchecked =
            dropped > 0
                ? ` (${dropped} further ${dropped === 1 ? "match was" : "matches were"} never checked against the cutoff: they failed to download or decrypt.)`
                : "";
        return `All matching memories were outside maxDistance.${unchecked}`;
    }
    if (dropped > 0) {
        return `No matching memories could be returned (${dropped} matched but failed to download or decrypt). This is not an empty namespace.`;
    }
    return "No matching memories found.";
}

export function formatRecallLine(
    memory: { text: string; distance: number; created_at?: unknown },
    index: number,
): string {
    const score = (1 - memory.distance).toFixed(3);
    const distance = memory.distance.toFixed(3);
    const written = isoDateOrNull(memory.created_at);
    const stamp = written ? ` [written=${written}]` : "";
    return `${index + 1}. [score=${score} distance=${distance}]${stamp} ${memory.text}`;
}

function isoDateOrNull(value: unknown): string | null {
    if (typeof value !== "string") return null;
    const ms = Date.parse(value);
    if (Number.isNaN(ms)) return null;
    return new Date(ms).toISOString().slice(0, 10);
}

export function formatRecallResult(result: {
    results: { text: string; distance: number; created_at?: unknown }[];
    dropped_count?: number;
}): string {
    const droppedRaw = result.dropped_count;
    const dropped = typeof droppedRaw === "number" ? droppedRaw : 0;
    if (result.results.length === 0) {
        return emptyRecallText(0, dropped);
    }
    const { unique, collapsed } = collapseDuplicates(result.results);
    const lines = unique.map((m, i) => formatRecallLine(m, i));
    if (collapsed > 0) {
        lines.push(
            `\n(${collapsed} duplicate ${collapsed === 1 ? "copy" : "copies"} of the above collapsed; the same fact is stored more than once.)`,
        );
    }
    if (dropped > 0) {
        lines.push(
            `\n(${dropped} additional matches could not be decrypted and were omitted.)`,
        );
    }
    return lines.join("\n");
}

export function formatRestoreResult(
    result: {
        namespace: string;
        total: number;
        restored: number;
        skipped: number;
        failed?: number;
        truncated?: boolean;
    },
    limit = 10,
): string {
    const truncated = result.truncated === true;
    const failed = result.failed ?? 0;
    const transientPage =
        truncated && result.restored === 0 && result.skipped + failed < result.total;
    const hint = !truncated
        ? "\n  truncated=false is not proof the sidecar saw every blob."
        : transientPage
          ? "\n  ⚠️ This page did not restore (download/embed blip) — retry the same limit."
          : limit < SIDECAR_CAP_SATURATES_AT_LIMIT
            ? "\n  ⚠️ More blobs remain to restore — increase limit and call again."
            : "\n  ⚠️ Sidecar cap is saturated — truncation follows this call's missing-blob page; truncated is not completeness (WALM-451 sourceCapped).";
    return (
        `${truncated ? "Restore partially complete" : "Restore page finished"} for namespace "${result.namespace}":\n` +
        `  total=${result.total}  restored=${result.restored}  skipped=${result.skipped}  failed=${failed}  truncated=${truncated}` +
        hint
    );
}

export function formatHealthResult(result: {
    status: string;
    version: string;
    write_ready?: boolean;
    writes?: string;
}): string {
    const readyNote =
        result.write_ready === false
            ? " write_ready=false (writes unavailable)"
            : result.write_ready === true
              ? " write_ready=true"
              : "";
    const pausedNote = result.writes === "paused" ? " writes=paused" : "";
    return `Walrus Memory is reachable. status=${result.status} version=${result.version}${readyNote}${pausedNote}`;
}

/** Reply when the saved delegate key is rejected (HTTP 401). File is not wiped. */
export const UNAUTHORIZED_TEXT =
    "❌ Walrus Memory rejected the saved credentials (HTTP 401). The delegate key may have been revoked or is no longer registered on this account. Call `memwal_login` to sign in again — saved credentials were NOT modified.";

/** Reply once `memwal_logout` has dropped in-process credentials. */
export const SIGNED_OUT_TEXT =
    "❌ Signed out of Walrus Memory. Memory tools are unavailable on this connection until you call `memwal_login` again.";

export const LOGIN_INSTRUCTION = [
    "❌ Walrus Memory isn't signed in yet.",
    "",
    "**Easiest fix — call the `memwal_login` tool from this client.** It opens a browser,",
    "you approve the wallet sign-in, and on the next tool call this server picks up the",
    "credentials automatically. No terminal command, no client restart.",
    "",
    "Fallback (if your client cannot call `memwal_login`, or you prefer a CLI):",
    "",
    "    npx -y @mysten-incubation/memwal-mcp login",
    "",
    "(or `npx -y @mysten-incubation/memwal-mcp login --local` / `--dev` for a non-prod env)",
    "",
    "Either path opens a browser tab — click **Connect Sui Wallet** and approve the on-chain",
    "`add_delegate_key` transaction. Credentials land at `~/.memwal/credentials.json`.",
].join("\n");

export function formatToolError(err: unknown): { text: string; isError: true } {
    const e = err as { status?: number; message?: string; serverCode?: string };
    if (e.status === 401 || e.serverCode === "AUTH_REJECTED") {
        return { text: UNAUTHORIZED_TEXT, isError: true };
    }
    const msg = e.message ?? String(err);
    if (/\b401\b/.test(msg) && /unauthor/i.test(msg)) {
        return { text: UNAUTHORIZED_TEXT, isError: true };
    }
    return { text: `❌ Walrus Memory error: ${msg}`, isError: true };
}
