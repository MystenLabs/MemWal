/**
 * stdio ↔ remote-SSE bridge.
 *
 * The MCP client (Cursor, Claude Desktop, etc.) speaks **stdio** MCP — JSON
 * lines on stdin, JSON lines on stdout. The Walrus Memory relayer speaks **remote
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
import { TOOL_DEFINITIONS } from "./auth-required.js";
import { ensureCompatibleRelayer, resolveConnectTimeoutMs } from "./compatibility.js";
import { PROACTIVE_INSTRUCTIONS } from "./instructions.js";
import { startOrReuseLoginFlow } from "./login.js";
import { log, note } from "./logger.js";
import { MEMWAL_MCP_VERSION } from "./version.js";

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
 * `memwal_remember_bulk`, `memwal_recall`, and `memwal_analyze` treat it as
 * optional; `memwal_restore` requires it (its upstream schema still lists
 * `namespace` as required, so agents normally pass one — but a configured
 * default is filled in if the agent calls it without). */
const NAMESPACE_TOOLS = new Set([
    "memwal_remember",
    "memwal_remember_bulk",
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
            "Sign in (or re-sign in) to Walrus Memory by opening a browser. Use to switch wallets, refresh credentials, or sign in for the first time. Returns a click-able URL — the user must approve in their browser.",
        inputSchema: {
            type: "object",
            properties: {},
            additionalProperties: false,
        },
    },
    {
        name: "memwal_logout",
        description:
            "Remove the saved Walrus Memory credentials from this machine (~/.memwal/credentials.json). The on-chain delegate key registration is NOT revoked — visit the Walrus Memory dashboard to remove it from your account if needed.",
        inputSchema: {
            type: "object",
            properties: {},
            additionalProperties: false,
        },
    },
];

/** Protocol versions this local `initialize` responder can speak. We echo the
 * client's requested version when it's one of these, else fall back to our
 * baseline — the same negotiation shape a real MCP server does. */
const SUPPORTED_PROTOCOL_VERSIONS = new Set(["2024-11-05", "2025-03-26", "2025-06-18"]);
const FALLBACK_PROTOCOL_VERSION = "2024-11-05";

/** Build the `initialize` result we answer LOCALLY and instantly, before the
 * relayer session is up. Echoes the client's requested protocolVersion when we
 * support it (otherwise the baseline) instead of hard-coding one and ignoring
 * the request. `tools.listChanged: true` is a deliberate difference from
 * auth-required mode: the bridge serves a static `tools/list` at cold start and
 * then emits `notifications/tools/list_changed` once the background relayer
 * connect completes, so the client re-lists and picks up the real upstream tool
 * set. Advertising `listChanged: false` (as auth-required does, since it never
 * refreshes) would let a client ignore that notification. */
function buildLocalInitializeResult(params: unknown): {
    protocolVersion: string;
    capabilities: { tools: { listChanged: boolean } };
    serverInfo: { name: string; version: string };
    instructions: string;
} {
    const requested = (params as { protocolVersion?: unknown } | undefined)?.protocolVersion;
    const protocolVersion =
        typeof requested === "string" && SUPPORTED_PROTOCOL_VERSIONS.has(requested)
            ? requested
            : FALLBACK_PROTOCOL_VERSION;
    return {
        protocolVersion,
        capabilities: { tools: { listChanged: true } },
        serverInfo: { name: "memwal", version: MEMWAL_MCP_VERSION },
        // The relayer sets `instructions` too, but that reply never reaches the
        // client: this local answer wins and the upstream initialize reply is
        // suppressed. Omitting it here silently strips the proactive contract
        // from every stdio client, which is the WALM-324 regression itself.
        instructions: PROACTIVE_INSTRUCTIONS,
    };
}

/** Names of the tools we serve locally, so we can de-dup them out of the
 * imported memory-tool list (which already carries its own `memwal_login`
 * entry) before appending our canonical definitions. */
const LOCAL_TOOL_NAMES = new Set(LOCAL_TOOL_DEFINITIONS.map((t) => t.name));

/** The `tools/list` we serve LOCALLY at cold start: the memory tools (from the
 * same source as auth-required mode) plus the locally-handled login/logout
 * tools. We strip any locally-served name from the imported list first —
 * `TOOL_DEFINITIONS` bundles its own `memwal_login`, and concatenating
 * `LOCAL_TOOL_DEFINITIONS` blindly would advertise `memwal_login` twice. This
 * yields the SAME shape as the post-connect spliced list (upstream memory tools
 * + login + logout, each once), so the static→refreshed transition doesn't
 * change the tool set out from under the client. OAuth-scoped sessions may
 * over-advertise write tools until `tools/list_changed` refreshes from the
 * relayer. Refreshed via
 * `tools/list_changed` once the relayer session is up. */
const LOCAL_TOOLS_LIST = {
    tools: [
        ...TOOL_DEFINITIONS.filter((t) => !LOCAL_TOOL_NAMES.has(t.name)),
        ...LOCAL_TOOL_DEFINITIONS,
    ],
};

const LOGIN_BG_TIMEOUT_MS = 5 * 60_000;
const URL_READY_TIMEOUT_MS = 5_000;

/** Maximum silence we tolerate on the SSE stream before assuming the
 * relayer-side session has gone dead. The relayer sends keepalive events
 * roughly every 3s, so 30s ≈ 10 missed heartbeats — well past any plausible
 * network blip but quick enough that a stuck tool call recovers on its own.
 *
 * Override via `MEMWAL_MCP_SSE_IDLE_MS` (mostly for tests). Values below 500ms
 * are clamped — anything tighter races the heartbeat cadence and produces
 * spurious reconnects. */
function resolveSseIdleMs(): number {
    const raw = process.env.MEMWAL_MCP_SSE_IDLE_MS;
    if (!raw) return 30_000;
    const n = Number(raw);
    if (!Number.isFinite(n) || n < 500) return 30_000;
    return n;
}

/** Longest deadline a server-side tool gives its own work (`analyze`). It
 * lives in a package this one cannot import from, so raise this whenever that
 * grows — otherwise the bridge declares healthy requests orphaned while the
 * relayer is still working. */
const SLOWEST_SERVER_TOOL_MS = 180_000;

/** 240s as the constants stand. The headroom absorbs the relayer's own
 * overhead, so expiry means the reply is lost rather than merely late. */
