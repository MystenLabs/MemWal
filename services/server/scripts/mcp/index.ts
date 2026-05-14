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
import { randomUUID } from "node:crypto";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";

import type { AuthResolution } from "./auth.js";
import { McpAuthError, resolveAuth } from "./auth.js";
import { createLogger } from "./logger.js";
import { createMcpServer } from "./server.js";
import { McpRateLimiter, clientIpFromRequest } from "./rateLimit.js";

const log = createLogger("mcp");

// Global limiter — caps concurrent MCP sessions per source IP and total. The
// limiter MUST run BEFORE resolveAuth() so a flood of forged bearers cannot
// hold long-lived SSE / streamable transports.
//
// Lazy-initialized: constructed on first use so the limits reflect the
// process.env state at request time (ESM hoists `import` above any top-level
// `process.env.X = ...` assignments in callers — eager init at module load
// would freeze the limits to whatever env existed when this module was
// first evaluated).
let _rateLimiter: McpRateLimiter | null = null;
function rateLimiter(): McpRateLimiter {
    if (_rateLimiter === null) {
        _rateLimiter = new McpRateLimiter();
    }
    return _rateLimiter;
}

function rateLimitDeny(
    res: Response,
    reason: NonNullable<ReturnType<McpRateLimiter["acquire"]>["reason"]>,
    retryAfterSeconds: number | undefined
): void {
    if (retryAfterSeconds && retryAfterSeconds > 0) {
        res.setHeader("retry-after", String(retryAfterSeconds));
    }
    res.status(429).json({
        jsonrpc: "2.0",
        error: {
            code: -32000,
            message: `MCP rate limit: ${reason}. Try again in ${retryAfterSeconds ?? 30}s.`,
        },
        id: null,
    });
}

interface McpConnection {
    sessionKey: string;
    transport: SSEServerTransport;
    cleanup: () => void;
}

/** transport.sessionId → connection. Multiple sessions per delegate are allowed
 * so concurrent MCP clients (Claude Code + Claude.app + Cursor) that share the
 * same delegate key do not evict each other. */
const sessionsById = new Map<string, McpConnection>();

/**
 * Streamable HTTP transport sessions, keyed by the `mcp-session-id` header.
 * Separate from `sessionsById` (which is keyed by SSE transport ids) — the
 * two namespaces never collide because they live on different routes
 * (`/mcp/sse` vs `/mcp`).
 */
