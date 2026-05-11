/**
 * =============================================================================
 * MemWal MCP — Express mount
 * =============================================================================
 * Exposes `mountMcpRoutes(app)` which attaches `/mcp/sse` + `/mcp/messages`
 * to the sidecar's existing express app. The Rust relayer proxies external
 * `/api/mcp/*` traffic to these internal sidecar routes (same pattern as
 * walrus/seal proxy).
 *
 * Each authenticated client gets its own McpServer + SSEServerTransport. The
 * sidecar stays single-process; sessions are in-memory.
 *
 * Required headers on `/mcp/sse`:
 *   Authorization: Bearer <ed25519-private-key-hex>     (64 hex)
 *   X-MemWal-Account-Id: 0x<sui-object-id>             (66 chars)
 *   X-MemWal-Namespace: <optional namespace default>
 * =============================================================================
 */
import type { Express, Request, Response } from "express";
import express from "express";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";

import type { AuthResolution } from "./auth.js";
import { McpAuthError, resolveAuth } from "./auth.js";
import { createLogger } from "./logger.js";
import { createMcpServer } from "./server.js";

const log = createLogger("mcp");

interface McpConnection {
    sessionKey: string;
    transport: SSEServerTransport;
    cleanup: () => void;
}

/** transport.sessionId → connection. Multiple sessions per delegate are allowed
 * so concurrent MCP clients (Claude Code + Claude.app + Cursor) that share the
 * same delegate key do not evict each other. */
const sessionsById = new Map<string, McpConnection>();

function rpcError(res: Response, status: number, message: string): void {
    res.status(status).json({
        jsonrpc: "2.0",
        error: { code: status === 401 ? -32001 : -32603, message },
        id: null,
    });
}

function expressHeadersToWeb(req: Request): Headers {
    const h = new Headers();
    for (const [k, v] of Object.entries(req.headers)) {
        if (Array.isArray(v)) {
            for (const item of v) h.append(k, item);
        } else if (typeof v === "string") {
            h.set(k, v);
        }
    }
    return h;
}

async function handleSse(
    req: Request,
    res: Response,
    relayerUrl: string
): Promise<void> {
    let auth: AuthResolution;
    try {
        auth = await resolveAuth(expressHeadersToWeb(req), relayerUrl);
    } catch (err) {
        if (err instanceof McpAuthError) {
            res.setHeader(
                "www-authenticate",
                'Bearer realm="memwal", error="invalid_token"'
            );
            return rpcError(res, err.status, err.message);
        }
        return rpcError(
            res,
            500,
            err instanceof Error ? err.message : String(err)
        );
    }

    // No eviction on same {account, delegate}: multiple MCP clients sharing
    // the same delegate key (Claude Code + Claude.app + Cursor on one
    // machine) must coexist. Each SSE open = independent session keyed by
    // transport.sessionId; POST /messages routes by that id directly.

    // POST endpoint path that SSE clients send messages to. Must match
    // what the Rust relayer exposes externally so the client builds the
    // correct URL. We expose `/api/mcp/messages` publicly; the relayer
    // proxies it to sidecar's `/mcp/messages`. The SSE transport puts
    // this path into the `endpoint` event verbatim.
    const transport = new SSEServerTransport("/api/mcp/messages", res);
    const server = createMcpServer(auth.session);

    // SSE keep-alive — long-running tool calls (remember can take 20-30s
    // for Walrus upload) leave the SSE stream idle. Without bytes flowing,
    // intermediary TCP keep-alives (Node undici on the client, reqwest on
    // the Rust proxy, NAT routers) drop the connection. We push a comment
    // line every 3s so the stream stays warm. Comment lines (`:` prefix)
    // are ignored by the SSE parser per HTML5 EventSource § 9.2.6.
    let beatN = 0;
    const writeHeartbeat = () => {
        if (res.writableEnded) return;
        try {
            res.write(`:keepalive ${++beatN} ${Date.now()}\n\n`);
            (res as { flush?: () => void }).flush?.();
        } catch {
            /* socket already closed — next tick the close handler will tear down */
        }
    };
    // Fire one almost-immediately to confirm the stream is bidirectional
    // before going idle. Subsequent beats every 3s.
    setTimeout(writeHeartbeat, 200);
    const heartbeat = setInterval(writeHeartbeat, 3_000);
    heartbeat.unref?.();

    // Idempotent cleanup tied to THIS transport.
    let cleanedUp = false;
    const cleanup = () => {
        if (cleanedUp) return;
        cleanedUp = true;
        clearInterval(heartbeat);
        sessionsById.delete(transport.sessionId);
        log.info("session.closed", {
            sessionKey: auth.sessionKey,
            transportId: transport.sessionId,
        });
    };

    res.on("close", cleanup);
    transport.onclose = cleanup;

    sessionsById.set(transport.sessionId, {
        sessionKey: auth.sessionKey,
        transport,
        cleanup,
    });

    log.info("session.opened", {
        sessionKey: auth.sessionKey,
        accountId: auth.session.accountId,
        delegatePubKey: auth.session.delegatePubKeyHex,
        transportId: transport.sessionId,
    });

    await server.connect(transport);
}

