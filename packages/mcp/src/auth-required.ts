/**
 * "Auth-required" stdio MCP server — run when ~/.memwal/credentials.json is
 * missing but the package was spawned by an MCP client (Cursor / Claude
 * Desktop / etc.).
 *
 * Instead of exiting (which makes the MCP client show a cryptic
 * "Failed to start server" error that the user can't act on), we boot a
 * minimal MCP server that:
 *
 *   - Responds to `initialize` so the client sees a healthy server.
 *   - Advertises the 4 real Walrus Memory tools + a 5th `memwal_login` tool in
 *     `tools/list` so the agent knows what's available.
 *   - On `tools/call memwal_login`: invokes the browser-based wallet login
 *     flow inline so the user never has to leave their MCP client. Eliminates
 *     the previous "run a separate `npx ... login` command then restart" UX.
 *   - On any other `tools/call`: returns `isError: true` with a friendly
 *     instruction telling the agent to call `memwal_login` first (or run
 *     the CLI command as a fallback).
 *
 * Note: HTTP transport (`/api/mcp`) gets a separate native OAuth flow per
 * MCP spec 2025-06 — see ENG-1750. The two paths cover different surfaces
 * and coexist.
 */
import { loadCreds, type MemWalCredentials } from "./auth.js";
import { rememberInitializeClientInfo } from "./client-info.js";
import { log } from "./logger.js";
import { startOrReuseLoginFlow, resolveLoginTimeoutMs } from "./login.js";
import { AUTH_REQUIRED_INSTRUCTIONS } from "./instructions.js";
import { MEMWAL_MCP_VERSION } from "./version.js";

interface RpcMessage {
    jsonrpc: "2.0";
    id?: number | string | null;
    method?: string;
    params?: unknown;
    result?: unknown;
    error?: unknown;
}

const SIGNED_OUT_REMEMBER =
    "Save a fact to the user's Walrus Memory personal memory. Call ONLY when the user explicitly asks to remember/save something. Pass the full, detailed text — never summarize.";
const SIGNED_IN_REMEMBER =
    "Save a durable fact about the user or project to their Walrus Memory. Call this PROACTIVELY whenever the user states a preference, decision, constraint, correction, identity detail, or recurring workflow — even if they did not say 'remember this'. Skip one-off tasks, the current file or bug, and small talk. Pass the full statement; do not summarize. To save several facts at once, use memwal_remember_bulk instead.";
const SIGNED_OUT_RECALL =
    "Search the user's Walrus Memory for facts relevant to a query. Returns matching memories ranked by relevance.";
const SIGNED_IN_RECALL =
    "Search the user's Walrus Memory for relevant facts before responding. Call this PROACTIVELY at the start of a task, or whenever the user references past work, prior decisions, their preferences, or anything you may have stored earlier — don't wait to be asked. A single focused query is usually enough — recall is a real retrieval over encrypted storage, so do NOT fire multiple redundant searches for the same question. Returns matching memories ranked by relevance.";

/** Build the static memory-tool list. `proactive` is true for the signed-in
 * cold-start path (bridge: credentials exist, relayer not yet up) and false
 * for auth-required (no credentials). Same tool names/order as the sidecar. */
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
            "Recovery tool. Re-index a namespace from Walrus blobs back into the relayer's search index \u2014 use when memwal_recall unexpectedly returns nothing even though facts were saved before (e.g. on a new machine, a fresh relayer, or after switching servers). Returns counts plus truncated status \u2014 does not return memory texts. If truncated=true, increase limit and call again. Call memwal_recall afterwards to query the rebuilt index.",
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
    {
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
    },
    ];
}

/** Signed-in cold-start list (bridge). Credentials exist; the relayer session
 * is not up yet. Proactive wording so clients that keep the first tools/list
 * still save/recall without being asked. */
export const TOOL_DEFINITIONS = buildToolDefinitions(true);

/** Signed-out list (auth-required). No credentials, so every memory call
 * fails: keep conservative wording or the model will spam remember and get
 * a stream of auth errors. */
export const SIGNED_OUT_TOOL_DEFINITIONS = buildToolDefinitions(false);

/** How long to wait for the local listener to bind + emit its URL before we
 * give up and return an error. Should be near-instant; 5s is paranoia. */
const URL_READY_TIMEOUT_MS = 5_000;

