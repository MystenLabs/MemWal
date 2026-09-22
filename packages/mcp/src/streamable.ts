/**
 * Streamable HTTP transport for the stdio bridge.
 *
 * The legacy transport splits a call in two: POST to `/api/mcp/messages`, then
 * wait for the reply to arrive on a separate `/api/mcp/sse` stream. Everything
 * expensive in `bridge.ts` follows from that split — the `inFlight` map, the
 * `sent` flag, the 404-means-never-ran reset, the idle watchdog, and the
 * replay-on-reconnect path — because a POST can succeed while its reply is
 * lost, and the bridge cannot tell that from a call still running.
 *
 * Streamable HTTP (MCP 2025-06) collapses that: one endpoint, and the reply
 * comes back on the same request. The relayer has served it since
 * `mcp_proxy.rs:751` ("Single endpoint that supersedes the SSE+POST split");
 * only the bridge was still on the old transport.
 *
 * This module wraps the MCP SDK's own client transport rather than hand-rolling
 * the protocol: session-id round-tripping, the optional SSE upgrade on a POST
 * response, and resumption tokens are all spec details that are easy to get
 * subtly wrong and that the SDK already implements.
 */
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";

import type { MemWalCredentials } from "./auth.js";
import { log } from "./logger.js";

/** Which relayer transport the bridge dials. */
export type TransportKind = "sse" | "http";

/**
 * Resolve the transport from `MEMWAL_MCP_TRANSPORT`.
 *
 * Defaults to `sse`, the transport every released bridge has used. Streamable
 * HTTP is opt-in until it has production mileage: this runs on users' machines
 * against their real memories, so the new path proves itself before it becomes
 * the one that runs by default.
 *
 * An unrecognised value falls back rather than throwing — a typo in a user's
 * MCP config must not stop their memory from working.
 */
export function resolveTransport(raw: string | undefined): TransportKind {
    const value = raw?.trim().toLowerCase();
    if (!value) return "sse";
    if (value === "http" || value === "streamable" || value === "streamable-http") {
        return "http";
    }
    if (value === "sse") return "sse";
    log.warn("bridge.transport_unrecognized", { value, using: "sse" });
    return "sse";
}

/**
 * The Streamable HTTP endpoint for a relayer base URL.
 *
 * `/api/mcp` — the same base the SSE transport hangs `/api/mcp/sse` and
 * `/api/mcp/messages` off, minus the split.
 */
export function streamableUrl(relayerUrl: string): string {
    return `${relayerUrl.replace(/\/+$/, "")}/api/mcp`;
}

/**
 * A live relayer session. Deliberately the same shape the SSE handshake
 * returns, so `runBridge` can hold either without branching on transport
 * everywhere it forwards a message.
 */
export interface RelaySession {
    /** Endpoint this session talks to. Logging only. */
    postUrl: string;
    /**
     * Forward one JSON-RPC message. Resolves with an HTTP-ish status the
     * caller can act on: 200 for accepted, 404 when the relayer says the
     * session does not exist (the message provably did not run, so the
     * caller may retry it without risking a duplicate write).
     */
    send(
        msg: JSONRPCMessage,
        /** Unused here — headers are bound when the session opens. Present so
         * this matches the SSE handshake's `send`, which signs per POST. */
        creds?: MemWalCredentials,
        extra?: Record<string, string>,
    ): Promise<number>;
    /** Incoming messages from the relayer. */
    iter: AsyncIterator<JSONRPCMessage>;
    /** Tear the session down. */
    abort: () => void;
}

/** HTTP status carried on the SDK's transport error, when it has one. */
function statusOf(err: unknown): number {
    const code = (err as { code?: unknown } | null)?.code;
    return typeof code === "number" ? code : 0;
}

export async function openStreamableSession(
    relayerUrl: string,
    creds: MemWalCredentials,
    extraHeaders: Record<string, string> = {},
): Promise<RelaySession> {
    const url = streamableUrl(relayerUrl);

    // Queue + waiter rather than an event emitter, so a message that arrives
    // before `runBridge` pulls from the iterator is buffered instead of
    // dropped. The SSE path does the same thing for the same reason.
    const queue: JSONRPCMessage[] = [];
    let wake: (() => void) | null = null;
    let closed = false;
    const push = (msg: JSONRPCMessage) => {
        queue.push(msg);
        const resume = wake;
        wake = null;
        resume?.();
    };
    const finish = () => {
        closed = true;
        const resume = wake;
        wake = null;
        resume?.();
    };

    const transport = new StreamableHTTPClientTransport(new URL(url), {
        requestInit: {
            headers: {
                authorization: `Bearer ${creds.delegatePrivateKey}`,
                "x-memwal-account-id": creds.accountId,
                ...extraHeaders,
            },
        },
    });

    transport.onmessage = push;
    transport.onclose = finish;
    transport.onerror = (err) => {
        log.warn("bridge.streamable_error", { err: String(err) });
        // Not `finish()` — the SDK transport reconnects its own stream, and
        // tearing the session down on a transient read error is what the SSE
        // watchdog did wrong.
    };

    await transport.start();

    const iter: AsyncIterator<JSONRPCMessage> = {
        async next() {
            while (queue.length === 0) {
                if (closed) return { value: undefined as never, done: true };
                await new Promise<void>((resolve) => (wake = resolve));
            }
            return { value: queue.shift()!, done: false };
        },
    };

    return {
        postUrl: url,
        async send(msg) {
            try {
                await transport.send(msg);
                return 200;
            } catch (err) {
                const status = statusOf(err);
                log.warn("bridge.streamable_send_failed", {
                    status,
                    err: String(err),
                });
                // Surface the status rather than throwing: `postIfCurrent`
                // routes on it, and a 404 specifically means the message was
                // discarded rather than run.
                return status;
            }
        },
        iter,
        abort: () => {
            void transport.close().catch(() => {
                /* already gone */
            });
            finish();
        },
    };
}
