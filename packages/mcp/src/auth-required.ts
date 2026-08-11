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
import { log } from "./logger.js";
import { loginFlow } from "./login.js";

interface RpcMessage {
    jsonrpc: "2.0";
    id?: number | string | null;
    method?: string;
    params?: unknown;
    result?: unknown;
    error?: unknown;
}

const TOOL_DEFINITIONS = [
    {
        name: "memwal_remember",
        description:
            "Save a fact to the user's Walrus Memory personal memory. Call ONLY when the user explicitly asks to remember/save something. Pass the full, detailed text — never summarize.",
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
        name: "memwal_recall",
        description:
            "Search the user's Walrus Memory for facts relevant to a query. Returns matching memories ranked by relevance.",
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
        description:
            "Extract memorable facts from a passage of text (preferences, habits, biographical info, constraints) and save each as a separate Walrus Memory memory.",
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
        description:
            "Re-index a namespace from Walrus blobs back into the relayer's search index. Returns counts and truncated status; call again with a higher limit when truncated=true.",
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
        name: "memwal_login",
        description:
            "Sign this MCP client into your Walrus Memory account by opening a browser. Run once when the agent reports Walrus Memory is not signed in. Opens the dashboard in the default browser, waits for wallet approval, then writes credentials to ~/.memwal/credentials.json. Other memwal_* tools become usable on the next call after a successful login.",
        inputSchema: {
            type: "object",
            properties: {},
            additionalProperties: false,
        },
    },
];

/** Maximum time we'll keep the login HTTP listener bound after the user
 * clicks `memwal_login`. The user paces themselves — wallet popups, ledger
 * sign, MetaMask review — so we give 5 min before the port closes. */
const LOGIN_BG_TIMEOUT_MS = 5 * 60_000;

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
 * The login HTTP listener stays alive for LOGIN_BG_TIMEOUT_MS in the
 * background. Once the user clicks the link and approves the wallet, the
 * callback writes credentials to ~/.memwal/credentials.json. The user then
 * issues any other memwal_* tool to verify — which now succeeds because
 * the bridge picks up the saved creds on its next call.
 */
async function handleLoginToolCall(
    config: AuthRequiredConfig,
    _progressToken: unknown,
): Promise<{ text: string; isError: boolean }> {
    let connectUrl: string | null = null;

    // Promise that resolves with the URL as soon as the listener is bound.
    const urlReady = new Promise<string>((resolve) => {
        // Fire loginFlow but DO NOT await — it runs in the background.
        // openBrowser: false because (a) child-process spawning a browser is
        // unreliable across MCP clients, and (b) macOS `open <url>` often
        // foregrounds an existing memory.walrus.xyz tab instead of navigating to
        // the full /connect/mcp?... URL — so user lands on the homepage,
        // not the consent screen. The agent surfaces the clickable URL
        // from the tool result instead.
        loginFlow({
            relayerUrl: config.relayerUrl,
            webUrl: config.webUrl,
            label: config.label,
            timeoutMs: LOGIN_BG_TIMEOUT_MS,
            openBrowser: false,
            onUrl: (url) => {
                connectUrl = url;
                resolve(url);
                // Also push to log notification — clients that surface these
                // (Cursor) get a second visible copy of the URL.
                sendLogMessage("info", `Walrus Memory MCP login URL: ${url}`);
            },
        })
            .then((creds) => {
                log.info("memwal_login.bg.success", {
                    accountId: creds.accountId,
                    delegateAddress: creds.delegateAddress,
                });
            })
            .catch((err) => {
                const msg = err instanceof Error ? err.message : String(err);
                log.warn("memwal_login.bg.failed", { msg });
            });
    });

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
        url = await Promise.race([urlReady, timeoutPromise]);
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
        writeStdoutMessage({
            jsonrpc: "2.0",
            id,
            result: {
                protocolVersion: "2024-11-05",
                capabilities: { tools: { listChanged: false } },
                serverInfo: { name: "memwal", version: "0.0.1" },
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
            result: { tools: TOOL_DEFINITIONS },
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
        if (creds) return { creds };

        writeStdoutMessage({
            jsonrpc: "2.0",
            id,
            result: {
                content: [{ type: "text", text: LOGIN_INSTRUCTION }],
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
