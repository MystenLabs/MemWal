/**
 * Map MCP `clientInfo.name` (and the optional `x-memwal-client` header) onto
 * a stable agent-client id so sidecar logs can say which coding agent a
 * session belongs to.
 *
 * Names are untrusted client-supplied strings. We sanitize length/control
 * chars, never log tool arguments, and treat unknown names as `other` while
 * keeping the raw name in the log line.
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { MemWalSession } from "./auth.js";
import { createLogger } from "./logger.js";

const log = createLogger("mcp");

const MAX_TOKEN = 64;

export const CLIENT_NAME_HEADER = "x-memwal-client";
export const CLIENT_VERSION_HEADER = "x-memwal-client-version";

/**
 * Stable ids written to `session.agentClient` / sidecar logs.
 * Keep in lockstep with the branches in `identifyAgentClient`.
 */
export const AGENT_CLIENT_IDS = [
    "claude-code",
    "codex",
    "cursor",
    "antigravity",
    "opencode",
    "windsurf",
    "claude-desktop",
    "vscode-copilot",
    "chatgpt",
    "gemini",
    "grok",
    "other",
] as const;

export type AgentClientId = (typeof AGENT_CLIENT_IDS)[number];

/**
 * Sidecar copy of token sanitizing. Strips C0/DEL only so JSON logs can
 * keep non-ASCII client names. The stdio-bridge copy in
 * `packages/mcp/src/client-info.ts` is stricter (printable ASCII) because
 * it produces HTTP header values. Do not unify them.
 */
export function sanitizeClientToken(raw: unknown): string | null {
    if (typeof raw !== "string") return null;
    const cleaned = raw.replace(/[\u0000-\u001f\u007f]/g, "").trim();
    if (!cleaned) return null;
    return cleaned.slice(0, MAX_TOKEN);
}

/** Stable id used in logs. Order matters: `claude-code` before `claude`. */
export function identifyAgentClient(rawName: string): AgentClientId {
    const n = rawName.toLowerCase();
    if (n.includes("claude-code") || n.includes("claude code")) return "claude-code";
    if (n.includes("codex")) return "codex";
    if (n.includes("cursor")) return "cursor";
    if (n.includes("antigravity")) return "antigravity";
    if (n.includes("opencode") || n.includes("open-code")) return "opencode";
    if (n.includes("windsurf") || n.includes("codeium")) return "windsurf";
    // Claude Desktop's web UI has historically sent `claude.ai` / `claude-ai`
    // as clientInfo.name. Unknown names still fall through to `other`.
    if (
        n.includes("claude-desktop") ||
        n.includes("claude desktop") ||
        n.includes("claude.ai") ||
        n === "claude-ai" ||
        n === "claude"
    ) {
        return "claude-desktop";
    }
    if (n.includes("visual studio") || n.includes("github copilot") || n.includes("vscode")) {
        return "vscode-copilot";
    }
    if (n.includes("chatgpt")) return "chatgpt";
    if (n.includes("gemini")) return "gemini";
    if (n.includes("grok")) return "grok";
    return "other";
}

export function clientInfoFromInitializeParams(
    params: unknown,
): { name: string; version: string | null } | null {
    if (params == null || typeof params !== "object") return null;
    const info = (params as { clientInfo?: unknown }).clientInfo;
    if (info == null || typeof info !== "object") return null;
    const name = sanitizeClientToken((info as { name?: unknown }).name);
    if (!name) return null;
    return {
        name,
        version: sanitizeClientToken((info as { version?: unknown }).version),
    };
}

/**
 * Stamp `session.agentClient` the first time we learn a name. Idempotent for
 * the same id+name: later calls do not emit another log line, except when they
 * fill in a version that the first stamp lacked (header without version, then
 * handshake with version). A later call that omits version must not wipe one
 * we already stored.
 */
export function applyAgentClient(
    session: MemWalSession,
    input: { name?: string | null; version?: string | null },
    fields: Record<string, unknown> = {},
): boolean {
    const name = sanitizeClientToken(input.name);
    if (!name) return false;
    const id = identifyAgentClient(name);
    const version = sanitizeClientToken(input.version);
    const sameIdentity = session.agentClient === id && session.clientName === name;
    if (sameIdentity && (version == null || session.clientVersion === version)) {
        return false;
    }
    const first = session.agentClient == null;
    session.agentClient = id;
    session.clientName = name;
    if (!sameIdentity) {
        session.clientVersion = version ?? undefined;
    } else if (version) {
        session.clientVersion = version;
    }
    log.info(first ? "session.identified" : "session.identified.updated", {
        agentClient: id,
        clientName: name,
        clientVersion: session.clientVersion ?? version,
        accountId: session.accountId,
        ...fields,
    });
    return true;
}

export function applyAgentClientFromServer(
    server: McpServer,
    session: MemWalSession,
    header?: { name?: string | null; version?: string | null },
    fields: Record<string, unknown> = {},
): boolean {
    const sdk = server.server.getClientVersion();
    return applyAgentClient(
        session,
        {
            name: sdk?.name ?? header?.name,
            version: sdk?.version ?? header?.version,
        },
        fields,
    );
}
