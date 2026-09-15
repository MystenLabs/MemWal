import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { MemWalSession } from "../auth.js";
import { TOOL_METADATA } from "./annotations.js";
import { wrapTool } from "./util.js";

const RESTORE_INPUT = {
    namespace: z
        .string()
        .min(1)
        .describe("Namespace bucket to restore. Server re-indexes every blob in this namespace."),
    limit: z
        .number()
        .int()
        .min(1)
        .max(100)
        .default(10)
        .describe("Max number of memories to re-index (1-100)."),
} as const;

/** Sidecar `/walrus/query-blobs` cap is `min(limit*5, 100)`; raising `limit` expands it only while `limit < 20`. */
const SIDECAR_CAP_SATURATES_AT_LIMIT = 20;

/**
 * memwal_restore — re-index a namespace by re-downloading every blob from
 * Walrus, SEAL-decrypting, and re-embedding into the relayer's vector store.
 *
 * Use when: the user's local search index is empty / corrupted, or when
 * switching servers. After restore, `memwal_recall` returns fresh results.
 * The tool returns counts and the API's truncation signal; it does NOT
 * stream back the decrypted memory texts.
 */
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
    // Nothing was discovered for this namespace at all. `truncated` can still
    // be true here, because the sidecar's candidate cap is owner-wide: blobs
    // in OTHER namespaces can saturate it and `restore_is_truncated` then
    // reports truncation while this namespace's page is empty
    // (services/server/src/routes/admin.rs, the `limit < 20` arm).
    //
    // This must not claim blobs remain. Nothing has been seen that says so,
    // and the namespace may simply be empty. Observed on 0.0.13-dev.6 as
    // `total=0 restored=0 skipped=0 failed=0 truncated=true` followed by
    // "More blobs remain to restore", which sends an agent looping on a
    // namespace that has nothing in it.
    const emptyPage = result.total === 0;
    // WALM-480: truncated + no success + uncounted blobs → transients
    // (download/embed blip). Raising limit does not fix that; retry does.
    // Guarded on a non-empty page: with `total === 0` the comparison
    // `skipped + failed < total` is `0 < 0`, so an empty page could never
    // reach this branch and fell through to the "raise limit" one instead.
    const transientPage =
        truncated &&
        !emptyPage &&
        result.restored === 0 &&
        result.skipped + failed < result.total;
    const hint = !truncated
        ? emptyPage
            ? "\n  Nothing to restore — no blobs found on chain for this namespace."
            : "\n  truncated=false is not proof the sidecar saw every blob."
        : emptyPage
          ? "\n  ⚠️ No blobs found for this namespace, but the sidecar's candidate cap " +
            "(shared across all your namespaces) was reached, so it may not have looked here. " +
            (limit < SIDECAR_CAP_SATURATES_AT_LIMIT
                ? "Raise limit to widen the search. If it stays 0, the namespace is empty — check the spelling."
                : "limit is already at the cap, so this namespace is almost certainly empty — check the spelling.")
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

export function registerRestoreTool(
    server: McpServer,
    session: MemWalSession
): void {
    server.registerTool(
        "memwal_restore",
        {
            ...TOOL_METADATA.memwal_restore,
            description:
                "Recovery tool. Re-index a namespace from Walrus blobs back into the relayer's search index — use when memwal_recall unexpectedly returns nothing even though facts were saved before (e.g. on a new machine, a fresh relayer, or after switching servers). Returns restored/skipped/failed/total plus truncated — does not return memory texts. truncated=true is known-retryable-incomplete: retry the same limit on a download/embed blip; raising limit expands the sidecar cap only while limit < 20; after the cap saturates, truncation follows this call's missing-blob page. truncated=false is not completeness; WALM-451 will add sourceCapped. Call memwal_recall afterwards to query the rebuilt index.",
            inputSchema: RESTORE_INPUT,
        },
        wrapTool<{ namespace: string; limit: number }>(session, "memwal_restore", async ({ namespace, limit }) => {
            const result = await session.memwal.restore(namespace, limit);
            return {
                content: [
                    {
                        type: "text",
                        text: formatRestoreResult(result, limit),
                    },
                ],
            };
        })
    );
}
