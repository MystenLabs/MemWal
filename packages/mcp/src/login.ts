/**
 * Browser-based login flow — port of Walcraft's CLI login pattern.
 *
 *   1. Generate Ed25519 keypair locally.
 *   2. Start an HTTP listener on a random localhost port.
 *   3. Open the user's browser at the configured web URL with the public
 *      key + callback port in the query string.
 *   4. Web page asks user to connect Sui wallet → signs `add_delegate_key`
 *      on-chain → POSTs the resulting {accountId, walletAddress, packageId,
 *      txDigest, ...} to `http://localhost:<port>/callback`.
 *   5. Listener receives the callback, returns 200 + a friendly success
 *      page, then shuts down. We resolve with `MemWalCredentials`.
 *
 * Timeout default is 5 minutes — long enough for a slow wallet popup but
 * short enough that a forgotten flow doesn't keep an open port forever.
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { AddressInfo } from "node:net";
import open from "open";

import type { MemWalCredentials } from "./auth.js";
import { saveCreds } from "./auth.js";
import { generateKeypair } from "./crypto.js";
import { log, note } from "./logger.js";

export interface LoginOptions {
    /** Base URL of the dashboard's connect page (must accept `?port=&publicKey=`). */
    webUrl?: string;
    /** Relayer URL the credentials should be configured for. */
    relayerUrl?: string;
    /** Friendly label saved on-chain + in credentials.json — e.g. "Cursor MCP". */
    label?: string;
    /** Abort the flow if no callback received within this many ms. */
    timeoutMs?: number;
    /** Open the URL ourselves vs print it (`false` is useful in headless CI). */
    openBrowser?: boolean;
}

const DEFAULTS: Required<Omit<LoginOptions, "label">> & { label: string } = {
    webUrl: process.env.MEMWAL_WEB_URL ?? "https://memwal.ai",
    relayerUrl: process.env.MEMWAL_SERVER_URL ?? "https://relayer.memwal.ai",
    label: process.env.MEMWAL_CLIENT_LABEL ?? "MemWal MCP",
    timeoutMs: 5 * 60_000,
    openBrowser: true,
};

interface CallbackPayload {
    accountId: string;
    walletAddress: string;
    packageId: string;
    txDigest?: string;
    label?: string;
}

function isHexAddress(s: unknown): s is string {
    return typeof s === "string" && /^0x[0-9a-fA-F]{64}$/.test(s);
}

function isCallback(obj: unknown): obj is CallbackPayload {
    if (!obj || typeof obj !== "object") return false;
    const o = obj as Record<string, unknown>;
    return (
        isHexAddress(o.accountId) &&
        isHexAddress(o.walletAddress) &&
        isHexAddress(o.packageId)
    );
}

