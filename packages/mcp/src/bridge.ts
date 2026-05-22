/**
 * stdio ↔ remote-SSE bridge.
 *
 * The MCP client (Cursor, Claude Desktop, etc.) speaks **stdio** MCP — JSON
 * lines on stdin, JSON lines on stdout. The MemWal relayer speaks **remote
 * SSE** MCP at `/api/mcp/sse` + `/api/mcp/messages`. This module glues the
 * two together so the user only adds a `command + args` entry to their MCP
 * client config (no headers, no URL).
 *
 * On 401 from the relayer, we surface a clear error to the MCP client but
 * leave the local credentials file untouched. A naive `clearCreds()` here
 * was a creds-wipe DoS: anyone able to coerce a 401 response (transient WAF
 * rule, future http_proxy MITM, local malware racing the relayer port on
 * `--local`) would have wiped the user's saved seed without consent.
 * Re-auth requires an explicit `memwal-mcp login` from the user.
 */
import type { MemWalCredentials } from "./auth.js";
import { clearCreds, credsPath } from "./auth.js";
import { ensureCompatibleRelayer } from "./compatibility.js";
import { loginFlow } from "./login.js";
import { log, note } from "./logger.js";

/** Bridge mode runtime config — the URLs / label resolved at boot from
 * `--dev` / `--staging` / etc. Needed so `memwal_login` (re-auth) opens
 * the SAME dashboard the user originally signed in to, not the prod default. */
export interface BridgeConfig {
    relayerUrl: string;
    webUrl: string;
    label: string;
    /** Default memory namespace resolved at boot (`--namespace` /
     * `MEMWAL_NAMESPACE`). Injected into memory tool calls that omit a
     * namespace. Undefined → don't inject; the relayer applies its own
     * "default" namespace. */
    namespace?: string;
}

/** Memory tools that take a `namespace` argument. `memwal_remember`,
 * `memwal_recall`, and `memwal_analyze` treat it as optional; `memwal_restore`
 * requires it (its upstream schema still lists `namespace` as required, so
 * agents normally pass one — but a configured default is filled in if the
 * agent calls it without). */
const NAMESPACE_TOOLS = new Set([
    "memwal_remember",
    "memwal_recall",
    "memwal_analyze",
    "memwal_restore",
]);

/**
 * Inject the configured default namespace into an outbound `tools/call`
 * message when the agent omitted one. Mutates `msg.params.arguments` in place
 * and returns `msg` (so it works inline before tracking/forwarding).
 *
 * No-op when:
 *   - no default namespace is configured (`namespace` falsy), or
 *   - the message is not a `tools/call` for a namespace-aware memory tool, or
 *   - the caller already supplied a non-empty `namespace` — an explicit
 *     per-call namespace always wins over the configured default.
 */
export function applyDefaultNamespace(msg: RpcMessage, namespace?: string): RpcMessage {
    if (!namespace) return msg;
    if (msg.method !== "tools/call") return msg;
    const params = msg.params as
        | { name?: string; arguments?: Record<string, unknown> }
        | undefined;
    if (!params || typeof params.name !== "string" || !NAMESPACE_TOOLS.has(params.name)) {
        return msg;
    }
    const args = (params.arguments ??= {});
    const current = args.namespace;
    // Explicit, non-empty per-call namespace wins.
    if (typeof current === "string" && current.trim() !== "") return msg;
    args.namespace = namespace;
    return msg;
}

/** Tools we serve LOCALLY (not forwarded to the relayer) so the user can
 * re-auth or sign out without leaving the MCP client. The 4 memwal_*
 * tools registered on the relayer side still come from `tools/list`
 * upstream — we splice these in. */
const LOCAL_TOOL_DEFINITIONS = [
    {
        name: "memwal_login",
        description:
            "Sign in (or re-sign in) to MemWal by opening a browser. Use to switch wallets, refresh credentials, or sign in for the first time. Returns a click-able URL — the user must approve in their browser.",
        inputSchema: {
            type: "object",
            properties: {},
            additionalProperties: false,
        },
    },
    {
        name: "memwal_logout",
        description:
            "Remove the saved MemWal credentials from this machine (~/.memwal/credentials.json). The on-chain delegate key registration is NOT revoked — visit the MemWal dashboard to remove it from your account if needed.",
        inputSchema: {
            type: "object",
            properties: {},
            additionalProperties: false,
        },
    },
];

const LOGIN_BG_TIMEOUT_MS = 5 * 60_000;
const URL_READY_TIMEOUT_MS = 5_000;