const LOGIN_INSTRUCTION = [
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

/** Set when a background `memwal_login` ends without credentials. The tool call
 * already returned the URL by then, so this is the only place left to say so. */
let lastLoginFailure: string | null = null;

/** Prefix explaining that a sign-in was attempted and did not complete. */
function loginFailureNotice(): string {
    if (!lastLoginFailure) return "";
    return [
        "⚠️ A sign-in was started but never completed, so there are still no credentials.",
        "",
        `Reason: ${lastLoginFailure}`,
        "",
        "The unused key from this attempt may already be registered on your account. Remove it",
        "from the dashboard if you are not using it. Sign in again and open the new link",
        "straight away. A retry only helps once the MCP client is left running through the",
        "wallet prompt.",
        "",
        "---",
        "",
    ].join("\n");
}

function writeStdoutMessage(msg: RpcMessage): void {
    process.stdout.write(JSON.stringify(msg) + "\n");
}

/** Config passed in by the entry point (`index.ts`) so the login flow uses
 * the same web/relayer URLs as the rest of the CLI (e.g. `--dev` →
 * dashboard at `https://dev.memwal.ai`, not the prod default at
 * `https://memory.walrus.xyz`). */
export interface AuthRequiredConfig {
    relayerUrl: string;
    webUrl: string;
    label: string;
    /** Default memory namespace resolved at boot. Accepted here so the entry
     * point can pass one config shape to both server modes — but auth-required
     * mode never forwards a memory tool call (every non-login tool returns the
     * login instruction), so there is nothing to namespace yet. It takes
     * effect once credentials exist and the bridge runs. */
    namespace?: string;
}

/** Send a `notifications/message` (MCP logging notification). Some clients
 * surface these inline (Cursor); others swallow them (Claude Code as of
 * 2026-05). We rely primarily on the tool result for the URL — this is a
 * secondary surface for clients that show it. */
function sendLogMessage(level: "info" | "warning" | "error", text: string): void {
    writeStdoutMessage({
        jsonrpc: "2.0",
        method: "notifications/message",
        params: {
            level,
            logger: "memwal-mcp",
            data: text,
        },
    });
}

/**
 * Start the browser-based login flow and return the click-able URL
 * IMMEDIATELY in the tool result (do NOT block waiting for the user to
 * approve). Reasons:
 *
 *   - MCP clients enforce a tool-call timeout (~60s in Claude Code/Codex).
 *     The user's wallet flow can easily exceed it (hardware wallet review,
 *     Enoki sponsor lag, browser tab not focused).
 *   - The agent paraphrases timeout errors and may strip the URL when
 *     reporting to the user, leaving them stuck.
 *   - `notifications/message` is filtered out by some clients.
 *
 * The login HTTP listener stays alive for resolveLoginTimeoutMs() in the
 * background. Once the user clicks the link and approves the wallet, the
 * callback writes credentials to ~/.memwal/credentials.json. The user then
 * issues any other memwal_* tool to verify — which now succeeds because
 * the bridge picks up the saved creds on its next call.
 */
async function handleLoginToolCall(
    config: AuthRequiredConfig,
    _progressToken: unknown,
): Promise<{ text: string; isError: boolean }> {
    // Fire login but DO NOT await the wallet callback — it runs in the
    // background. openBrowser: false because (a) child-process spawning a
    // browser is unreliable across MCP clients, and (b) macOS `open <url>`
    // often foregrounds an existing memory.walrus.xyz tab instead of
    // navigating to the full /connect/mcp?... URL. The agent surfaces the
    // clickable URL from the tool result instead.
    //
    // Concurrent memwal_login calls join this in-flight flow instead of
    // opening a second listener (that race hung later recall/remember).
    lastLoginFailure = null;
    const session = startOrReuseLoginFlow(
        {
            relayerUrl: config.relayerUrl,
            webUrl: config.webUrl,
            label: config.label,
            timeoutMs: resolveLoginTimeoutMs(),
            openBrowser: false,
            onUrl: (url) => {
                sendLogMessage("info", `Walrus Memory MCP login URL: ${url}`);
            },
        },
        (creds) => {
            lastLoginFailure = null;
            log.info("memwal_login.bg.success", {
                accountId: creds.accountId,
                delegateAddress: creds.delegateAddress,
            });
        },
        (err) => {
            const msg = err instanceof Error ? err.message : String(err);
            lastLoginFailure = msg;
            log.warn("memwal_login.bg.failed", { msg });
            sendLogMessage("warning", `Walrus Memory sign-in did not complete: ${msg}`);
        },
    );

    // Race the URL-ready against a short timeout. The listener bind is
    // synchronous-ish (single port allocation); 5s is a hard cap for a
    // pathologically slow machine or unrelated bug.
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
        const msg = err instanceof Error ? err.message : String(err);
        log.error("memwal_login.tool.url_not_ready", { msg });
        return {
            isError: true,
            text: [
                `❌ Failed to start Walrus Memory login: ${msg}`,
                "",
                "Try the CLI fallback:",
                "",
                "    npx -y @mysten-incubation/memwal-mcp login",
            ].join("\n"),
        };
    }

    log.info("memwal_login.tool.url_ready", { url });
    // The URL is included MULTIPLE times in different formats so agents
    // that try to summarize the result can't strip all of them. Some MCP
    // clients (Claude Code) paraphrase tool output aggressively — by
    // repeating the URL in plain, code-block, and markdown-link form, at
    // least one survives the agent's response template.
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
            `The user CANNOT proceed without seeing the exact URL. Surface it verbatim`,
            `in your reply, then explain the steps:`,
            ``,
            `1. Open the URL in any browser (it may have already opened automatically)`,
            `2. Click **Connect Sui Wallet** and approve the on-chain \`add_delegate_key\` transaction`,
            `3. Once "Connected" appears in the browser, the assistant should retry the original request — the other memwal_* tools will then have credentials at \`~/.memwal/credentials.json\``,
            ``,
            `_The login link stays valid for 5 minutes. If it expires, call \`memwal_login\` again to get a fresh URL._`,
        ].join("\n"),
    };
}

