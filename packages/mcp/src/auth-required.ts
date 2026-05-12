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
 *   - Advertises the 4 real MemWal tools in `tools/list` so the agent
 *     knows what's available.
 *   - Returns an `isError: true` envelope on any `tools/call` with a
 *     friendly login instruction inline in the chat.
 *
 * This is a Phase B (current) compromise — Phase B.5 will replace it with
 * the MCP OAuth flow so the client's host drives the browser dance and
 * retries the tool call automatically (no client restart needed).
 */
import { log } from "./logger.js";

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
            "Save a fact to the user's MemWal personal memory. Call ONLY when the user explicitly asks to remember/save something. Pass the full, detailed text — never summarize.",
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
            "Search the user's MemWal memory for facts relevant to a query. Returns matching memories ranked by relevance.",
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
            "Extract memorable facts from a passage of text (preferences, habits, biographical info, constraints) and save each as a separate MemWal memory.",
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
            "Re-index a namespace from Walrus blobs back into the relayer's search index. Returns counts only.",
        inputSchema: {
            type: "object",
            properties: {
                namespace: { type: "string", minLength: 1 },
                limit: { type: "integer", minimum: 1, maximum: 500, default: 50 },
            },
            required: ["namespace"],
            additionalProperties: false,
        },
    },
];

const LOGIN_INSTRUCTION = [
    "❌ MemWal isn't signed in yet.",
    "",
    "To connect this MCP client to your MemWal memory, run **once** in a terminal:",
    "",
    "    npx -y @mysten-incubation/memwal-mcp login",
    "",
    "(or `npx -y @mysten-incubation/memwal-mcp login --local` / `--dev` to point at a non-prod env)",
    "",
    "A browser tab will open — click **Connect Sui Wallet** and approve the on-chain ",
    "`add_delegate_key` transaction. The flow takes about 30 seconds.",
    "",
    "After login completes, restart this MCP client so it picks up the new credentials ",
    "at `~/.memwal/credentials.json`. You won't need to do this again unless you revoke ",
    "the delegate key from the dashboard.",
].join("\n");

function writeStdoutMessage(msg: RpcMessage): void {
    process.stdout.write(JSON.stringify(msg) + "\n");
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

/**
 * Run the auth-required stdio MCP server. Returns when stdin closes.
 */
export async function runAuthRequiredServer(): Promise<void> {
    log.info("auth_required_server.started", {});

    await readStdinLines((line) => {
        let req: RpcMessage;
        try {
            req = JSON.parse(line) as RpcMessage;
        } catch {
            return;
        }

        // Notifications don't need a response.
        if (req.id == null && typeof req.method === "string") {
            return;
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
            return;
        }

        if (method === "tools/list") {
            writeStdoutMessage({
                jsonrpc: "2.0",
                id,
                result: { tools: TOOL_DEFINITIONS },
            });
            return;
        }

        if (method === "tools/call") {
            writeStdoutMessage({
                jsonrpc: "2.0",
                id,
                result: {
                    content: [{ type: "text", text: LOGIN_INSTRUCTION }],
                    isError: true,
                },
            });
            return;
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
    });

    log.info("auth_required_server.closed", {});
}