interface RpcMessage {
    jsonrpc: "2.0";
    id?: number | string | null;
    method?: string;
    params?: unknown;
    result?: unknown;
    error?: unknown;
}

interface SseHandshakeResult {
    /** Absolute URL the client must POST to for outbound JSON-RPC messages. */
    postUrl: string;
    /** Per-line iterator for incoming SSE messages (already-parsed JSON-RPC). */
    iter: AsyncIterator<RpcMessage>;
    /** Abort + close the SSE stream. */
    abort: () => void;
}

async function openSseStream(
    relayerUrl: string,
    creds: MemWalCredentials,
): Promise<SseHandshakeResult> {
    await ensureCompatibleRelayer(relayerUrl);

    const url = `${relayerUrl.replace(/\/+$/, "")}/api/mcp/sse`;
    const controller = new AbortController();

    const resp = await fetch(url, {
        method: "GET",
        headers: {
            authorization: `Bearer ${creds.delegatePrivateKey}`,
            "x-memwal-account-id": creds.accountId,
            accept: "text/event-stream",
            "cache-control": "no-cache",
        },
        signal: controller.signal,
    });

    if (resp.status === 401) {
        controller.abort();
        log.warn("bridge.unauthorized", { url });
        // DO NOT wipe creds here. A 401 from the relayer is *evidence* of
        // a problem but not *proof* the saved seed is the cause. Possible
        // sources: revoked delegate key (genuine), transient WAF / rate
        // limit (false positive), http_proxy interposed somewhere on the
        // path, or — on `--local` — local malware racing the relayer port.
        // Auto-wiping the seed turns any one of those into a permanent
        // outage that forces re-login. Force-fail loud instead; the user
        // runs `memwal-mcp login` if they want to actually rotate.
        throw new Error(
            "MemWal relayer rejected credentials (HTTP 401). " +
                "Delegate key may have been revoked, the relayer may be " +
                "rate-limiting, or a proxy may be interposed. Saved " +
                `credentials at ${credsPath()} were NOT modified. ` +
                "Run `memwal-mcp login` if you need to rotate the key."
        );
    }
    if (!resp.ok || !resp.body) {
        const body = resp.body ? await resp.text() : "";
        controller.abort();
        throw new Error(
            `MemWal relayer SSE handshake failed: HTTP ${resp.status} ${body.slice(0, 200)}`
        );
    }

    const ct = resp.headers.get("content-type") ?? "";
    if (!ct.includes("event-stream")) {
        controller.abort();
        throw new Error(
            `MemWal relayer returned unexpected content-type "${ct}" for SSE endpoint`
        );
    }

    const reader = resp.body.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    let endpointResolved = false;
    let endpointPath = "";
    let streamEnded = false;
    let streamError: string | null = null;
    const events: RpcMessage[] = [];
    type Waker = () => void;
    let queueResolver: Waker | null = null;
    function wake(): void {
        const r = queueResolver;
        if (r) {
            queueResolver = null;
            r();
        }
    }

    function pushEvent(ev: RpcMessage): void {
        events.push(ev);
        wake();
    }

    // Pump the SSE stream in the background.
    const pump = (async () => {
        try {
            while (true) {
                const { done, value } = await reader.read();
                if (done) break;
                buf += decoder.decode(value, { stream: true });
                let sep: number;
                while ((sep = buf.indexOf("\n\n")) >= 0) {
                    const chunk = buf.slice(0, sep);
                    buf = buf.slice(sep + 2);
                    const lines = chunk.split("\n");
                    const event = lines
                        .find((l) => l.startsWith("event:"))
                        ?.slice("event:".length)
                        .trim();
                    const data = lines
                        .filter((l) => l.startsWith("data:"))
                        .map((l) => l.slice("data:".length).replace(/^\s/, ""))
                        .join("\n");
                    if (event === "endpoint" && !endpointResolved) {
                        endpointPath = data.trim();
                        endpointResolved = true;
                        wake();
                        continue;
                    }
                    if (event === "message" || (!event && data)) {
                        try {
                            const parsed = JSON.parse(data) as RpcMessage;
                            pushEvent(parsed);
                        } catch {
                            log.warn("bridge.sse_parse_failed", { data: data.slice(0, 120) });
                        }
                    }
                }
            }
        } catch (err) {
            if (!controller.signal.aborted) {
                const msg = err instanceof Error ? err.message : String(err);
                streamError = msg;
                // `terminated` is undici's keep-alive idle drop — happens on
                // long-idle SSE in manual tests. The MCP client wrapping us
                // (Cursor / Claude Desktop) will re-spawn the process if it
                // needs the bridge again, so a clean exit is fine.
                if (msg === "terminated" || msg.includes("ECONNRESET")) {
                    log.warn("bridge.sse_idle_closed", { reason: msg });
                } else {
                    log.error("bridge.sse_pump_error", { err: msg });
                }
            }
        } finally {
            streamEnded = true;
            // Wake any waiter so they see EOF.
            wake();
        }
    })();

    // Wait for the `endpoint` event (or first message) before returning.
    while (!endpointResolved) {
        if (streamEnded) {
            controller.abort();
            throw new Error(
                `MemWal relayer SSE handshake ended before endpoint event${streamError ? `: ${streamError}` : ""}`
            );
        }
        await new Promise<void>((r) => (queueResolver = r));
    }

    const iter: AsyncIterator<RpcMessage> = {
        async next(): Promise<IteratorResult<RpcMessage>> {
            while (events.length === 0) {
                if (controller.signal.aborted) return { value: undefined as never, done: true };
                if (streamEnded) return { value: undefined as never, done: true };
                await new Promise<void>((r) => (queueResolver = r));
            }
            return { value: events.shift()!, done: false };
        },
    };

    // `endpointPath` may be relative (`/api/mcp/messages?sessionId=...`) or
    // absolute. Make it absolute for `fetch()`.
    const postUrl = endpointPath.startsWith("http")
        ? endpointPath
        : `${relayerUrl.replace(/\/+$/, "")}${endpointPath}`;

    return {
        postUrl,
        iter,
        abort: () => {
            controller.abort();
            void pump; // suppress unused warning
        },
    };
}