/** Returned by {@link runAuthRequiredServer} when the user signs in mid-session
 * (via `memwal_login`) and the request should now be served by the real bridge
 * instead — WITHOUT a client restart. */
export interface AuthHandoff {
    creds: MemWalCredentials;
    /** Lines the auth-required reader already pulled off stdin that the bridge
     * must process first: the tool call that triggered the handoff, plus
     * anything buffered behind it. */
    pendingLines: string[];
}

/**
 * Dispatch one JSON-RPC line in auth-required mode.
 *
 * Returns the freshly-loaded credentials when `memwal_login` has written them
 * since spawn and the request should be handed to the bridge for real
 * servicing. Returns null when the line was fully handled locally (initialize,
 * stub tools/list, login tool call, or the not-signed-in nudge).
 */
function handleAuthLine(
    line: string,
    config: AuthRequiredConfig,
): { creds: MemWalCredentials } | null {
    let req: RpcMessage;
    try {
        req = JSON.parse(line) as RpcMessage;
    } catch {
        return null;
    }

    // Notifications don't need a response.
    if (req.id == null && typeof req.method === "string") {
        return null;
    }

    const id = req.id ?? null;
    const method = req.method;

    if (method === "initialize") {
        const clientInfo = rememberInitializeClientInfo(req.params);
        if (clientInfo) {
            log.info("bridge.agent_client", {
                clientName: clientInfo.name,
                clientVersion: clientInfo.version,
                mode: "auth-required",
            });
        }
        writeStdoutMessage({
            jsonrpc: "2.0",
            id,
            result: {
                protocolVersion: "2024-11-05",
                // listChanged:true because the tool set DOES change after a
                // mid-session login: the hot-handoff to the bridge emits
                // `notifications/tools/list_changed`, and a client told
                // `false` here would be entitled to ignore it and never pick up
                // the real upstream tools (or `memwal_logout`). Advertise the
                // capability the handoff depends on.
                capabilities: { tools: { listChanged: true } },
                serverInfo: { name: "memwal", version: MEMWAL_MCP_VERSION },
                instructions: AUTH_REQUIRED_INSTRUCTIONS,
            },
        });
        return null;
    }

    if (method === "tools/list") {
        // Signed in since spawn? Hand off so the client gets the real upstream
        // tool list (with memwal_login/memwal_logout spliced in) from the bridge.
        const creds = loadCreds();
        if (creds) return { creds };
        writeStdoutMessage({
            jsonrpc: "2.0",
            id,
            result: { tools: SIGNED_OUT_TOOL_DEFINITIONS },
        });
        return null;
    }

    if (method === "tools/call") {
        const params = (req.params ?? {}) as {
            name?: string;
            arguments?: unknown;
            _meta?: { progressToken?: unknown };
        };
        const toolName = params.name;
        const progressToken = params._meta?.progressToken;

        if (toolName === "memwal_login") {
            // Returns near-instantly with the click-able URL. The listener
            // stays alive in the background — see handleLoginToolCall for the
            // rationale on not blocking.
            void handleLoginToolCall(config, progressToken).then((result) => {
                writeStdoutMessage({
                    jsonrpc: "2.0",
                    id,
                    result: {
                        content: [{ type: "text", text: result.text }],
                        isError: result.isError,
                    },
                });
            });
            return null;
        }

        // Any other memory tool. If `memwal_login` has since written
        // credentials, hand off to the bridge so THIS call is served for real —
        // no client restart (the historical "second reboot"). Otherwise nudge
        // the agent to sign in first.
        const creds = loadCreds();
        if (creds) {
            lastLoginFailure = null;
            return { creds };
        }

        writeStdoutMessage({
            jsonrpc: "2.0",
            id,
            result: {
                content: [
                    { type: "text", text: `${loginFailureNotice()}${LOGIN_INSTRUCTION}` },
                ],
                isError: true,
            },
        });
        return null;
    }

    // Anything else — return Method not found per JSON-RPC.
    writeStdoutMessage({
        jsonrpc: "2.0",
        id,
        error: {
            code: -32601,
            message: `Method not found: ${method ?? "(missing)"}`,
        },
    });
    return null;
}