const DEFAULT_CALL_TIMEOUT_MS = SLOWEST_SERVER_TOOL_MS + 60_000;

/** An override below this is a mistake, not an intent. */
const MIN_CALL_TIMEOUT_MS = 1_000;

/** Without a cap, a long deadline drifts by a third of itself. */
const MAX_ORPHAN_SWEEP_MS = 5_000;

/** How long one request might sit unanswered. The idle watchdog above only sees
 * a silent *stream*, which the keepalive prevents, so a lost reply needs its
 * own deadline. Override via `MEMWAL_MCP_CALL_TIMEOUT_MS`, mostly for tests. */
function resolveCallTimeoutMs(): number {
    const raw = process.env.MEMWAL_MCP_CALL_TIMEOUT_MS;
    if (!raw) return DEFAULT_CALL_TIMEOUT_MS;
    const n = Number(raw);
    if (!Number.isFinite(n) || n < MIN_CALL_TIMEOUT_MS) return DEFAULT_CALL_TIMEOUT_MS;
    return n;
}

interface RpcMessage {
    jsonrpc: "2.0";
    id?: number | string | null;
    method?: string;
    params?: unknown;
    result?: unknown;
    error?: unknown;
}

/** A request forwarded upstream and still awaiting its response. */
interface InFlightEntry {
    msg: RpcMessage;
    startedAt: number;
}

interface SseHandshakeResult {
    /** Absolute URL the client must POST to for outbound JSON-RPC messages. */
    postUrl: string;
    /** Per-line iterator for incoming SSE messages (already-parsed JSON-RPC). */
    iter: AsyncIterator<RpcMessage>;
    /** Abort + close the SSE stream. */
    abort: () => void;
}

function mcpAuthHeaders(creds: MemWalCredentials): Record<string, string> {
    return {
        authorization: `Bearer ${creds.delegatePrivateKey}`,
        "x-memwal-account-id": creds.accountId,
    };
}