async function postMessage(postUrl: string, msg: RpcMessage): Promise<number> {
    const resp = await fetch(postUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(msg),
    });
    if (!resp.ok && resp.status !== 202) {
        const body = await resp.text();
        log.warn("bridge.post_non_ok", { status: resp.status, body: body.slice(0, 200) });
    }
    return resp.status;
}

function readStdinLines(onLine: (line: string) => void): Promise<void> {
    return new Promise((resolve) => {
        let buf = "";
        process.stdin.setEncoding("utf8");
        process.stdin.on("data", (chunk: string) => {
            buf += chunk;
            let nl: number;
            while ((nl = buf.indexOf("\n")) >= 0) {
                const line = buf.slice(0, nl).replace(/\r$/, "");
                buf = buf.slice(nl + 1);
                if (line.length > 0) onLine(line);
            }
        });
        process.stdin.on("end", () => resolve());
        process.stdin.on("close", () => resolve());
    });
}

function writeStdoutMessage(msg: RpcMessage): void {
    process.stdout.write(JSON.stringify(msg) + "\n");
}

/** Run the browser-based login flow inline — same pattern as auth-required
 * mode, but available even when creds already exist (so user can re-login,
 * switch wallets, or refresh). Returns a click-able URL near-instantly;
 * listener stays alive in the background until callback or timeout. */
async function handleLocalLogin(config: BridgeConfig): Promise<{ text: string; isError: boolean }> {
    const urlReady = new Promise<string>((resolve) => {
        loginFlow({
            relayerUrl: config.relayerUrl,
            webUrl: config.webUrl,
            label: config.label,
            timeoutMs: LOGIN_BG_TIMEOUT_MS,
            openBrowser: false,
            onUrl: (url) => resolve(url),
        })
            .then((creds) => {
                log.info("memwal_login.bridge.success", {
                    accountId: creds.accountId,
                    delegateAddress: creds.delegateAddress,
                });
            })
            .catch((err) => {
                log.warn("memwal_login.bridge.failed", {
                    msg: err instanceof Error ? err.message : String(err),
                });
            });
    });

    const timeoutPromise = new Promise<string>((_, reject) =>
        setTimeout(
            () => reject(new Error("Listener never started")),
            URL_READY_TIMEOUT_MS,
        ).unref?.() as never,
    );

    let url: string;
    try {
        url = await Promise.race([urlReady, timeoutPromise]);
    } catch (err) {
        return {
            isError: true,
            text: `❌ Failed to start login: ${err instanceof Error ? err.message : String(err)}`,
        };
    }

    return {
        isError: false,
        text: [
            `## ⚠️ ACTION REQUIRED: User must click this URL to sign in`,
            ``,
            `**URL:** ${url}`,
            ``,
            `\`\`\``,
            url,
            `\`\`\``,
            ``,
            `[Click here to open MemWal sign-in](${url})`,
            ``,
            `**IMPORTANT for the assistant**: do NOT summarize or omit the URL above.`,
            `Surface it verbatim so the user can click it.`,
            ``,
            `Steps:`,
            `1. Open the URL in any browser`,
            `2. Click **Connect Sui Wallet** and approve the on-chain \`add_delegate_key\` transaction`,
            `3. Once "Connected" appears, retry the previous request — credentials at \`~/.memwal/credentials.json\` get overwritten with the new wallet's delegate key`,
            ``,
            `_The login link stays valid for 5 minutes._`,
        ].join("\n"),
    };
}

