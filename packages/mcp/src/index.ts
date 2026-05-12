/**
 * MemWal MCP — orchestrator.
 *
 * Boot sequence:
 *   1. If `--logout` flag → wipe credentials.json and exit.
 *   2. Load credentials from `~/.memwal/credentials.json`.
 *   3. If missing → run `loginFlow()` (browser-based wallet sign-in).
 *   4. Bridge stdio MCP ↔ remote SSE relayer using the loaded credentials.
 *   5. On 401 (revoked key), the bridge wipes credentials before throwing
 *      — the next process spawn will re-trigger login.
 */
import { clearCreds, credsPath, loadCreds } from "./auth.js";
import { runAuthRequiredServer } from "./auth-required.js";
import { runBridge } from "./bridge.js";
import { loginFlow } from "./login.js";
import { log, note } from "./logger.js";

/**
 * Parsed CLI flags. All optional — env vars cover the same surface.
 * CLI takes precedence over env so per-config overrides work even when the
 * user shares the same shell across MCP clients.
 */
interface ParsedArgs {
    help: boolean;
    logout: boolean;
    forceLogin: boolean;
    relayerUrl?: string;
    webUrl?: string;
    label?: string;
}

/** Per-environment URL shortcuts. `--dev`/`--staging`/`--local` set both
 *  relayer + web in one flag. Explicit `--relayer` / `--web-url` override. */
const ENV_PRESETS: Record<string, { relayer: string; web: string }> = {
    prod: { relayer: "https://relayer.memwal.ai", web: "https://memwal.ai" },
    dev: { relayer: "https://relayer.dev.memwal.ai", web: "https://dev.memwal.ai" },
    staging: { relayer: "https://relayer.staging.memwal.ai", web: "https://staging.memwal.ai" },
    local: { relayer: "http://127.0.0.1:8000", web: "http://localhost:5173" },
};

function parseArgs(argv: string[]): ParsedArgs {
    const out: ParsedArgs = { help: false, logout: false, forceLogin: false };
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        const next = () => argv[++i];
        switch (a) {
            case "--help":
            case "-h":
                out.help = true;
                break;
            case "--logout":
                out.logout = true;
                break;
            case "--login":
            case "login":
                out.forceLogin = true;
                break;
            case "--prod":
            case "--dev":
            case "--staging":
            case "--local": {
                const preset = ENV_PRESETS[a.slice(2)];
                if (preset) {
                    out.relayerUrl ??= preset.relayer;
                    out.webUrl ??= preset.web;
                }
                break;
            }
            case "--relayer":
            case "--relayer-url":
                out.relayerUrl = next();
                break;
            case "--web-url":
            case "--web":
                out.webUrl = next();
                break;
            case "--label":
                out.label = next();
                break;
            default:
                // Allow `--relayer=URL` and `--web-url=URL` forms too.
                if (a?.startsWith("--relayer=")) out.relayerUrl = a.split("=", 2)[1];
                else if (a?.startsWith("--web-url=")) out.webUrl = a.split("=", 2)[1];
                else if (a?.startsWith("--label=")) out.label = a.split("=", 2)[1];
                // Unknown flag: ignore silently.
                break;
        }
    }
    return out;
}

