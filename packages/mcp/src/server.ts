/**
 * Unified stdio MCP server.
 *
 * One process answers initialize / tools/list / tools/call locally.
 * `memwal_login` / `memwal_logout` stay on this machine. Memory tools call
 * the public SDK (`MemWal.create` → signed REST). There is no SSE session
 * and no occupancy slot.
 */
import { credsPath, loadCreds, type MemWalCredentials } from "./auth.js";
import { rememberInitializeClientInfo } from "./client-info.js";
import {
    LOGIN_INSTRUCTION,
    SIGNED_OUT_TEXT,
} from "./format.js";
import { AUTH_REQUIRED_INSTRUCTIONS, PROACTIVE_INSTRUCTIONS } from "./instructions.js";
import { log } from "./logger.js";
import { resolveLoginTimeoutMs, startOrReuseLoginFlow } from "./login.js";
import {
    loginFailureNotice,
    loginPrompt,
    loginSuccessNotice,
    loginSuccessNotification,
    type LoginSuccessInfo,
} from "./messages.js";
import { dropClient, getClient, logout as logoutSession } from "./session.js";
import {
    SIGNED_OUT_TOOL_DEFINITIONS,
    TOOL_DEFINITIONS,
    isMemoryTool,
    runMemoryTool,
} from "./tools.js";
import { MEMWAL_MCP_VERSION } from "./version.js";

interface RpcMessage {
    jsonrpc: "2.0";
    id?: number | string | null;
    method?: string;
    params?: unknown;
    result?: unknown;
    error?: unknown;
}

export interface ServerConfig {
    relayerUrl: string;
    webUrl: string;
    label: string;
    namespace?: string;
}

export interface ServerIo {
    stdin: NodeJS.ReadableStream;
    stdout: { write(chunk: string): unknown };
}

const SUPPORTED_PROTOCOL_VERSIONS = new Set(["2024-11-05", "2025-03-26", "2025-06-18"]);
const FALLBACK_PROTOCOL_VERSION = "2024-11-05";
const URL_READY_TIMEOUT_MS = 5_000;

let lastLoginFailure: string | null = null;
let pendingLoginSuccess: LoginSuccessInfo | null = null;
/** Set by `memwal_logout` so a later memory call names the sign-out rather
 * than the first-run "isn't signed in yet" instruction. Cleared on login. */
let signedOutLocally = false;

export function notePendingLoginSuccess(info: LoginSuccessInfo): void {
    pendingLoginSuccess = info;
}

/** Test seam: clear login/logout module state between cases. */
export function resetServerState(): void {
    lastLoginFailure = null;
    pendingLoginSuccess = null;
    signedOutLocally = false;
}

function takePendingLoginSuccess(): LoginSuccessInfo | null {
    const pending = pendingLoginSuccess;
    pendingLoginSuccess = null;
    return pending;
}

function applyPendingLoginSuccess(text: string): string {
    const pending = takePendingLoginSuccess();
    if (!pending) return text;
    log.info("server.login_success_notice_attached", { accountId: pending.accountId });
    return `${loginSuccessNotice(pending)}${text}`;
}

function buildInitializeResult(params: unknown, signedIn: boolean) {
    const requested = (params as { protocolVersion?: unknown } | undefined)?.protocolVersion;
    const protocolVersion =
        typeof requested === "string" && SUPPORTED_PROTOCOL_VERSIONS.has(requested)
            ? requested
            : FALLBACK_PROTOCOL_VERSION;
    return {
        protocolVersion,
        capabilities: { tools: { listChanged: true } },
        serverInfo: { name: "memwal", version: MEMWAL_MCP_VERSION },
        instructions: signedIn ? PROACTIVE_INSTRUCTIONS : AUTH_REQUIRED_INSTRUCTIONS,
    };
}

function writeStdout(stdout: ServerIo["stdout"], msg: RpcMessage): void {
    stdout.write(JSON.stringify(msg) + "\n");
}

function sendLogMessage(
    stdout: ServerIo["stdout"],
    level: "info" | "warning" | "error",
    text: string,
): void {
    writeStdout(stdout, {
        jsonrpc: "2.0",
        method: "notifications/message",
        params: { level, logger: "memwal-mcp", data: text },
    });
}

function toolResult(
    stdout: ServerIo["stdout"],
    id: RpcMessage["id"],
    text: string,
    isError: boolean,
): void {
    writeStdout(stdout, {
        jsonrpc: "2.0",
        id,
        result: {
            content: [{ type: "text", text }],
            isError,
        },
    });
}

function notifyToolsChanged(stdout: ServerIo["stdout"]): void {
    writeStdout(stdout, {
        jsonrpc: "2.0",
        method: "notifications/tools/list_changed",
    });
}

