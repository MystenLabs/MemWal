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
import { randomBytes, timingSafeEqual } from "node:crypto";
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
    /**
     * Fired exactly once with the fully-built `connectUrl` as soon as the
     * localhost listener is ready. Lets callers surface the URL through their
     * own channel (e.g. an MCP `notifications/progress` so the agent shows it
     * inline) in case `open()` fails or runs in a context where the user
     * can't see the spawned browser tab.
     */
    onUrl?: (connectUrl: string) => void;
}

const DEFAULTS: Required<Omit<LoginOptions, "label" | "onUrl">> & { label: string } = {
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
    /**
     * Cryptographic state token — must match the value we put in `connectUrl`.
     * Without this, a malicious tab could POST forged credentials to our
     * localhost listener before the legitimate browser tab does (cross-origin
     * login-CSRF + DNS rebinding). See SECURITY.md / audit C2.
     */
    state: string;
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
        isHexAddress(o.packageId) &&
        typeof o.state === "string" &&
        // 32 random bytes → 64 hex chars. Constant width — anything else is wrong.
        /^[0-9a-f]{64}$/.test(o.state)
    );
}

/**
 * Constant-time comparison for the state token. `===` would still leak the
 * common-prefix length via timing in theory; not a realistic remote attack
 * on a localhost listener, but cheap defense in depth.
 */
function stateEquals(a: string, b: string): boolean {
    if (a.length !== b.length) return false;
    try {
        return timingSafeEqual(Buffer.from(a, "hex"), Buffer.from(b, "hex"));
    } catch {
        return false;
    }
}

/**
 * Strip trailing slashes so `https://memwal.ai/` and `https://memwal.ai`
 * compare equal. The `Origin` request header never carries a trailing slash.
 */
function normalizeOrigin(url: string): string {
    return url.replace(/\/+$/, "");
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
    // Cryptographic single-use state token. Round-trip through the browser:
    // we put it in `connectUrl`, the page echoes it back in the callback
    // payload, and we constant-time-compare on receipt. Defeats cross-origin
    // CSRF / DNS-rebinding attacks where a malicious tab races the legitimate
    // browser to POST forged credentials at our localhost listener.
    const stateToken = randomBytes(32).toString("hex");
    // Expected `Origin` header value. The dashboard page that legitimately
    // POSTs to `/callback` runs on `cfg.webUrl`. Any other Origin is rejected.
    const expectedOrigin = normalizeOrigin(cfg.webUrl);

    // 0 → OS picks a free port. Bind 127.0.0.1 only — NOT 0.0.0.0 — so the
    // listener is unreachable from the LAN.
    const server = createServer();
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as AddressInfo).port;
    // Allow `127.0.0.1:PORT` and `localhost:PORT` as the Host header (defeats
    // DNS rebinding to an attacker-controlled name that resolves to 127.0.0.1).
    const allowedHosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`]);

    // Build the dashboard URL. `webUrl` may or may not include a path
    // already — join carefully.
    const base = cfg.webUrl.replace(/\/+$/, "");
    const connectUrl =
        `${base}/connect/mcp` +
        `?port=${port}` +
        `&publicKey=${encodeURIComponent(keypair.publicKeyHex)}` +
        `&delegateAddress=${encodeURIComponent(keypair.suiAddress)}` +
        `&label=${encodeURIComponent(cfg.label)}` +
        `&relayer=${encodeURIComponent(cfg.relayerUrl)}` +
        `&state=${stateToken}`;

    note(`Opening browser to authorize this MCP client...`);
    note(`If your browser doesn't open, visit: ${connectUrl}`);
    log.info("login.start", { port, publicKey: keypair.publicKeyHex, label: cfg.label });
    // Surface the URL to programmatic callers (e.g. MCP tool wrapper) so it
    // can be shown inline in the chat — `note` only writes to stderr which
    // MCP clients usually don't surface.
    try {
        cfg.onUrl?.(connectUrl);
    } catch {
        /* caller errors don't break the flow */
    }

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
            // CORS — only the dashboard origin we control may POST. `*` would
            // let any web page on the internet talk to this localhost port.
            res.setHeader("access-control-allow-origin", expectedOrigin);
            res.setHeader("access-control-allow-methods", "POST, OPTIONS");
            res.setHeader("access-control-allow-headers", "content-type");
            res.setHeader("vary", "origin");
            if (req.method === "OPTIONS") {
                res.writeHead(204);
                res.end();
                return;
            }

            // DNS-rebinding defense. A browser tricked into resolving
            // `evil.example` → 127.0.0.1 would still send `Host: evil.example`
            // — anything that isn't our literal loopback host is a forgery.
            const hostHeader = (req.headers.host ?? "").toLowerCase();
            if (!allowedHosts.has(hostHeader)) {
                log.warn("login.callback_bad_host", { host: hostHeader });
                res.writeHead(403, { "content-type": "text/plain" });
                res.end("Forbidden");
                return;
            }

            const url = new URL(req.url ?? "/", `http://127.0.0.1:${port}`);
            if (url.pathname !== "/callback" || req.method !== "POST") {
                res.writeHead(404, { "content-type": "text/plain" });
                res.end("Not found");
                return;
            }

            // Origin check — only the dashboard page may submit the callback.
            // `null` or missing Origin (e.g. curl, non-browser) is rejected
            // because the entire flow is initiated by a browser tab.
            const origin = req.headers.origin;
            if (typeof origin !== "string" || normalizeOrigin(origin) !== expectedOrigin) {
                log.warn("login.callback_bad_origin", { origin });
                res.writeHead(403, { "content-type": "text/plain" });
                res.end("Forbidden");
                return;
            }

            // Content-Type assertion blocks simple-request smuggling: a CSRF
            // attacker can POST `text/plain` cross-origin without preflight,
            // but `application/json` triggers preflight which our restricted
            // CORS allow-origin will reject.
            const ct = (req.headers["content-type"] ?? "").toLowerCase();
            if (!ct.startsWith("application/json")) {
                res.writeHead(415, { "content-type": "text/plain" });
                res.end("Content-Type must be application/json");
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
                if (!stateEquals(parsed.state, stateToken)) {
                    log.warn("login.callback_bad_state", {});
                    res.writeHead(403, { "content-type": "text/html" });
                    res.end(FAIL_HTML_TEMPLATE("Callback state mismatch — refusing to save."));
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