export async function main(argv: string[] = process.argv.slice(2)): Promise<void> {
    const args = parseArgs(argv);

    if (args.help) {
        printHelp();
        return;
    }
    if (args.logout) {
        clearCreds();
        note(`Credentials removed (${credsPath()}).`);
        return;
    }
    if (args.forceLogin) {
        clearCreds();
    }

    // Resolve URLs: CLI > env > default.
    const relayerUrl =
        args.relayerUrl ?? process.env.MEMWAL_SERVER_URL ?? "https://relayer.memwal.ai";
    const webUrl =
        args.webUrl ?? process.env.MEMWAL_WEB_URL ?? "https://memwal.ai";
    // Label is the on-chain delegate-key name shown in the dashboard. We
    // default to a generic value at registration time — the bridge updates
    // it to the actual client's `clientInfo.name` ("Cursor", "Claude",
    // "Antigravity", ...) after the first MCP `initialize` request. User
    // can rename anytime from the dashboard.
    const label = args.label ?? process.env.MEMWAL_CLIENT_LABEL ?? "MCP Client";

    let creds = loadCreds();
    if (creds && args.relayerUrl && creds.relayerUrl !== args.relayerUrl) {
        // Caller wants a different relayer than what's saved. NEVER silently
        // mutate the saved relayerUrl — a malicious config snippet (e.g.
        // copy-pasted from a forum) carrying `--relayer https://attacker`
        // would otherwise rewrite the saved creds so even subsequent runs
        // without the flag ship the seed to the attacker (audit H4).
        //
        // In-memory override is fine for THIS process — the saved file is
        // left untouched, so the next spawn falls back to the saved URL.
        log.warn("creds.relayer_override.transient_only", {
            saved: creds.relayerUrl,
            override: args.relayerUrl,
        });
        note(
            `--relayer flag (${args.relayerUrl}) overrides saved relayer ` +
                `(${creds.relayerUrl}) for THIS process only. The saved file ` +
                `is not modified. To rotate the saved relayer, run ` +
                `\`memwal-mcp login --logout\` then a fresh login.`
        );
        creds = { ...creds, relayerUrl: args.relayerUrl };
    }
    const wasLoggedIn = !!creds;
    if (!creds) {
        if (!process.stdin.isTTY) {
            // Spawned by an MCP client (Cursor / Claude Desktop / etc.).
            // Instead of exiting — which makes the client UI show "Failed to
            // start" with no actionable next step — boot a minimal stdio MCP
            // server that responds to `initialize` and `tools/list` but
            // returns an `isError: true` envelope on every `tools/call` with
            // a friendly login instruction. The user sees the message
            // INLINE in their chat, not buried in stderr logs.
            //
            // Phase B.5 (see plans/memwal-mcp-package-with-login.md) will
            // replace this with the MCP OAuth flow so the client's host
            // drives the browser dance and retries the tool call
            // automatically — no client restart required.
            log.warn("creds.missing_at_spawn.serving_auth_required", {
                credsPath: credsPath(),
            });
            await runAuthRequiredServer();
            return;
        }
        // TTY = manual invocation. Block on the browser flow as before.
        note(
            "MemWal MCP is not authorized yet — opening browser to connect your Sui wallet."
        );
        creds = await loginFlow({ relayerUrl, webUrl, label });
        note(`Authorized as ${creds.walletAddress.slice(0, 10)}...`);
    } else {
        log.info("creds.loaded", {
            accountId: creds.accountId,
            delegateAddress: creds.delegateAddress,
            label: creds.label,
            relayerUrl: creds.relayerUrl,
        });
    }

    // Manual invocation from a real terminal: print status and exit.
    // Bridge mode only makes sense when an MCP client is attached on the
    // other end of stdin (Cursor / Claude Desktop / ...). A TTY means the
    // user is the one looking at stdout — there's no MCP client to bridge
    // with, so hanging the process is the wrong default.
    if (process.stdin.isTTY) {
        note(``);
        if (wasLoggedIn) {
            note(`✅ Already authorized as ${creds.walletAddress.slice(0, 10)}...${creds.walletAddress.slice(-6)}`);
            note(`   Account:  ${creds.accountId}`);
            note(`   Relayer:  ${creds.relayerUrl}`);
        } else {
            note(`✅ Login complete. Credentials saved to ${credsPath()}`);
        }
        note(``);
        note(`Next: add this package to your MCP client config (Cursor / Claude Desktop / etc).`);
        note(`See \`memwal-mcp --help\` for ready-to-paste snippets.`);
        return;
    }

    await runBridge(creds);
}

function printHelp(): void {
    const help = [
        "memwal-mcp — MemWal Model Context Protocol client",
        "",
        "Usage:",
        "  memwal-mcp                       Run the MCP stdio server (default).",
        "                                   Triggers a one-time browser login",
        "                                   if ~/.memwal/credentials.json is",
        "                                   missing.",
        "  memwal-mcp login                 Force re-authentication (wipes",
        "                                   existing credentials and opens",
        "                                   browser).",
        "  memwal-mcp --logout              Delete saved credentials without",
        "                                   re-running login.",
        "  memwal-mcp --help                Show this help.",
        "",
        "Options:",
        "  --relayer <url>                  Override the relayer base URL.",
        "                                   Default: https://relayer.memwal.ai",
        "                                   (or saved value from credentials).",
        "  --web-url <url>                  Override the dashboard URL the",
        "                                   browser opens during login.",
        "                                   Default: https://memwal.ai",
        "  --label <text>                   Friendly delegate-key label",
        "                                   registered on-chain. Default:",
        '                                   "MemWal MCP"',
        "",
        "Environment (equivalent to options):",
        "  MEMWAL_SERVER_URL                same as --relayer",
        "  MEMWAL_WEB_URL                   same as --web-url",
        "  MEMWAL_CLIENT_LABEL              same as --label",
        "  MEMWAL_MCP_DEBUG=1               Verbose stderr logging.",
        "",
        "Minimal MCP client config (Cursor, Claude Desktop, etc.):",
        "  {",
        '    "mcpServers": {',
        '      "memwal": {',
        '        "command": "npx",',
        '        "args": ["-y", "@mysten-incubation/memwal-mcp"]',
        "      }",
        "    }",
        "  }",
        "",
        "With explicit relayer override (e.g. dev environment):",
        "  {",
        '    "mcpServers": {',
        '      "memwal": {',
        '        "command": "npx",',
        '        "args": [',
        '          "-y", "@mysten-incubation/memwal-mcp",',
        '          "--relayer", "https://relayer.dev.memwal.ai"',
        "        ]",
        "      }",
        "    }",
        "  }",
        "",
    ].join("\n");
    process.stderr.write(help + "\n");
}

// Re-exports — handy if someone wants to embed this in another tool.
export { loadCreds, saveCreds, clearCreds, credsPath } from "./auth.js";
export { loginFlow } from "./login.js";
export { runBridge } from "./bridge.js";
export type { MemWalCredentials } from "./auth.js";