async function handlePostMessage(req: Request, res: Response): Promise<void> {
    const sessionId = typeof req.query.sessionId === "string" ? req.query.sessionId : undefined;
    if (!sessionId) {
        return rpcError(res, 400, "Missing sessionId query parameter");
    }
    const conn = sessionsById.get(sessionId);
    if (!conn) {
        return rpcError(res, 404, `Unknown sessionId ${sessionId}`);
    }
    // SSEServerTransport.handlePostMessage expects the raw IncomingMessage.
    // Express `req` is an IncomingMessage subtype; passing it through works.
    await conn.transport.handlePostMessage(req, res);
}

export interface MountMcpOptions {
    /** Relayer base URL that tool calls hit. Default: `http://localhost:3001`. */
    relayerUrl?: string;
}

/**
 * Attach MCP routes to a sidecar express app. The relayer proxies external
 * `/api/mcp/*` traffic to these internal `/mcp/*` routes.
 *
 *   GET  /mcp/sse              open SSE stream (auth required)
 *   POST /mcp/messages         JSON-RPC messages (auth happens at SSE open,
 *                              this route trusts the sessionId)
 */
export function mountMcpRoutes(
    app: Express,
    options: MountMcpOptions = {}
): void {
    const relayerUrl = options.relayerUrl ?? "http://localhost:3001";

    app.get("/mcp/sse", async (req, res) => {
        try {
            await handleSse(req, res, relayerUrl);
        } catch (err) {
            log.error("mcp.sse.error", {
                err: err instanceof Error ? err.message : String(err),
            });
            if (!res.headersSent) {
                rpcError(res, 500, err instanceof Error ? err.message : String(err));
            }
        }
    });

    app.post(
        "/mcp/messages",
        // Body parsing — SSEServerTransport reads the raw body itself, so we
        // do NOT mount express.json() here. Keep the body intact for the
        // transport's internal raw-body parser.
        async (req, res) => {
            try {
                await handlePostMessage(req, res);
            } catch (err) {
                log.error("mcp.post.error", {
                    err: err instanceof Error ? err.message : String(err),
                });
                if (!res.headersSent) {
                    rpcError(res, 500, err instanceof Error ? err.message : String(err));
                }
            }
        }
    );

    log.info("mcp.routes.mounted", {
        routes: ["GET /mcp/sse", "POST /mcp/messages"],
        relayerUrl,
    });
}

/** Active session count for /healthz observability. */
export function getMcpSessionCount(): number {
    return sessionsById.size;
}

/** Gracefully close all active MCP transports during sidecar shutdown. */
export async function shutdownMcpSessions(): Promise<void> {
    log.info("mcp.shutting_down", { active_sessions: sessionsById.size });
    for (const conn of sessionsById.values()) {
        try {
            await conn.transport.close();
        } catch (err) {
            log.warn("mcp.session.close_failed", {
                sessionKey: conn.sessionKey,
                err: err instanceof Error ? err.message : String(err),
            });
        }
    }
}

// Re-export auth + tool types so sidecar can introspect if needed.
export type { MemWalSession } from "./auth.js";
export { McpAuthError, resolveAuth } from "./auth.js";