/**
 * Run the auth-required stdio MCP server.
 *
 * Resolves with an {@link AuthHandoff} the moment `memwal_login` completes and
 * the next memory tool call (or tools/list) arrives — so the caller can pick up
 * the real bridge IN THE SAME PROCESS, eliminating the second client restart.
 * Resolves with `undefined` if stdin closes before any sign-in.
 *
 * We manage the stdin listeners directly (rather than via the shared
 * `readStdinLines`) so we can DETACH cleanly at handoff: the bridge attaches its
 * own reader next, and two concurrent `data` listeners would double-process
 * every line. `pause()` keeps any bytes that arrive during the switch buffered
 * until the bridge's reader resumes the stream.
 *
 * The `config` parameter carries the same `relayerUrl` / `webUrl` / `label`
 * that the rest of the CLI resolved (e.g. `--dev` → dev URLs). Without it,
 * `memwal_login` would fall back to prod defaults and open the wrong dashboard.
 */
export async function runAuthRequiredServer(
    config: AuthRequiredConfig,
): Promise<AuthHandoff | void> {
    log.info("auth_required_server.started", {
        webUrl: config.webUrl,
        relayerUrl: config.relayerUrl,
    });

    return await new Promise<AuthHandoff | void>((resolve) => {
        let buf = "";
        let settled = false;

        const detach = (): void => {
            process.stdin.removeListener("data", onData);
            process.stdin.removeListener("end", onEnd);
            process.stdin.removeListener("close", onEnd);
        };

        const onData = (chunk: string): void => {
            buf += chunk;
            let nl: number;
            while ((nl = buf.indexOf("\n")) >= 0) {
                const rawLine = buf.slice(0, nl).replace(/\r$/, "");
                buf = buf.slice(nl + 1);
                if (rawLine.length === 0) continue;

                const handoff = handleAuthLine(rawLine, config);
                if (!handoff) continue;

                // Fresh credentials detected mid-session. Stop consuming stdin
                // and hand the bridge everything we've read but not forwarded:
                // the triggering line first, then anything buffered behind it.
                settled = true;
                detach();
                process.stdin.pause();

                const pendingLines: string[] = [rawLine];
                let n2: number;
                while ((n2 = buf.indexOf("\n")) >= 0) {
                    const l = buf.slice(0, n2).replace(/\r$/, "");
                    buf = buf.slice(n2 + 1);
                    if (l.length > 0) pendingLines.push(l);
                }

                log.info("auth_required_server.handoff_to_bridge", {
                    accountId: handoff.creds.accountId,
                    pendingLines: pendingLines.length,
                });
                resolve({ creds: handoff.creds, pendingLines });
                return;
            }
        };

        const onEnd = (): void => {
            if (settled) return;
            settled = true;
            detach();
            log.info("auth_required_server.closed", {});
            resolve(undefined);
        };

        process.stdin.setEncoding("utf8");
        process.stdin.on("data", onData);
        process.stdin.on("end", onEnd);
        process.stdin.on("close", onEnd);
    });
}