const SUCCESS_HTML = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>MemWal MCP — Connected</title>
  <style>
    body { font: 16px/1.5 system-ui, sans-serif; max-width: 480px; margin: 80px auto; padding: 0 24px; color: #1a1a1a; }
    h1 { font-size: 24px; }
    .check { display: inline-block; width: 32px; height: 32px; line-height: 32px; text-align: center; border-radius: 50%; background: #22c55e; color: white; font-weight: 700; margin-right: 12px; vertical-align: middle; }
    p { color: #525252; }
  </style>
</head>
<body>
  <h1><span class="check">✓</span> MemWal MCP connected</h1>
  <p>Credentials saved to <code>~/.memwal/credentials.json</code>.</p>
  <p>You can close this tab — your MCP client will pick up the new credentials automatically.</p>
</body>
</html>`;

const FAIL_HTML_TEMPLATE = (msg: string) => `<!doctype html>
<html lang="en">
<head><meta charset="utf-8" /><title>MemWal MCP — Failed</title>
<style>body{font:16px/1.5 system-ui,sans-serif;max-width:480px;margin:80px auto;padding:0 24px;color:#1a1a1a}h1{font-size:24px}.x{display:inline-block;width:32px;height:32px;line-height:32px;text-align:center;border-radius:50%;background:#ef4444;color:white;font-weight:700;margin-right:12px;vertical-align:middle}p{color:#525252}</style>
</head>
<body>
  <h1><span class="x">×</span> MemWal MCP login failed</h1>
  <p>${msg}</p>
  <p>Close this tab and retry from your MCP client.</p>
</body></html>`;

function readBody(req: IncomingMessage, maxBytes = 16 * 1024): Promise<string> {
    return new Promise((resolve, reject) => {
        const chunks: Buffer[] = [];
        let len = 0;
        req.on("data", (c: Buffer) => {
            len += c.length;
            if (len > maxBytes) {
                reject(new Error("body too large"));
                req.destroy();
                return;
            }
            chunks.push(c);
        });
        req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
        req.on("error", reject);
    });
}

/**
 * Run the login flow. Resolves with saved credentials. Caller is expected
 * to call this only when no valid credentials exist on disk.
 */
export async function loginFlow(opts: LoginOptions = {}): Promise<MemWalCredentials> {
    const cfg = { ...DEFAULTS, ...opts };
    const keypair = await generateKeypair();

    // 0 → OS picks a free port.
    const server = createServer();
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as AddressInfo).port;

    // Build the dashboard URL. `webUrl` may or may not include a path
    // already — join carefully.
    const base = cfg.webUrl.replace(/\/+$/, "");
    const connectUrl =
        `${base}/connect/mcp` +
        `?port=${port}` +
        `&publicKey=${encodeURIComponent(keypair.publicKeyHex)}` +
        `&delegateAddress=${encodeURIComponent(keypair.suiAddress)}` +
        `&label=${encodeURIComponent(cfg.label)}` +
        `&relayer=${encodeURIComponent(cfg.relayerUrl)}`;

    note(`Opening browser to authorize this MCP client...`);
    note(`If your browser doesn't open, visit: ${connectUrl}`);
    log.info("login.start", { port, publicKey: keypair.publicKeyHex, label: cfg.label });

    let creds: MemWalCredentials | null = null;
    let error: Error | null = null;

    const done = new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
            if (!creds) {
                error = new Error(`Login timed out after ${cfg.timeoutMs}ms`);
                server.close();
                resolve();
            }
        }, cfg.timeoutMs).unref?.();
        void timer;

        server.on("request", async (req: IncomingMessage, res: ServerResponse) => {
            // CORS — let the dashboard JS POST to localhost.
            res.setHeader("access-control-allow-origin", "*");
            res.setHeader("access-control-allow-methods", "POST, OPTIONS");
            res.setHeader("access-control-allow-headers", "content-type");
            if (req.method === "OPTIONS") {
                res.writeHead(204);
                res.end();
                return;
            }

            const url = new URL(req.url ?? "/", `http://127.0.0.1:${port}`);
            if (url.pathname !== "/callback" || req.method !== "POST") {
                res.writeHead(404, { "content-type": "text/plain" });
                res.end("Not found");
                return;
            }

            try {
                const body = await readBody(req);
                const parsed = JSON.parse(body);
                if (!isCallback(parsed)) {
                    res.writeHead(400, { "content-type": "text/html" });
                    res.end(FAIL_HTML_TEMPLATE("Callback payload missing required fields."));
                    return;
                }

                creds = {
                    delegatePrivateKey: keypair.privateKeyHex,
                    delegatePublicKeyHex: keypair.publicKeyHex,
                    delegateAddress: keypair.suiAddress,
                    walletAddress: parsed.walletAddress,
                    accountId: parsed.accountId,
                    packageId: parsed.packageId,
                    relayerUrl: cfg.relayerUrl,
                    label: parsed.label ?? cfg.label,
                    createdAt: new Date().toISOString(),
                    version: 1,
                };
                saveCreds(creds);
                log.info("login.success", {
                    accountId: creds.accountId,
                    delegateAddress: creds.delegateAddress,
                    label: creds.label,
                });

                res.writeHead(200, { "content-type": "text/html" });
                res.end(SUCCESS_HTML);
                resolve();
                // Let the response flush before closing the server.
                setTimeout(() => server.close(), 100);
            } catch (err) {
                error = err instanceof Error ? err : new Error(String(err));
                res.writeHead(500, { "content-type": "text/html" });
                res.end(FAIL_HTML_TEMPLATE("Internal error parsing callback."));
                log.error("login.callback_error", { msg: error.message });
                setTimeout(() => server.close(), 100);
                resolve();
            }
        });
    });

    if (cfg.openBrowser) {
        try {
            await open(connectUrl);
        } catch (err) {
            log.warn("login.browser_open_failed", {
                err: err instanceof Error ? err.message : String(err),
            });
        }
    }

    await done;

    if (error) throw error;
    if (!creds) throw new Error("Login flow completed without credentials");
    return creds;
}