/** Sign out by clearing the local credentials file. Does NOT revoke the
 * on-chain delegate key — that requires a separate dashboard action. */
function handleLocalLogout(): { text: string; isError: boolean } {
    try {
        clearCreds();
        log.info("memwal_logout.bridge.success", { credsPath: credsPath() });
        return {
            isError: false,
            text: [
                `✅ Signed out. Credentials removed from \`${credsPath()}\`.`,
                ``,
                `**Note:** the on-chain delegate key for this client is still registered on your MemWal account. To fully revoke access, visit the MemWal dashboard and remove the matching public key from the "Delegate Keys" section.`,
                ``,
                `Call \`memwal_login\` to sign in again with the same or a different wallet.`,
            ].join("\n"),
        };
    } catch (err) {
        return {
            isError: true,
            text: `❌ Logout failed: ${err instanceof Error ? err.message : String(err)}`,
        };
    }
}

/**
 * Open the SSE bridge and forward stdio ↔ relayer until stdin closes.
 *
 * On SSE drop (idle timeout in the Rust proxy / undici keep-alive / network
 * blip), we transparently reopen the stream — the relayer issues a fresh
 * sessionId, we route subsequent POSTs there. stdin stays open the whole
 * time, so the MCP client (Cursor / Claude Desktop / etc.) never sees the
 * reconnection.
 *
 * Two tools (`memwal_login`, `memwal_logout`) are intercepted LOCALLY and
 * never forwarded to the relayer — they manipulate the local credentials
 * file directly. They appear in `tools/list` by splicing them into the
 * relayer's response on the way back to the client.
 */
