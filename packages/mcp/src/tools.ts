/**
 * Memory-tool schemas and SDK dispatch for the stdio MCP server.
 *
 * Names, descriptions, and result text match the relayer sidecar so the
 * agent contract does not change. Execution is `MemWal.create` + signed REST.
 */
import {
    annotateHealthResult,
    explorerFooter,
    formatHealthResult,
    formatRecallResult,
    formatRestoreResult,
    formatToolError,
    walruscanBlobUrl,
} from "./format.js";
import { applyDefaultNamespace } from "./namespace.js";
import type { MemoryClient } from "./session.js";

const SIGNED_OUT_REMEMBER =
    "Save a fact to the user's Walrus Memory personal memory. Call ONLY when the user explicitly asks to remember/save something. Pass the full, detailed text — never summarize.";
const SIGNED_IN_REMEMBER =
    "Save a durable fact about the user or project to their Walrus Memory. Call this PROACTIVELY whenever the user states a preference, decision, constraint, correction, identity detail, or recurring workflow — even if they did not say 'remember this'. Skip one-off tasks, the current file or bug, and small talk. Pass the full statement; do not summarize. To save several facts at once, use memwal_remember_bulk instead.";
const SIGNED_OUT_RECALL =
    "Search the user's Walrus Memory for facts relevant to a query. Returns matching memories ranked by relevance.";
const SIGNED_IN_RECALL =
    "Search the user's Walrus Memory for relevant facts before responding. Call this PROACTIVELY at the start of a task, or whenever the user references past work, prior decisions, their preferences, or anything you may have stored earlier — don't wait to be asked. A single focused query is usually enough — recall is a real retrieval over encrypted storage, so do NOT fire multiple redundant searches for the same question. Returns matching memories ranked by relevance.";

const LOGIN_TOOL = {
    name: "memwal_login",
    title: "Sign In to Walrus Memory",
    annotations: { readOnlyHint: false, destructiveHint: false },
    description:
        "Sign this MCP client into your Walrus Memory account by opening a browser. Run once when the agent reports Walrus Memory is not signed in. Opens the dashboard in the default browser, waits for wallet approval, then writes credentials to ~/.memwal/credentials.json. Other memwal_* tools become usable on the next call after a successful login.",
    inputSchema: {
        type: "object",
        properties: {},
        additionalProperties: false,
    },
} as const;

const LOGOUT_TOOL = {
    name: "memwal_logout",
    title: "Sign Out of Walrus Memory",
    annotations: { readOnlyHint: false, destructiveHint: false },
    description:
        "Sign out of Walrus Memory: removes the saved credentials from this machine (~/.memwal/credentials.json) AND drops this connection's in-process client, so memory tools stop working until you call memwal_login again. The on-chain delegate key registration is NOT revoked — visit the Walrus Memory dashboard to remove it from your account if needed.",
    inputSchema: {
        type: "object",
        properties: {},
        additionalProperties: false,
    },
} as const;