async function handleLoginToolCall(
    config: ServerConfig,
    stdout: ServerIo["stdout"],
): Promise<{ text: string; isError: boolean }> {
    lastLoginFailure = null;
    const session = startOrReuseLoginFlow(
        {
            relayerUrl: config.relayerUrl,
            webUrl: config.webUrl,
            label: config.label,
            timeoutMs: resolveLoginTimeoutMs(),
            openBrowser: false,
        },
        (creds: MemWalCredentials) => {
            lastLoginFailure = null;
            signedOutLocally = false;
            // Drop any previous SDK client so the next memory call rebuilds
            // from the file this callback just wrote.
            dropClient();
            log.info("memwal_login.success", {
                accountId: creds.accountId,
                delegateAddress: creds.delegateAddress,
            });
            notePendingLoginSuccess({
                accountId: creds.accountId,
                delegateAddress: creds.delegateAddress,
                credentialsPath: credsPath(),
            });
            sendLogMessage(
                stdout,
                "info",
                loginSuccessNotification({
                    accountId: creds.accountId,
                    delegateAddress: creds.delegateAddress,
                    credentialsPath: credsPath(),
                }),
            );
            notifyToolsChanged(stdout);
        },
        (err) => {
            const msg = err instanceof Error ? err.message : String(err);
            lastLoginFailure = msg;
            log.warn("memwal_login.failed", { msg });
            sendLogMessage(
                stdout,
                "warning",
                `Walrus Memory sign-in did not complete: ${msg}. Existing credentials are unchanged; call memwal_login again to retry.`,
            );
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
        text: loginPrompt({
            url,
            credentialsPath: credsPath(),
            signedIn: loadCreds() !== null,
        }),
    };
}

function handleLogoutToolCall(): { text: string; isError: boolean } {
    try {
        signedOutLocally = true;
        const cleared = logoutSession();
        log.info("memwal_logout.success", {
            removedPath: cleared.removedPath ?? null,
            fallbackPath: cleared.fallbackPath ?? null,
        });
        if (!cleared.removedPath) {
            return {
                isError: false,
                text:
                    `✅ Already signed out. No credentials at \`${credsPath()}\`, and this ` +
                    `connection's in-process client has been dropped — memory tools will refuse ` +
                    `to run until you sign in again.`,
            };
        }
        return {
            isError: false,
            text: [
                `✅ Signed out. Credentials removed from \`${cleared.removedPath}\`, and this connection's in-process client has been dropped — memory tools will refuse to run until you sign in again.`,
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

function handleLine(
    line: string,
    config: ServerConfig,
    stdout: ServerIo["stdout"],
): void {
    let req: RpcMessage;
    try {
        req = JSON.parse(line) as RpcMessage;
    } catch {
        log.warn("server.stdin_parse_failed", { line: line.slice(0, 120) });
        return;
    }

    if (req.id == null && typeof req.method === "string") {
        return;
    }

    const id = req.id ?? null;
    const method = req.method;

    if (method === "initialize") {
        const clientInfo = rememberInitializeClientInfo(req.params);
        if (clientInfo) {
            log.info("server.agent_client", {
                clientName: clientInfo.name,
                clientVersion: clientInfo.version,
            });
        }
        writeStdout(stdout, {
            jsonrpc: "2.0",
            id,
            result: buildInitializeResult(req.params, loadCreds() !== null),
        });
        return;
    }

    if (method === "ping") {
        writeStdout(stdout, { jsonrpc: "2.0", id, result: {} });
        return;
    }

    if (method === "tools/list") {
        const signedIn = loadCreds() !== null;
        writeStdout(stdout, {
            jsonrpc: "2.0",
            id,
            result: { tools: signedIn ? TOOL_DEFINITIONS : SIGNED_OUT_TOOL_DEFINITIONS },
        });
        return;
    }

    if (method === "tools/call") {
        const params = (req.params ?? {}) as {
            name?: string;
            arguments?: Record<string, unknown>;
        };
        const toolName = params.name ?? "";
        const args = params.arguments ?? {};

        if (toolName === "memwal_login") {
            void handleLoginToolCall(config, stdout).then((result) => {
                toolResult(stdout, id, result.text, result.isError);
            });
            return;
        }

        if (toolName === "memwal_logout") {
            const result = handleLogoutToolCall();
            toolResult(stdout, id, result.text, result.isError);
            notifyToolsChanged(stdout);
            return;
        }

        if (!isMemoryTool(toolName)) {
            writeStdout(stdout, {
                jsonrpc: "2.0",
                id,
                error: { code: -32601, message: `Unknown tool: ${toolName}` },
            });
            return;
        }

        const client = getClient();
        if (!client) {
            const body = signedOutLocally
                ? SIGNED_OUT_TEXT
                : `${loginFailureNotice(lastLoginFailure)}${LOGIN_INSTRUCTION}`;
            toolResult(stdout, id, applyPendingLoginSuccess(body), true);
            return;
        }

        const relayerUrl = loadCreds()?.relayerUrl ?? config.relayerUrl;
        void runMemoryTool(toolName, args, config.namespace, client, relayerUrl).then((result) => {
            toolResult(stdout, id, applyPendingLoginSuccess(result.text), result.isError);
        });
        return;
    }

    writeStdout(stdout, {
        jsonrpc: "2.0",
        id,
        error: { code: -32601, message: `Method not found: ${method ?? "(missing)"}` },
    });
}

function readStdinLines(
    stdin: NodeJS.ReadableStream,
    onLine: (line: string) => void,
): Promise<void> {
    return new Promise((resolve) => {
        let buf = "";
        const readable = stdin as NodeJS.ReadStream;
        if (typeof readable.setEncoding === "function") readable.setEncoding("utf8");
        stdin.on("data", (chunk: string | Buffer) => {
            buf += String(chunk);
            let nl: number;
            while ((nl = buf.indexOf("\n")) >= 0) {
                const line = buf.slice(0, nl).replace(/\r$/, "");
                buf = buf.slice(nl + 1);
                if (line.length > 0) onLine(line);
            }
        });
        stdin.on("end", () => resolve());
        stdin.on("close", () => resolve());
        readable.resume?.();
    });
}

/**
 * Run the stdio MCP server until stdin closes.
 *
 * `io` is a test seam (PassThrough streams). Production uses process stdio.
 */
export async function runStdioServer(
    config: ServerConfig,
    io: ServerIo = { stdin: process.stdin, stdout: process.stdout },
): Promise<void> {
    log.info("server.started", {
        webUrl: config.webUrl,
        relayerUrl: config.relayerUrl,
        signedIn: loadCreds() !== null,
    });
    await readStdinLines(io.stdin, (line) => handleLine(line, config, io.stdout));
    dropClient();
    log.info("server.closed", {});
}