export async function runBridge(creds: MemWalCredentials, config: BridgeConfig): Promise<void> {
    note(`Connecting to ${creds.relayerUrl}...`);
    log.info("bridge.connecting", {
        relayer: creds.relayerUrl,
        accountId: creds.accountId,
        delegate: creds.delegateAddress,
    });

    // Live handle to the current SSE stream — replaced whenever we reconnect.
    let sse = await openSseStream(creds.relayerUrl, creds);
    note(`Connected. Bridging stdio MCP ↔ ${creds.relayerUrl}`);
    log.info("bridge.connected", { relayer: creds.relayerUrl });

    let stdinClosed = false;
    let reconnecting = false;
    let reconnectAttempt = 0;

    // In-flight requests pending a response. We replay them after a forced
    // reconnect so a server-side session swap doesn't strand a tool call
    // forever waiting for a reply that will never come. Notifications
    // (no id) and responses (no method) are not tracked.
    const inFlight = new Map<string | number, RpcMessage>();

    /** IDs of `tools/list` requests we've forwarded to the relayer. When
     * the response comes back through the SSE pump, we splice in the
     * locally-served `memwal_login` + `memwal_logout` tools so the MCP
     * client surfaces them in its tool palette. */
    const pendingListIds = new Set<string | number>();

    async function reconnect(reason: string): Promise<void> {
        if (stdinClosed || reconnecting) return;
        reconnecting = true;
        try {
            sse.abort();
        } catch {
            /* already dead */
        }
        const backoff = Math.min(15_000, 500 * Math.pow(2, reconnectAttempt));
        reconnectAttempt += 1;
        log.warn("bridge.reconnecting", { reason, backoffMs: backoff, attempt: reconnectAttempt });
        await new Promise((r) => setTimeout(r, backoff));
        try {
            sse = await openSseStream(creds.relayerUrl, creds);
            reconnectAttempt = 0;
            log.info("bridge.reconnected", {
                relayer: creds.relayerUrl,
                replayCount: inFlight.size,
            });
            // Replay any requests that haven't been answered yet against the
            // fresh session. Iterate over a snapshot — postMessage is async
            // and the SSE pump may delete entries concurrently as replies
            // start arriving on the new session.
            for (const [id, msg] of Array.from(inFlight.entries())) {
                try {
                    const status = await postMessage(sse.postUrl, msg);
                    log.info("bridge.replayed", { id, status });
                } catch (err) {
                    log.error("bridge.replay_failed", {
                        id,
                        err: err instanceof Error ? err.message : String(err),
                    });
                }
            }
        } catch (err) {
            log.error("bridge.reconnect_failed", {
                err: err instanceof Error ? err.message : String(err),
            });
            // Try again on the next stdin message rather than spinning.
        } finally {
            reconnecting = false;
        }
    }

    // Server → client: stream SSE messages to stdout. Loop forever, restart
    // pump on stream end (which means SSE got cut → we already reconnected).
    const serverPump = (async () => {
        while (!stdinClosed) {
            try {
                while (true) {
                    const { value, done } = await sse.iter.next();
                    if (done) break;
                    // Clear in-flight tracking once the response lands.
                    if (
                        value &&
                        (value.result !== undefined || value.error !== undefined) &&
                        value.id !== undefined &&
                        value.id !== null
                    ) {
                        inFlight.delete(value.id);
                    }
                    // Splice local tools into `tools/list` responses so
                    // memwal_login + memwal_logout appear in the client's
                    // tool palette alongside the relayer-side tools.
                    if (
                        value &&
                        value.id !== undefined &&
                        value.id !== null &&
                        pendingListIds.has(value.id) &&
                        value.result &&
                        typeof value.result === "object"
                    ) {
                        pendingListIds.delete(value.id);
                        const result = value.result as { tools?: unknown };
                        if (Array.isArray(result.tools)) {
                            result.tools = [...result.tools, ...LOCAL_TOOL_DEFINITIONS];
                        }
                    }
                    writeStdoutMessage(value);
                }
            } catch (err) {
                log.error("bridge.server_pump_error", {
                    err: err instanceof Error ? err.message : String(err),
                });
            }
            if (stdinClosed) break;
            // Stream ended unexpectedly — reconnect and resume.
            await reconnect("server-pump-eof");
        }
    })();

    // Client → server: forward stdin lines as POST messages. On 404 (the
    // relayer doesn't know our sessionId — happens right after a reconnect
    // if the message races the new handshake), trigger another reconnect.
    const clientPump = readStdinLines((line) => {
        void (async () => {
            try {
                const msg = JSON.parse(line) as RpcMessage;

                // Local interception: `memwal_login` and `memwal_logout`
                // are handled here, never sent to the relayer. The user
                // can call them any time to re-auth or sign out without
                // having to remove + re-add the MCP server.
                if (msg.method === "tools/call" && msg.id != null) {
                    const params = (msg.params ?? {}) as { name?: string };
                    if (params.name === "memwal_login") {
                        const result = await handleLocalLogin(config);
                        writeStdoutMessage({
                            jsonrpc: "2.0",
                            id: msg.id,
                            result: {
                                content: [{ type: "text", text: result.text }],
                                isError: result.isError,
                            },
                        });
                        return;
                    }
                    if (params.name === "memwal_logout") {
                        const result = handleLocalLogout();
                        writeStdoutMessage({
                            jsonrpc: "2.0",
                            id: msg.id,
                            result: {
                                content: [{ type: "text", text: result.text }],
                                isError: result.isError,
                            },
                        });
                        return;
                    }
                }

                // Fill in the configured default namespace for memory tool
                // calls that didn't pass one. Mutates msg in place so the
                // forwarded — and any replayed-on-reconnect — copy carries it.
                applyDefaultNamespace(msg, config.namespace);

                // Track `tools/list` requests so the SSE pump can splice
                // our local tools into the upstream response.
                if (msg.method === "tools/list" && msg.id != null) {
                    pendingListIds.add(msg.id);
                }

                // Track requests (have both method and id) so we can replay
                // them on reconnect. Notifications and responses are not
                // tracked.
                if (
                    msg.method !== undefined &&
                    msg.id !== undefined &&
                    msg.id !== null
                ) {
                    inFlight.set(msg.id, msg);
                }
                const status = await postMessage(sse.postUrl, msg);
                if (status === 404) {
                    log.warn("bridge.session_stale", { sessionUrl: sse.postUrl });
                    // reconnect() itself replays in-flight against the fresh
                    // session, so no explicit per-message retry is needed.
                    await reconnect("post-404");
                }
            } catch {
                log.warn("bridge.stdin_parse_failed", { line: line.slice(0, 120) });
            }
        })();
    }).then(() => {
        stdinClosed = true;
        sse.abort();
    });

    await Promise.race([serverPump, clientPump]);
    sse.abort();
    log.info("bridge.closed", {});
}