async function openSseStream(
    relayerUrl: string,
    creds: MemWalCredentials,
): Promise<SseHandshakeResult> {
    const connectTimeoutMs = resolveConnectTimeoutMs();
    // One shared budget for the WHOLE attempt: the compatibility check (GET
    // /version + /health fallback) and the SSE connect below both honour this
    // single deadline, so an attempt is bounded by connectTimeoutMs in total
    // rather than each step getting its own (which could sum to 2–3×).
    const budgetSignal = AbortSignal.timeout(connectTimeoutMs);
    await ensureCompatibleRelayer(relayerUrl, budgetSignal);

    const url = `${relayerUrl.replace(/\/+$/, "")}/api/mcp/sse`;
    const controller = new AbortController();

    // Bound the INITIAL connect (headers + the wait-for-`endpoint`-event loop
    // below) on the SAME shared budget as the compat check above, so a hung
    // relayer aborts well before the MCP client's ~30s timeout and one attempt
    // never exceeds connectTimeoutMs total. This is distinct from the idle
    // watchdog, which only bounds silence AFTER the stream is up. When the
    // budget fires we abort `controller` (so the in-flight fetch/read unwinds);
    // we detach the listener the instant the endpoint resolves — past that
    // point the idle watchdog owns liveness and this must never fire, or it
    // would tear down a healthy stream.
    let connectTimedOut = false;
    const onBudgetExpired = (): void => {
        if (!controller.signal.aborted) {
            connectTimedOut = true;
            log.warn("bridge.connect_timeout", { url, timeoutMs: connectTimeoutMs });
            controller.abort();
        }
    };
    // If the compat check already burned the whole budget, `budgetSignal` is
    // already aborted — fire synchronously so we don't even attempt the SSE GET.
    if (budgetSignal.aborted) onBudgetExpired();
    else budgetSignal.addEventListener("abort", onBudgetExpired, { once: true });
    const clearConnectTimer = (): void =>
        budgetSignal.removeEventListener("abort", onBudgetExpired);

    let resp: Response;
    try {
        resp = await fetch(url, {
            method: "GET",
            headers: {
                ...mcpAuthHeaders(creds),
                accept: "text/event-stream",
                "cache-control": "no-cache",
            },
            signal: controller.signal,
        });
    } catch (err) {
        clearConnectTimer();
        if (connectTimedOut) {
            throw new Error(
                `Walrus Memory relayer SSE connect timed out after ${connectTimeoutMs}ms ` +
                    `(${url}). The relayer may be slow, cold-starting, or unreachable.`
            );
        }
        throw err;
    }

    if (resp.status === 401) {
        clearConnectTimer();
        if (resp.body) {
            await resp.text().catch(() => "");
        }
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
            "Walrus Memory relayer rejected credentials (HTTP 401). " +
                "Delegate key may have been revoked, the relayer may be " +
                "rate-limiting, or a proxy may be interposed. Saved " +
                `credentials at ${credsPath()} were NOT modified. ` +
                "Run `memwal-mcp login` if you need to rotate the key."
        );
    }
    if (resp.status === 429) {
        clearConnectTimer();
        const retryAfter = resp.headers.get("retry-after");
        const body = resp.body ? await resp.text() : "";
        throw new Error(
            `Walrus Memory relayer SSE handshake rate-limited (HTTP 429` +
                `${retryAfter ? `, retry after ${retryAfter}s` : ""}). ${body.slice(0, 200)}`.trim()
        );
    }
    if (!resp.ok || !resp.body) {
        clearConnectTimer();
        const body = resp.body ? await resp.text() : "";
        throw new Error(
            `Walrus Memory relayer SSE handshake failed: HTTP ${resp.status} ${body.slice(0, 200)}`
        );
    }

    const ct = resp.headers.get("content-type") ?? "";
    if (!ct.includes("event-stream")) {
        clearConnectTimer();
        if (resp.body) {
            await resp.text().catch(() => "");
        }
        throw new Error(
            `Walrus Memory relayer returned unexpected content-type "${ct}" for SSE endpoint`
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

    // Heartbeat watchdog: an alive SSE session emits keepalive events every
    // few seconds. If reader.read() stops yielding chunks entirely, the
    // server-side session has gone dead even though the TCP socket may still
    // be open (observed in the wild: relayer session state silently dropped
    // while the bridge waited forever for a response that never arrived,
    // because the next POST landed in the void). Abort the controller — the
    // catch block sets streamEnded=true and runBridge's serverPump triggers
    // reconnect("server-pump-eof"), which replays any in-flight requests on
    // the fresh session.
    const idleTimeoutMs = resolveSseIdleMs();
    const checkIntervalMs = Math.max(500, Math.floor(idleTimeoutMs / 3));
    let lastChunkAt = Date.now();
    const watchdog = setInterval(() => {
        const idleMs = Date.now() - lastChunkAt;
        if (idleMs > idleTimeoutMs && !controller.signal.aborted) {
            log.warn("bridge.sse_idle_watchdog_fired", { idleMs, idleTimeoutMs });
            controller.abort();
        }
    }, checkIntervalMs);
    // unref so the watchdog never holds the event loop open during shutdown.
    watchdog.unref?.();

    // Pump the SSE stream in the background.
    const pump = (async () => {
        try {
            while (true) {
                const { done, value } = await reader.read();
                if (done) break;
                lastChunkAt = Date.now();
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
            clearInterval(watchdog);
            streamEnded = true;
            // Wake any waiter so they see EOF.
            wake();
        }
    })();

    // Wait for the `endpoint` event (or first message) before returning.
    while (!endpointResolved) {
        if (streamEnded) {
            clearConnectTimer();
            controller.abort();
            if (connectTimedOut) {
                throw new Error(
                    `Walrus Memory relayer SSE connect timed out after ${connectTimeoutMs}ms ` +
                        `(${url}) waiting for the endpoint event. The relayer may be slow, ` +
                        `cold-starting, or unreachable.`
                );
            }
            throw new Error(
                `Walrus Memory relayer SSE handshake ended before endpoint event${streamError ? `: ${streamError}` : ""}`
            );
        }
        await new Promise<void>((r) => (queueResolver = r));
    }

    // Endpoint resolved — the stream is up. Hand liveness over to the idle
    // watchdog and disarm the connect timer so it can never abort a healthy
    // stream.
    clearConnectTimer();

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

async function postMessage(
    postUrl: string,
    msg: RpcMessage,
    creds: MemWalCredentials,
): Promise<number> {
    const resp = await fetch(postUrl, {
        method: "POST",
        headers: {
            ...mcpAuthHeaders(creds),
            "content-type": "application/json",
        },
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
async function handleLocalLogin(
    config: BridgeConfig,
    onCredentials: (creds: MemWalCredentials) => Promise<void>,
): Promise<{ text: string; isError: boolean }> {
    const session = startOrReuseLoginFlow(
        {
            relayerUrl: config.relayerUrl,
            webUrl: config.webUrl,
            label: config.label,
            timeoutMs: LOGIN_BG_TIMEOUT_MS,
            openBrowser: false,
        },
        async (creds) => {
            await onCredentials(creds);
            log.info("memwal_login.bridge.success", {
                accountId: creds.accountId,
                delegateAddress: creds.delegateAddress,
            });
        },
    );

    const timeoutPromise = new Promise<string>((_, reject) =>
        setTimeout(
            () => reject(new Error("Listener never started")),
            URL_READY_TIMEOUT_MS,
        ).unref?.() as never,
    );

    let url: string;
    try {
        url = await Promise.race([session.url, timeoutPromise]);
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
            `[Click here to open Walrus Memory sign-in](${url})`,
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
        const cleared = clearCreds();
        log.info("memwal_logout.bridge.success", {
            removedPath: cleared.removedPath ?? null,
            fallbackPath: cleared.fallbackPath ?? null,
        });
        if (!cleared.removedPath) {
            return {
                isError: false,
                text: `✅ Already signed out. No credentials at \`${credsPath()}\`.`,
            };
        }
        return {
            isError: false,
            text: [
                `✅ Signed out. Credentials removed from \`${cleared.removedPath}\`.`,
                ...(cleared.fallbackPath
                    ? [
                          ``,
                          `**Still signed in elsewhere:** \`${cleared.fallbackPath}\` remains and is ` +
                              `what the next run loads, under a possibly different account. Remove ` +
                              `that file too to sign out everywhere.`,
                      ]
                    : []),
                ``,
                `**Note:** the on-chain delegate key for this client is still registered on your Walrus Memory account. To fully revoke access, visit the Walrus Memory dashboard and remove the matching public key from the "Delegate Keys" section.`,
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
export async function runBridge(
    creds: MemWalCredentials,
    config: BridgeConfig,
    /** Requests the auth-required server already read off stdin before it
     * detected fresh credentials and handed control here (e.g. the
     * `memwal_recall` that triggered the hot-handoff). Replayed once the SSE
     * stream is up so they're served for real instead of being lost in the
     * mode switch — this is what removes the historical "second restart". */
    pendingLines: string[] = [],
): Promise<void> {
    note(`Connecting to ${creds.relayerUrl}...`);
    log.info("bridge.connecting", {
        relayer: creds.relayerUrl,
        accountId: creds.accountId,
        delegate: creds.delegateAddress,
    });

    // Live handle to the current SSE stream — replaced whenever we reconnect.
    // Starts null: we answer `initialize` / `tools/list` LOCALLY and wire stdin
    // BEFORE the relayer session exists, so the MCP client's handshake never
    // waits on a (possibly slow / cold) relayer round-trip. The connect runs in
    // the background; anything that must reach the relayer (`tools/call`) is
    // buffered in `pendingForward` until `sse` is live, then flushed.
    let sse: SseHandshakeResult | null = null;

    let stdinClosed = false;
    let reconnectAttempt = 0;
    let reconnectPromise: Promise<void> | null = null;
    let firstConnectDone = false;
    /** Bumped when the live SSE session is aborted or replaced so queued
     * POSTs captured against a stale URL are skipped (reconnect replays). */
    let sessionEpoch = 0;
    /** One in-flight POST per SSE session — overlapping POSTs drop the stream. */
    let postChain: Promise<unknown> = Promise.resolve();
    function enqueuePost<T>(fn: () => Promise<T>): Promise<T> {
        const run = postChain.then(fn, fn);
        postChain = run.then(
            () => undefined,
            () => undefined,
        );
        return run;
    }
    function postIfCurrent(
        epoch: number,
        postUrl: string,
        msg: RpcMessage,
        postCreds: MemWalCredentials,
    ): Promise<number> {
        if (epoch !== sessionEpoch) return Promise.resolve(0);
        return postMessage(postUrl, msg, postCreds);
    }
    let credentialGeneration = 0;
    let activeCredentialGeneration = 0;

    /** Callbacks to run once, the moment stdin closes — used to wake anything
     * parked on a timer (e.g. the connect-retry backoff) so shutdown is prompt
     * instead of waiting out the timer. `markStdinClosed` is the single writer
     * of `stdinClosed`; call it instead of assigning the flag directly. */
    const stdinCloseListeners = new Set<() => void>();
    /** Register a shutdown callback. Returns an unregister fn so a caller that
     * only cares about shutdown *while it's parked* (e.g. one backoff sleep) can
     * detach when it wakes normally — otherwise the set would grow one stale
     * closure per retry for the whole session. Fires immediately if already
     * closed (unregister is then a no-op). */
    function onStdinClose(fn: () => void): () => void {
        if (stdinClosed) {
            fn();
            return () => {};
        }
        stdinCloseListeners.add(fn);
        return () => stdinCloseListeners.delete(fn);
    }
    function markStdinClosed(): void {
        if (stdinClosed) return;
        stdinClosed = true;
        for (const fn of stdinCloseListeners) {
            try {
                fn();
            } catch {
                /* listener failure must not block shutdown */
            }
        }
        stdinCloseListeners.clear();
    }

    /** Requests that arrived before the relayer session came up. Held here and
     * flushed in order once `sse` is live. `tools/call` (and any other request
     * that must reach the relayer) lands here; `tools/list` and
     * `memwal_login|logout` are answered locally and never buffered. `initialize`
     * IS buffered (to forward upstream for capability negotiation) but is never
     * failed back — `failRequest` skips `method === "initialize"`. */
    const pendingForward: RpcMessage[] = [];

    /** True while `flushPendingForward` is draining the buffer after the first
     * connect. New stdin requests that arrive mid-drain must keep buffering
     * rather than posting directly, or they'd overtake still-queued items and
     * break arrival order. */
    let flushing = false;

    /** Resolves the first time the SSE stream is up (or when stdin closes before
     * that ever happens). `serverPump` waits on this before reading from
     * `sse.iter`; after it resolves, `sse` is either a live handle or null
     * (stdin closed) — the pump loop guards on both. Idempotent. */
    let signalFirstConnect: () => void = () => {};
    let firstConnectSignaled = false;
    const firstConnect = new Promise<void>((r) => {
        signalFirstConnect = () => {
            if (firstConnectSignaled) return;
            firstConnectSignaled = true;
            r();
        };
    });

    /** Expected-suppression COUNT per id, for requests we answered locally but
     * still forwarded upstream (currently just `initialize`, so the relayer
     * session negotiates capabilities). The upstream reply must be dropped in
     * the pump — the client already has our local reply, and a second response
     * for the same id corrupts its JSON-RPC state.
     *
     * A count (not a bare Set) so suppression is EXACT and self-limiting: we
     * expect exactly one upstream reply per forward, so we increment on each
     * forward (initial + every reconnect replay) and decrement on each dropped
     * reply, removing the id at zero. Once the initialize replies are all
     * consumed, the id stops suppressing — so a client that later REUSES the
     * initialize id for a real request gets that request's genuine reply
     * (result OR error) through, instead of it being swallowed forever. */
    const suppressUpstreamReplies = new Map<string | number, number>();

    /** IDs we've already answered with a shutdown "unavailable" envelope
     * (`failRequest`). If a late upstream reply for one of these still arrives —
     * e.g. a flush-404 reconnect re-posted the request onto a live session that
     * answers just as we were closing out at shutdown — the pump must DROP it,
     * or the client would get two responses for one id. */
    const closedOutIds = new Set<string | number>();

    const expectSuppressedReply = (id: string | number): void => {
        suppressUpstreamReplies.set(id, (suppressUpstreamReplies.get(id) ?? 0) + 1);
    };
    /** Consume one expected suppression for `id`. Returns true if the reply
     * should be dropped (an outstanding local-answer suppression existed). */
    const consumeSuppressedReply = (id: string | number): boolean => {
        const n = suppressUpstreamReplies.get(id);
        if (!n) return false;
        if (n <= 1) suppressUpstreamReplies.delete(id);
        else suppressUpstreamReplies.set(id, n - 1);
        return true;
    };

    // In-flight requests pending a response. We replay them after a forced
    // reconnect so a server-side session swap doesn't strand a tool call
    // forever waiting for a reply that will never come. Notifications
    // (no id) and responses (no method) are not tracked.
    // `startedAt` is never refreshed, not even by a replay: a reconnect loop
    // would otherwise keep pushing the deadline out.
    const inFlight = new Map<string | number, InFlightEntry>();
    const callTimeoutMs = resolveCallTimeoutMs();

    /** IDs of `tools/list` requests we've forwarded to the relayer. When
     * the response comes back through the SSE pump, we splice in the
     * locally-served `memwal_login` + `memwal_logout` tools so the MCP
     * client surfaces them in its tool palette. */
    const pendingListIds = new Set<string | number>();

    /** Reopen the SSE stream and replay outstanding `inFlight` requests against
     * the fresh session. All callers await the SAME reconnect via
     * `reconnectPromise` — returning immediately while one is active would let
     * the server pump spin on the aborted stream and let client messages race
     * the stale POST URL. Any reconnect replays the WHOLE `inFlight` map, so
     * callers must treat every id-bearing request as reconnect-owned and never
     * re-post it themselves. `immediate` skips the backoff (used right after a
     * login credential swap). Credential-generation checks discard a session
     * whose key rotated mid-handshake. */
    async function reconnect(reason: string, immediate = false): Promise<void> {
        if (stdinClosed) return;
        if (reconnectPromise) return reconnectPromise;

        reconnectPromise = (async () => {
            sessionEpoch += 1;
            try {
                sse?.abort();
            } catch {
                /* already dead */
            }
            const backoff = immediate
                ? 0
                : Math.min(15_000, 500 * Math.pow(2, reconnectAttempt));
            reconnectAttempt += 1;
            log.warn("bridge.reconnecting", {
                reason,
                backoffMs: backoff,
                attempt: reconnectAttempt,
            });
            // Sleep, but wake immediately on stdin close so shutdown isn't held
            // up for the whole backoff; unref'd so the timer never keeps the
            // event loop alive on its own (mirrors the connect-retry backoff).
            if (backoff > 0) {
                await new Promise<void>((resolve) => {
                    const timer = setTimeout(() => {
                        unregister();
                        resolve();
                    }, backoff);
                    timer.unref?.();
                    const unregister = onStdinClose(() => {
                        clearTimeout(timer);
                        resolve();
                    });
                });
            }
            try {
                while (!stdinClosed) {
                    const openingGeneration = credentialGeneration;
                    const openingCreds = creds;
                    const candidate = await openSseStream(
                        openingCreds.relayerUrl,
                        openingCreds,
                    );

                    // Login can finish while an older handshake is awaiting its
                    // endpoint event. Never publish that stale session: its GET
                    // used the old key, while subsequent POSTs would use the new
                    // key and fail session authentication.
                    if (openingGeneration !== credentialGeneration) {
                        candidate.abort();
                        log.info("bridge.reconnect_discarded_stale_credentials", {
                            openingGeneration,
                            credentialGeneration,
                        });
                        continue;
                    }

                    sessionEpoch += 1;
                    sse = candidate;
                    firstConnectDone = true;
                    activeCredentialGeneration = openingGeneration;
                    reconnectAttempt = 0;
                    log.info("bridge.reconnected", {
                        relayer: openingCreds.relayerUrl,
                        replayCount: inFlight.size,
                        // The count alone cannot tell "nothing was pending"
                        // from "the entry was dropped early" — the ambiguity
                        // behind WALM-328's unexplained `replayCount: 0`.
                        inFlight: Array.from(inFlight.entries()).map(([id, entry]) => ({
                            id,
                            method: entry.msg.method ?? null,
                        })),
                    });
                    // Replay any requests that haven't been answered yet against the
                    // fresh session. Iterate over a snapshot — postMessage is async
                    // and the SSE pump may delete entries concurrently as replies
                    // start arriving on the new session.
                    for (const [id, entry] of Array.from(inFlight.entries())) {
                        const msg = entry.msg;
                        try {
                            // A replayed `initialize` produces a fresh upstream
                            // reply on the NEW session that must also be dropped.
                            // REPLACE (not stack) any pending suppression for this
                            // id: the old session was aborted, so its initialize
                            // reply will never arrive to consume its own arm.
                            // Re-arming without clearing would leave that orphaned
                            // arm forever, and a later reused id would have its
                            // real reply wrongly dropped. Reset to exactly one —
                            // the single reply the new session will send.
                            if (msg.method === "initialize" && msg.id != null) {
                                suppressUpstreamReplies.delete(msg.id);
                                expectSuppressedReply(msg.id);
                            }
                            const epoch = sessionEpoch;
                            const postUrl = sse.postUrl;
                            const status = await enqueuePost(() =>
                                postIfCurrent(epoch, postUrl, msg, openingCreds),
                            );
                            log.info("bridge.replayed", { id, status });
                        } catch (err) {
                            log.error("bridge.replay_failed", {
                                id,
                                err: err instanceof Error ? err.message : String(err),
                            });
                        }
                    }
                    // Credentials can also rotate while replay awaits POSTs.
                    // In that case this candidate is already stale even though
                    // it passed the first generation check.
                    if (openingGeneration !== credentialGeneration) {
                        candidate.abort();
                        // The replay above armed one initialize suppression for
                        // THIS (now-discarded) candidate; its reply will never
                        // arrive to consume it. Clear those arms so the count
                        // doesn't leak if the loop exits before another replay
                        // re-arms (a leaked arm would swallow a later reused-id
                        // reply). A surviving candidate re-arms fresh next pass.
                        for (const [, entry] of inFlight) {
                            if (entry.msg.method === "initialize" && entry.msg.id != null) {
                                suppressUpstreamReplies.delete(entry.msg.id);
                            }
                        }
                        continue;
                    }
                    break;
                }
            } catch (err) {
                log.error("bridge.reconnect_failed", {
                    err: err instanceof Error ? err.message : String(err),
                });
                // Try again on the next stdin message rather than spinning.
            }
        })();

        try {
            await reconnectPromise;
        } finally {
            reconnectPromise = null;
        }
    }

    async function adoptCredentials(nextCreds: MemWalCredentials): Promise<void> {
        const previousAccountId = creds.accountId;
        const accountChanged = previousAccountId !== nextCreds.accountId;

        // Never replay an operation authorized for account A against account B.
        // Return explicit retryable errors instead; the caller can decide which
        // operations belong in the newly-selected account.
        if (accountChanged) {
            try {
                sse?.abort();
            } catch {
                /* already dead */
            }
            // Purge EVERY structure that holds an account-A request. `inFlight`
            // (tracked requests) AND `pendingForward` (cold-start / mid-flush
            // buffered requests) — the latter is unique to the cold-start path
            // and would otherwise be flushed to account B's session (a
            // cross-account replay) since the flush posts with the current
            // `creds`. For each, reply once with a retryable error and stop
            // tracking; never write a second reply for a locally-answered
            // `initialize`. Keep its one-shot suppress arm so a queued
            // upstream initialize reply is consumed. Do not put initialize in
            // closedOutIds — a later reused id must still get a real reply.
            const purge = (msg: RpcMessage): void => {
                if (msg.id == null) return; // notification — nothing to reply to
                pendingListIds.delete(msg.id);
                if (msg.method === "initialize") {
                    return;
                }
                suppressUpstreamReplies.delete(msg.id);
                // A request can be in BOTH inFlight and pendingForward (cold-start
                // dual-tracking), so guard against answering the same id twice.
                if (closedOutIds.has(msg.id)) return;
                // Record the id so a late reply for it (e.g. one already
                // in-flight on the aborted session, or a racing replay) is
                // dropped by the pump rather than becoming a second response.
                closedOutIds.add(msg.id);
                writeStdoutMessage({
                    jsonrpc: "2.0",
                    id: msg.id,
                    error: {
                        code: -32001,
                        message:
                            "Walrus Memory account changed during login; retry this request for the new account",
                    },
                });
            };
            for (const [, entry] of Array.from(inFlight.entries())) purge(entry.msg);
            inFlight.clear();
            for (const msg of pendingForward.splice(0, pendingForward.length)) purge(msg);
        } else {
            // Same account: reconnect() owns inFlight. Drop id-bearing
            // pendingForward so a login mid-flush cannot POST the same
            // remember/recall again after replay.
            const leftover = pendingForward.filter((m) => m.id == null);
            pendingForward.length = 0;
            pendingForward.push(...leftover);
        }

        creds = nextCreds;
        credentialGeneration += 1;
        reconnectAttempt = 0;
        log.info("bridge.credentials_updated", {
            previousAccountId,
            accountId: creds.accountId,
            delegate: creds.delegateAddress,
        });
        await reconnect("login-credentials-updated", true);
        // Covers the narrow case where this update joined a reconnect just as
        // its promise was resolving, after its final generation check.
        if (activeCredentialGeneration !== credentialGeneration) {
            await reconnect("login-credentials-generation-mismatch", true);
        }
    }

    // Server → client: stream SSE messages to stdout. Loop forever, restart
    // pump on stream end (which means SSE got cut → we already reconnected).
    const serverPump = (async () => {
        // Nothing to pump until the first relayer session is up. `firstConnect`
        // resolves only on a SUCCESSFUL connect (the background connector
        // retries failures with backoff), unless stdin closed first — in which
        // case `sse` stays null and we exit the loop immediately.
        await firstConnect;
        while (!stdinClosed) {
            try {
                // Snapshot the current stream. `sse` is non-null here: set before
                // signalFirstConnect(), and reconnect() only ever replaces it with
                // another live handle. Reading through a local keeps us on one
                // stream for the duration of this drain; a reconnect swaps `sse`
                // and we pick up the new handle on the next outer iteration.
                // Cast: TS control-flow narrows `sse` to `null` in the outer
                // scope because every non-null assignment happens inside a
                // sibling closure (connectInBackground / reconnect) that TS
                // analyzes independently. At runtime `sse` is a live handle here.
                const stream = sse as SseHandshakeResult | null;
                if (!stream) break; // stdin closed before we ever connected
                while (true) {
                    const { value, done } = await stream.iter.next();
                    if (done) break;
                    // Drop the upstream reply to a request we already answered
                    // locally (e.g. `initialize`). Writing it would be a second
                    // response for the same id. We consume exactly ONE expected
                    // suppression per id (see suppressUpstreamReplies), so once
                    // the initialize reply(s) are drained the id stops
                    // suppressing — a client that later reuses that id for a real
                    // request still gets THAT request's reply (result or error).
                    if (
                        value &&
                        value.id !== undefined &&
                        value.id !== null &&
                        (value.result !== undefined || value.error !== undefined) &&
                        consumeSuppressedReply(value.id)
                    ) {
                        inFlight.delete(value.id);
                        continue;
                    }
                    // Drop a late reply for an id we already closed out at
                    // shutdown — writing it would be a second response for that
                    // id (see closedOutIds / failRequest).
                    if (
                        value &&
                        value.id !== undefined &&
                        value.id !== null &&
                        (value.result !== undefined || value.error !== undefined) &&
                        closedOutIds.has(value.id)
                    ) {
                        inFlight.delete(value.id);
                        continue;
                    }
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
                            // Strip any locally-served name from the upstream set
                            // before appending ours, so a relayer that ever
                            // advertises login/logout itself can't produce a
                            // duplicate tool name. Mirrors LOCAL_TOOLS_LIST.
                            const upstream = (result.tools as { name?: string }[]).filter(
                                (t) => !LOCAL_TOOL_NAMES.has(t.name ?? ""),
                            );
                            result.tools = [...upstream, ...LOCAL_TOOL_DEFINITIONS];
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
            // Stream ended. If a reconnect is ALREADY in progress (e.g. the
            // flush hit a 404), await THAT one rather than hammering reconnect()
            // — otherwise this loop would spin on the dead stream's immediate
            // `done`. reconnect() itself returns the shared reconnectPromise when
            // one is active, so awaiting it here is enough; on the next
            // iteration `sse` has been swapped to the fresh session and we
            // resume reading. If no reconnect is in progress, this starts one.
            await reconnect("server-pump-eof");
        }
    })();

    // Client → server: forward stdin lines as POST messages. On 404 (the
    // relayer doesn't know our sessionId — happens right after a reconnect
    // if the message races the new handshake), trigger another reconnect.
    const handleClientLine = (line: string): void => {
        void (async () => {
            try {
                const msg = JSON.parse(line) as RpcMessage;

                // Answer `initialize` LOCALLY and instantly so the MCP client's
                // handshake never waits on the relayer connect (the cold-start
                // bug). We STILL forward it upstream (below) so the relayer
                // session negotiates capabilities — but suppress that upstream
                // reply, since the client already has this one.
                if (msg.method === "initialize" && msg.id != null) {
                    writeStdoutMessage({
                        jsonrpc: "2.0",
                        id: msg.id,
                        result: buildLocalInitializeResult(msg.params),
                    });
                    // Expect exactly one upstream reply to drop for this forward.
                    expectSuppressedReply(msg.id);
                    // Fall through: forward/buffer the initialize upstream too.
                }

                // Answer `tools/list` LOCALLY at cold start (before the relayer
                // session exists) so tool discovery unblocks immediately. Once
                // connected we emit `notifications/tools/list_changed` and the
                // client re-lists — that re-list is forwarded upstream and gets
                // the real tool set spliced (handled further down + in the pump).
                if (msg.method === "tools/list" && msg.id != null && sse === null) {
                    writeStdoutMessage({
                        jsonrpc: "2.0",
                        id: msg.id,
                        result: LOCAL_TOOLS_LIST,
                    });
                    return;
                }

                // Local interception: `memwal_login` and `memwal_logout`
                // are handled here, never sent to the relayer. The user
                // can call them any time to re-auth or sign out without
                // having to remove + re-add the MCP server.
                if (msg.method === "tools/call" && msg.id != null) {
                    const params = (msg.params ?? {}) as { name?: string };
                    // Tool NAME only, never `arguments` — memory text is the
                    // user's private data and must not reach a log file.
                    // Without this the only trace of a call is the host's own
                    // `method="tools/call" id=N` line, which cannot say WHICH
                    // tool ran. Scoring the WALM-368 T1-T3 cases needs exactly
                    // that: "remember never fired" and "remember fired and
                    // failed" are different bugs that looked identical.
                    log.info("bridge.tool_call", {
                        tool: params.name ?? null,
                        id: msg.id,
                    });
                    if (params.name === "memwal_login") {
                        const result = await handleLocalLogin(config, adoptCredentials);
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
                    inFlight.set(msg.id, { msg, startedAt: Date.now() });
                }
                // Relayer session not up yet, OR the post-connect flush is still
                // draining — buffer so this request stays behind everything that
                // arrived before it (posting directly here would let it overtake
                // a still-queued buffered item). The flush (or the next connect)
                // forwards it in order. Dropping it would strand the request.
                if (flushing || (sse === null && !firstConnectDone)) {
                    pendingForward.push(msg);
                    log.info("bridge.buffered_pre_connect", {
                        method: msg.method,
                        id: msg.id ?? null,
                    });
                    return;
                }
                // After the first connect, do not buffer: nothing flushes
                // pendingForward once connectInBackground has returned.
                if (sse === null) {
                    await reconnect("sse-missing");
                    return;
                }

                // A successful background login swaps credentials and SSE
                // sessions asynchronously. Wait for that swap before sending a
                // new request so it cannot race the stale session URL/key.
                if (reconnectPromise) await reconnectPromise;
                if (activeCredentialGeneration !== credentialGeneration) {
                    await reconnect("post-credential-generation-mismatch", true);
                }
                if (!sse) {
                    await reconnect("sse-missing");
                    return;
                }
                const epoch = sessionEpoch;
                const postUrl = sse.postUrl;
                const postCreds = creds;
                const status = await enqueuePost(() =>
                    postIfCurrent(epoch, postUrl, msg, postCreds),
                );
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
    };

    /** Flush everything buffered before the session came up, in arrival order,
     * then announce the real tool set. Called once, right after the first
     * successful connect. `flushing` keeps concurrently-arriving stdin requests
     * buffering (rather than posting directly and overtaking the queue); we
     * drain until the buffer is empty so those late arrivals are forwarded too. */
    async function flushPendingForward(): Promise<void> {
        flushing = true;
        try {
            if (pendingForward.length > 0) {
                log.info("bridge.flushing_pre_connect", { count: pendingForward.length });
            }
            while (pendingForward.length > 0) {
                if (stdinClosed) {
                    // Shutting down mid-flush: don't post to a torn-down session.
                    // Everything still buffered (plus what we've already shifted
                    // into inFlight but not delivered) is closed out below.
                    break;
                }
                if (!sse) break; // lost the session; reconnect replays inFlight
                const msg = pendingForward.shift()!;
                try {
                    const epoch = sessionEpoch;
                    const postUrl = sse.postUrl;
                    const postCreds = creds;
                    const status = await enqueuePost(() =>
                        postIfCurrent(epoch, postUrl, msg, postCreds),
                    );
                    if (status === 404) {
                        // Stale session right after connect. EVERY id-bearing
                        // request is in `inFlight`, and ANY reconnect — this
                        // flush's own, or a concurrent `server-pump-eof` one that
                        // shares the same `reconnectPromise` — replays the whole
                        // `inFlight` map against the fresh session. So id-bearing
                        // items are owned by reconnect, period; re-posting them
                        // from the flush would duplicate them (double write +
                        // two replies for one id). We therefore drop ALL
                        // id-bearing items from the queue after reconnect and
                        // keep only id-less notifications (never in `inFlight`,
                        // so no reconnect carries them) to re-drain. `await
                        // reconnect()` resolves the shared reconnectPromise, so
                        // `inFlight` has been fully replayed by the time we
                        // decide what's left to send — no matter which caller
                        // owns the reconnect.
                        log.warn("bridge.session_stale", { sessionUrl: sse.postUrl });
                        if (msg.id == null) pendingForward.unshift(msg);
                        await reconnect("post-404");
                        const notifications = pendingForward.filter((m) => m.id == null);
                        pendingForward.length = 0;
                        pendingForward.push(...notifications);
                        continue;
                    }
                } catch (err) {
                    log.error("bridge.flush_failed", {
                        id: msg.id ?? null,
                        err: err instanceof Error ? err.message : String(err),
                    });
                }
            }
        } finally {
            flushing = false;
        }
        // If stdin closed while we were draining, close out anything still open
        // (buffered + already-in-inFlight-but-undelivered) so those calls get an
        // error envelope instead of hanging until the client's own timeout.
        if (stdinClosed) {
            failPendingForward("connection lost during shutdown");
            failInFlightRequests("connection lost during shutdown");
            return;
        }
        // The client discovered tools from our static `tools/list`. Now that the
        // real relayer session is up, tell it to re-list so it picks up the
        // authoritative upstream set (spliced with login/logout in the pump).
        writeStdoutMessage({
            jsonrpc: "2.0",
            method: "notifications/tools/list_changed",
        });
    }

    /** Write a failure reply for one open request, stop tracking it, and never
     * double-answer a locally-answered request. Shared by the buffered
     * (`failPendingForward`) and in-flight (`failInFlightRequests`) close-outs,
     * and by the orphan sweeper — which passes `opts` because "relayer
     * unavailable" would be a lie there: the relayer is fine, one reply just
     * never arrived. Skips:
     *   - notifications (no id → nothing to reply to; also unforwardable now).
     *   - `initialize` (we already answered it locally; a second response for
     *     that id would corrupt the client's JSON-RPC state — just untrack).
     * Only `tools/call` shaped requests get the tool-result error envelope; any
     * other id-bearing request gets a JSON-RPC error object (the correct shape
     * for a non-tool request). */
    function failRequest(
        msg: RpcMessage,
        reason: string,
        opts: { toolText?: string; errorMessage?: string } = {},
    ): void {
        if (msg.id == null) return; // notification — nothing to answer
        if (msg.method === "initialize") {
            // Locally answered already. Never write a second reply for this id.
            // Keep any suppress arm so a late upstream initialize result is
            // consumed; do not closedOut the id (clients may reuse it later).
            inFlight.delete(msg.id);
            return;
        }
        inFlight.delete(msg.id);
        // Remember we answered this id, so a late genuine reply (e.g. from a
        // flush-404 reconnect that re-posted onto a live session) is dropped by
        // the pump instead of becoming a second response for the same id.
        closedOutIds.add(msg.id);
        if (msg.method === "tools/call") {
            writeStdoutMessage({
                jsonrpc: "2.0",
                id: msg.id,
                result: {
                    content: [
                        {
                            type: "text",
                            text:
                                opts.toolText ??
                                `❌ Walrus Memory relayer unavailable: ${reason}. The memory tool could not run. Please retry shortly.`,
                        },
                    ],
                    isError: true,
                },
            });
        } else {
            writeStdoutMessage({
                jsonrpc: "2.0",
                id: msg.id,
                error: {
                    code: -32000,
                    message:
                        opts.errorMessage ??
                        `Walrus Memory relayer unavailable: ${reason}`,
                },
            });
        }
    }

    function failPendingForward(reason: string): void {
        const queued = pendingForward.splice(0, pendingForward.length);
        for (const msg of queued) failRequest(msg, reason);
    }

    /** Close out requests that reached `inFlight` but were never delivered a
     * reply — the shutdown counterpart of `failPendingForward`. Used when stdin
     * closes mid-flush: items already shifted out of `pendingForward` and posted
     * to a torn-down session would otherwise hang, since no upstream reply is
     * coming. Idempotent w.r.t. ids already closed out (delete-then-skip). */
    function failInFlightRequests(reason: string): void {
        for (const entry of Array.from(inFlight.values())) failRequest(entry.msg, reason);
    }

    /** Close out requests whose deadline has passed. Without this a reply lost
     * on a still-healthy stream leaves its request tracked forever. */
    // Same shape as the SSE watchdog's check interval, but capped.
    const sweepIntervalMs = Math.min(
        MAX_ORPHAN_SWEEP_MS,
        Math.max(500, Math.floor(callTimeoutMs / 3)),
    );
    const orphanSweeper = setInterval(() => {
        const now = Date.now();
        for (const [id, entry] of Array.from(inFlight.entries())) {
            const elapsedMs = now - entry.startedAt;
            if (elapsedMs <= callTimeoutMs) continue;
            log.warn("bridge.call_orphaned", {
                id,
                method: entry.msg.method ?? null,
                elapsedMs,
            });
            failRequest(entry.msg, "no response", {
                toolText:
                    "❌ Walrus Memory did not answer this call. The connection to " +
                    "the relayer dropped before the result came back. Please retry.",
                errorMessage:
                    "Walrus Memory call was orphaned by a reconnect and never " +
                    "received a response. Please retry.",
            });
        }
    }, sweepIntervalMs);
    // unref so the sweeper never holds the event loop open during shutdown.
    orphanSweeper.unref?.();

    // Kick off the relayer connect in the BACKGROUND — do NOT await it before
    // wiring stdin below. This is the whole fix: `initialize` / `tools/list` are
    // answered locally the moment they arrive, while the (possibly slow / cold)
    // relayer round-trip proceeds off the handshake's critical path.
    //
    // Retry with backoff so a cold-starting relayer eventually connects. We do
    // NOT fail buffered requests between attempts: a request that the next
    // attempt would serve must not get a spurious "unavailable" error (that
    // would also drop the auth-required hot-handoff request). Buffered tool
    // calls stay queued and are flushed on the first SUCCESS; if they never
    // connect, the client's own per-tool timeout fires (graceful) — and on
    // shutdown `failPendingForward` closes out anything still open. `initialize`
    // is answered locally, so it never blocks and is only forwarded, not failed.
    // First connect stays on `openSseStream` + `flushPendingForward` so a
    // flush-time 404 still goes through the existing reconnect/replay path.
    // It must NOT publish if login already owns `sse`, or if the handshake
    // finished after `credentialGeneration` moved — that was the double-flush.
    const connectInBackground = (async () => {
        let attempt = 0;
        while (!stdinClosed) {
            if (reconnectPromise) {
                await reconnectPromise;
                continue;
            }
            if (sse) {
                signalFirstConnect();
                const notifications = pendingForward.filter((m) => m.id == null);
                pendingForward.length = 0;
                pendingForward.push(...notifications);
                await flushPendingForward();
                return;
            }
            const openingGeneration = credentialGeneration;
            try {
                const candidate = await openSseStream(creds.relayerUrl, creds);
                if (stdinClosed) {
                    candidate.abort();
                    break;
                }
                if (openingGeneration !== credentialGeneration || sse) {
                    candidate.abort();
                    continue;
                }
                sessionEpoch += 1;
                sse = candidate;
                firstConnectDone = true;
                note(`Connected. Bridging stdio MCP ↔ ${creds.relayerUrl}`);
                log.info("bridge.connected", { relayer: creds.relayerUrl });
                signalFirstConnect();
                await flushPendingForward();
                return;
            } catch (err) {
                const reason = err instanceof Error ? err.message : String(err);
                attempt += 1;
                log.error("bridge.initial_connect_failed", { err: reason, attempt });
                if (stdinClosed) break;
                const backoff = Math.min(15_000, 500 * Math.pow(2, attempt - 1));
                await new Promise<void>((resolve) => {
                    const timer = setTimeout(() => {
                        unregister();
                        resolve();
                    }, backoff);
                    timer.unref?.();
                    const unregister = onStdinClose(() => {
                        clearTimeout(timer);
                        resolve();
                    });
                });
            }
        }
        signalFirstConnect();
        failPendingForward("connection not established before shutdown");
    })();

    // Replay anything the auth-required server handed off (the tool call that
    // triggered the hot-handoff, plus anything buffered behind it). These run
    // through handleClientLine, which buffers them into pendingForward until the
    // background connect lands — so the triggering request is served for real
    // instead of being dropped in the mode switch.
    if (pendingLines.length > 0) {
        log.info("bridge.replaying_handoff", { count: pendingLines.length });
        for (const line of pendingLines) handleClientLine(line);
    }

    const clientPump = readStdinLines(handleClientLine).then(() => {
        markStdinClosed();
        sse?.abort();
    });

    try {
        await Promise.race([serverPump, clientPump]);
    } finally {
        clearInterval(orphanSweeper);
    }
    markStdinClosed();
    const finalStream = sse as SseHandshakeResult | null;
    finalStream?.abort();
    await connectInBackground.catch(() => {});
    log.info("bridge.closed", {});
}