function buildToolDefinitions(proactive: boolean) {
    return [
        {
            name: "memwal_remember",
            title: "Remember a Fact",
            annotations: { readOnlyHint: false, destructiveHint: false },
            description: proactive ? SIGNED_IN_REMEMBER : SIGNED_OUT_REMEMBER,
            inputSchema: {
                type: "object",
                properties: {
                    text: { type: "string", minLength: 1 },
                    namespace: { type: "string" },
                },
                required: ["text"],
                additionalProperties: false,
            },
        },
        {
            name: "memwal_remember_bulk",
            title: "Remember Multiple Facts",
            annotations: { readOnlyHint: false, destructiveHint: false },
            description:
                "Save multiple durable facts in one call. Use when you learned several distinct facts at once (onboarding details, a list of preferences, decisions from a discussion). Pass an array of complete fact statements (max 20) — do not summarize. Prefer this over repeated memwal_remember calls.",
            inputSchema: {
                type: "object",
                properties: {
                    facts: {
                        type: "array",
                        items: { type: "string", minLength: 1 },
                        minItems: 1,
                        maxItems: 20,
                    },
                    namespace: { type: "string" },
                },
                required: ["facts"],
                additionalProperties: false,
            },
        },
        {
            name: "memwal_recall",
            title: "Recall Memories",
            annotations: { readOnlyHint: true, destructiveHint: false },
            description: proactive ? SIGNED_IN_RECALL : SIGNED_OUT_RECALL,
            inputSchema: {
                type: "object",
                properties: {
                    query: { type: "string", minLength: 1 },
                    limit: { type: "integer", minimum: 1, maximum: 100, default: 10 },
                    namespace: { type: "string" },
                    maxDistance: {
                        type: "number",
                        minimum: 0,
                        description:
                            "Optional cosine-distance cutoff (low = similar; 0 = identical). Hits with distance >= maxDistance are dropped. Omit to apply no cutoff. Displayed score is 1 - distance (high = similar); do not treat score as the cutoff.",
                    },
                },
                required: ["query"],
                additionalProperties: false,
            },
        },
        {
            name: "memwal_analyze",
            title: "Analyze and Remember",
            annotations: { readOnlyHint: false, destructiveHint: true },
            description:
                "Extract memorable facts from a longer passage of text (preferences, habits, biographical info, constraints) and save each as a separate Walrus Memory memory. Use this when you want MemWal's LLM to split the facts out of a transcript or notes for you; if you already know the exact facts, use memwal_remember or memwal_remember_bulk instead.",
            inputSchema: {
                type: "object",
                properties: {
                    text: { type: "string", minLength: 1 },
                    namespace: { type: "string" },
                },
                required: ["text"],
                additionalProperties: false,
            },
        },
        {
            name: "memwal_restore",
            title: "Restore Memory Index",
            annotations: { readOnlyHint: false, destructiveHint: false },
            description:
                "Recovery tool. Re-index a namespace from Walrus blobs back into the relayer's search index \u2014 use when memwal_recall unexpectedly returns nothing even though facts were saved before (e.g. on a new machine, a fresh relayer, or after switching servers). Returns restored/skipped/failed/total plus truncated \u2014 does not return memory texts. truncated=true is known-retryable-incomplete: retry the same limit on a download/embed blip; raising limit expands the sidecar cap only while limit < 20; after the cap saturates, truncation follows this call's missing-blob page. truncated=false is not completeness; WALM-451 will add sourceCapped. Call memwal_recall afterwards to query the rebuilt index.",
            inputSchema: {
                type: "object",
                properties: {
                    namespace: { type: "string", minLength: 1 },
                    limit: { type: "integer", minimum: 1, maximum: 100, default: 10 },
                },
                required: ["namespace"],
                additionalProperties: false,
            },
        },
        {
            name: "memwal_health",
            title: "Check Walrus Memory Health",
            annotations: { readOnlyHint: true, destructiveHint: false },
            description:
                "Quick connectivity check for Walrus Memory. Calls the relayer's lightweight health endpoint (no search, no decryption) and returns its status and version. Use this to confirm the server is reachable — do NOT use memwal_recall for health checks, which is a full and slow retrieval.",
            inputSchema: {
                type: "object",
                properties: {},
                additionalProperties: false,
            },
        },
        LOGIN_TOOL,
    ];
}

/** Signed-in tool list (proactive wording + logout). */
export const TOOL_DEFINITIONS = [...buildToolDefinitions(true), LOGOUT_TOOL];

/** Signed-out tool list (conservative wording, login only). */
export const SIGNED_OUT_TOOL_DEFINITIONS = buildToolDefinitions(false);

const MEMORY_TOOLS = new Set([
    "memwal_remember",
    "memwal_remember_bulk",
    "memwal_recall",
    "memwal_analyze",
    "memwal_restore",
    "memwal_health",
]);

export function isMemoryTool(name: string): boolean {
    return MEMORY_TOOLS.has(name);
}

function requireString(value: unknown, field: string): string {
    if (typeof value !== "string" || value.trim() === "") {
        throw new Error(`${field} is required`);
    }
    return value;
}

function optionalString(value: unknown): string | undefined {
    return typeof value === "string" && value.trim() !== "" ? value : undefined;
}

function optionalLimit(value: unknown, fallback: number): number {
    if (value == null) return fallback;
    const n = typeof value === "number" ? value : Number(value);
    if (!Number.isInteger(n) || n < 1) return fallback;
    return Math.min(n, 100);
}

function optionalMaxDistance(value: unknown): number | undefined {
    if (value == null) return undefined;
    const n = typeof value === "number" ? value : Number(value);
    if (!Number.isFinite(n) || n < 0) {
        throw new Error("maxDistance must be a number >= 0");
    }
    return n;
}

