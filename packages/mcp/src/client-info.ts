/**
 * Capture MCP `initialize` `clientInfo` so the stdio bridge can tell the
 * relayer/sidecar which coding agent opened the session.
 *
 * Header names must stay under the `x-memwal-` prefix: the relayer proxy
 * forwards that family and drops everything else.
 */

export const CLIENT_NAME_HEADER = "x-memwal-client";
export const CLIENT_VERSION_HEADER = "x-memwal-client-version";

const MAX_TOKEN = 64;

export function sanitizeClientToken(raw: unknown): string | null {
    if (typeof raw !== "string") return null;
    // HTTP header values cannot carry CR/LF; keep printable ASCII.
    // Sidecar copy (`services/server/scripts/mcp/agent-client.ts`) only
    // strips C0/DEL so JSON logs can keep non-ASCII names. Do not unify.
    const cleaned = raw.replace(/[^\x20-\x7e]/g, "").trim();
    if (!cleaned) return null;
    return cleaned.slice(0, MAX_TOKEN);
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

export function clientInfoHeaders(info: {
    name: string;
    version: string | null;
}): Record<string, string> {
    const headers: Record<string, string> = { [CLIENT_NAME_HEADER]: info.name };
    if (info.version) headers[CLIENT_VERSION_HEADER] = info.version;
    return headers;
}

/** Last `initialize.clientInfo` seen on this process. Survives the
 * auth-required → bridge handoff, which does not replay `initialize`. */
let lastClientInfo: { name: string; version: string | null } | null = null;

export function rememberInitializeClientInfo(
    params: unknown,
): { name: string; version: string | null } | null {
    const info = clientInfoFromInitializeParams(params);
    if (info) lastClientInfo = info;
    return info;
}

export function lastClientInfoHeaders(): Record<string, string> {
    return lastClientInfo ? clientInfoHeaders(lastClientInfo) : {};
}