interface StreamableConnection {
    sessionKey: string;
    transport: StreamableHTTPServerTransport;
    cleanup: () => void;
}
const streamableSessions = new Map<string, StreamableConnection>();

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
    // Rate limit BEFORE resolveAuth — see comment on `rateLimiter` above.
    // resolveAuth only checks header shape, so we must cap concurrent SSE
    // sessions before allocating a transport / heartbeat / proxy stream.
    const limiter = rateLimiter();
    const ip = clientIpFromRequest(req);
    const slot = limiter.acquire(ip);
    if (!slot.ok) {
        log.warn("session.rate_limited", {
            transport: "sse",
            ip,
            reason: slot.reason,
        });
        return rateLimitDeny(res, slot.reason!, slot.retryAfterSeconds);
    }
    const releaseSlot = limiter.releaseFn(ip);

    let auth: AuthResolution;
    try {
        auth = await resolveAuth(expressHeadersToWeb(req), relayerUrl);
    } catch (err) {
        releaseSlot();
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
        releaseSlot();
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

/**
 * Streamable HTTP transport (MCP 2025-06). One endpoint, three methods:
 *   - POST /mcp  →  client → server JSON-RPC + optional SSE upgrade for the response
 *   - GET  /mcp  →  open server → client SSE stream (long-polling fallback)
 *   - DELETE /mcp  →  end the named session
 *
 * The session lifecycle: the first POST without an `mcp-session-id` header
 * triggers a fresh session (transport's `sessionIdGenerator` mints a UUID).
 * Subsequent requests carry `mcp-session-id: <uuid>` so we route to the
 * same transport instance. On DELETE, the transport closes and we evict.
 */
async function handleStreamableHttp(
    req: Request,
    res: Response,
    relayerUrl: string
): Promise<void> {
    // 1) Auth — bearer + accountId same as SSE path. Cheap to re-run per
    //    request; resolveAuth's on-chain lookup is cached by the SDK once
    //    we mint the MemWal client per session.
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

    // 2) Find or create the transport for this `mcp-session-id`. Missing
    //    header on a POST = brand-new session (the SDK assigns one on the
    //    response). Missing header on GET/DELETE = client error.
    const sessionIdHeader = req.headers["mcp-session-id"];
    const sessionId =
        typeof sessionIdHeader === "string" ? sessionIdHeader : undefined;

    const conn = sessionId ? streamableSessions.get(sessionId) : undefined;

    if (conn) {
        // Bind the session id to the bearer/account that opened it. Without
        // this check, anyone who learns the `mcp-session-id` UUID can drive
        // an existing transport under their own (or random) credentials.
        // The session key embeds {accountId, delegatePubKey}, so a
        // mismatch means a different caller is trying to reuse the session.
        if (conn.sessionKey !== auth.sessionKey) {
            log.warn("session.auth_mismatch", {
                transport: "streamable",
                transportId: sessionId,
                expected: conn.sessionKey,
                got: auth.sessionKey,
            });
            return rpcError(
                res,
                403,
                "mcp-session-id does not match authenticated caller"
            );
        }
        await conn.transport.handleRequest(req, res);
        return;
    }

    if (req.method !== "POST") {
        return rpcError(
            res,
            400,
            "missing mcp-session-id — open a new session with an initial POST"
        );
    }

    // New session — apply the same per-IP cap the SSE path uses BEFORE we
    // allocate a transport. Acquired here (after auth so logs are useful)
    // because we now know we will create a session, but BEFORE
    // `transport.handleRequest` so we don't kick off an upgrade we can't
    // sustain.
    const limiter = rateLimiter();
    const ip = clientIpFromRequest(req);
    const slot = limiter.acquire(ip);
    if (!slot.ok) {
        log.warn("session.rate_limited", {
            transport: "streamable",
            ip,
            reason: slot.reason,
        });
        return rateLimitDeny(res, slot.reason!, slot.retryAfterSeconds);
    }
    const releaseSlot = limiter.releaseFn(ip);

    // Spawn a fresh transport. `sessionIdGenerator` is invoked once on
    // the first message-init response; we cache the connection only
    // after we know the assigned id.
    let initialized = false;
    const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (newId: string) => {
            initialized = true;
            let cleanedUp = false;
            const cleanup = () => {
                if (cleanedUp) return;
                cleanedUp = true;
                streamableSessions.delete(newId);
                releaseSlot();
                log.info("session.closed", {
                    transport: "streamable",
                    sessionKey: auth.sessionKey,
                    transportId: newId,
                });
            };
            transport.onclose = cleanup;
            streamableSessions.set(newId, {
                sessionKey: auth.sessionKey,
                transport,
                cleanup,
            });
            log.info("session.opened", {
                transport: "streamable",
                sessionKey: auth.sessionKey,
                accountId: auth.session.accountId,
                delegatePubKey: auth.session.delegatePubKeyHex,
                transportId: newId,
            });
        },
    });

    // Belt-and-braces release: `releaseSlot` is one-shot, so wiring it to
    // every plausible terminal path is safe. `onsessioninitialized` overrides
    // `transport.onclose` with `cleanup` (which also calls releaseSlot), and
    // the catch below handles handleRequest throwing before init completes.
    transport.onclose = releaseSlot;

    const server = createMcpServer(auth.session);
    try {
        await server.connect(transport);
        // The SDK's handleRequest takes the raw IncomingMessage. We
        // intentionally do NOT pre-parse the body — express.json() is not
        // mounted on this route so req still has the raw stream.
        // The transport reads the body itself.
        await transport.handleRequest(req, res);
        if (!initialized) {
            releaseSlot();
            await transport.close().catch((err) => {
                log.warn("mcp.streamable_uninitialized_close_failed", {
                    err: err instanceof Error ? err.message : String(err),
                });
            });
        }
    } catch (err) {
        releaseSlot();
        throw err;
    }
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

    // Streamable HTTP transport (MCP 2025-06 spec) — single endpoint that
    // supersedes the SSE+POST split. Auth on every request because the
    // transport is stateless across HTTP requests; the bearer is cheap to
    // re-validate (one Sui RPC lookup, cached in resolveAuth).
    //
    // The endpoint accepts GET (open SSE stream for server→client),
    // POST (JSON-RPC envelopes both directions), and DELETE (close
    // session). All three are routed through the same handler — the
    // SDK's `transport.handleRequest()` figures out which based on
    // req.method.
    const streamableHandler = async (req: Request, res: Response) => {
        try {
            await handleStreamableHttp(req, res, relayerUrl);
        } catch (err) {
            log.error("mcp.streamable.error", {
                err: err instanceof Error ? err.message : String(err),
            });
            if (!res.headersSent) {
                rpcError(res, 500, err instanceof Error ? err.message : String(err));
            }
        }
    };
    app.get("/mcp", streamableHandler);
    app.post("/mcp", streamableHandler);
    app.delete("/mcp", streamableHandler);

    log.info("mcp.routes.mounted", {
        routes: [
            "GET /mcp/sse",
            "POST /mcp/messages",
            "GET|POST|DELETE /mcp (streamable HTTP)",
        ],
        relayerUrl,
    });
}

/** Active session count for /healthz observability. */
export function getMcpSessionCount(): number {
    return sessionsById.size + streamableSessions.size;
}

/** Gracefully close all active MCP transports during sidecar shutdown. */
export async function shutdownMcpSessions(): Promise<void> {
    log.info("mcp.shutting_down", { active_sessions: getMcpSessionCount() });
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
    for (const conn of streamableSessions.values()) {
        try {
            await conn.transport.close();
        } catch (err) {
            log.warn("mcp.streamable_session.close_failed", {
                sessionKey: conn.sessionKey,
                err: err instanceof Error ? err.message : String(err),
            });
        }
    }
}

// Re-export auth + tool types so sidecar can introspect if needed.
export type { MemWalSession } from "./auth.js";
export { McpAuthError, resolveAuth } from "./auth.js";