/**
 * Run a memory tool against the SDK client. Caller guarantees `client` is live.
 */
export async function runMemoryTool(
    name: string,
    rawArgs: Record<string, unknown>,
    defaultNamespace: string | undefined,
    client: MemoryClient,
    relayerUrl: string,
): Promise<{ text: string; isError: boolean }> {
    const args = applyDefaultNamespace(name, rawArgs, defaultNamespace);
    try {
        switch (name) {
            case "memwal_remember": {
                const text = requireString(args.text, "text");
                const result = await client.rememberAndWait(text, optionalString(args.namespace), {
                    timeoutMs: 90_000,
                });
                return {
                    isError: false,
                    text: `Saved to Walrus Memory. blob_id=${result.blob_id} namespace=${result.namespace}\nExplorer: ${walruscanBlobUrl(result.blob_id)}`,
                };
            }
            case "memwal_remember_bulk": {
                if (!Array.isArray(args.facts) || args.facts.length === 0) {
                    throw new Error("facts must be a non-empty array");
                }
                if (args.facts.length > 20) {
                    throw new Error("facts supports at most 20 items");
                }
                const facts = args.facts.map((f, i) => {
                    if (typeof f !== "string" || f.trim() === "") {
                        throw new Error(`facts[${i}] must be a non-empty string`);
                    }
                    return f;
                });
                const namespace = optionalString(args.namespace);
                const result = await client.rememberBulkAndWait(
                    facts.map((text) => ({ text, namespace })),
                    { timeoutMs: 120_000 },
                );
                const lines = result.results.map((r, i) => {
                    const text = facts[i] ?? "";
                    const blob = r.blob_id ? ` blob_id=${r.blob_id}` : "";
                    const err = r.error ? ` error=${r.error}` : "";
                    return `${i + 1}. [${r.status}]${blob}${err}${text ? ` — ${text}` : ""}`;
                });
                const summary = `Saved ${result.succeeded}/${result.total} fact(s) to Walrus Memory (failed=${result.failed}).`;
                const footer = result.succeeded > 0 ? `\n\n${explorerFooter()}` : "";
                return {
                    isError: false,
                    text:
                        lines.length > 0
                            ? `${summary}\n\n${lines.join("\n")}${footer}`
                            : `${summary}${footer}`,
                };
            }
            case "memwal_recall": {
                const query = requireString(args.query, "query");
                const result = await client.recall({
                    query,
                    limit: optionalLimit(args.limit, 10),
                    namespace: optionalString(args.namespace),
                    maxDistance: optionalMaxDistance(args.maxDistance),
                });
                return { isError: false, text: formatRecallResult(result) };
            }
            case "memwal_analyze": {
                const text = requireString(args.text, "text");
                const result = await client.analyzeAndWait(
                    text,
                    optionalString(args.namespace),
                    { timeoutMs: 180_000 },
                );
                const lines = result.results.map(
                    (r, i) =>
                        `${i + 1}. [${r.status}]${r.blob_id ? ` blob_id=${r.blob_id}` : ""} ${
                            result.facts[i]?.text ?? "(unknown fact)"
                        }`,
                );
                const summary = `Extracted ${result.facts.length} fact(s) — succeeded=${result.succeeded} failed=${result.failed}`;
                const footer = result.succeeded > 0 ? `\n\n${explorerFooter()}` : "";
                return {
                    isError: false,
                    text:
                        lines.length > 0
                            ? `${summary}\n\n${lines.join("\n")}${footer}`
                            : `${summary}${footer}`,
                };
            }
            case "memwal_restore": {
                const namespace = requireString(args.namespace, "namespace");
                const limit = optionalLimit(args.limit, 10);
                const result = await client.restore(namespace, limit);
                return { isError: false, text: formatRestoreResult(result, limit) };
            }
            case "memwal_health": {
                const result = await client.health();
                const envelope = {
                    content: [{ type: "text", text: formatHealthResult(result) }],
                };
                annotateHealthResult(envelope, relayerUrl);
                return { isError: false, text: envelope.content[0].text };
            }
            default:
                throw new Error(`Unknown memory tool: ${name}`);
        }
    } catch (err) {
        return formatToolError(err);
    }
}
