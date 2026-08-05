/**
 * Sidecar HTTP server bootstrap: bind, log readiness, and wire graceful
 * shutdown + crash diagnostics.
 */

import { shutdownMcpSessions } from "../mcp/index.js";
import { createSidecarApp } from "./app.js";
import {
    SEAL_POLICY_PACKAGE_ID,
    SIDECAR_HOST,
    SIDECAR_PORT,
    SIDECAR_SHUTDOWN_TIMEOUT_MS,
} from "./config.js";
import { sidecarStartedAtMs, sidecarStateSnapshot } from "./state.js";
import { truncateForLog } from "./util.js";

export function startSidecarServer(): void {
    const app = createSidecarApp();
    const server = app.listen(SIDECAR_PORT, SIDECAR_HOST, () => {
        console.log(JSON.stringify({
            event: "sidecar_ready",
            host: SIDECAR_HOST,
            port: SIDECAR_PORT,
            pid: process.pid,
            sealPolicyPackageId: SEAL_POLICY_PACKAGE_ID,
            state: sidecarStateSnapshot(),
        }));
    });

    // Graceful shutdown — close MCP transports first so SSE clients disconnect
    // cleanly, then close the HTTP server.
    async function gracefulShutdown(signal: string): Promise<void> {
        console.log(JSON.stringify({ event: "sidecar_shutdown_begin", signal }));
        try {
            await shutdownMcpSessions();
        } catch (err: any) {
            console.error(`[sidecar] mcp shutdown error: ${err?.message || err}`);
        }
        server.close((err) => {
            if (err) {
                console.error(`[sidecar] http close error: ${err.message}`);
                process.exit(1);
            }
            console.log(JSON.stringify({ event: "sidecar_shutdown_complete" }));
            process.exit(0);
        });
        setTimeout(() => {
            console.error(`[sidecar] forced exit after ${SIDECAR_SHUTDOWN_TIMEOUT_MS}ms`);
            process.exit(1);
        }, SIDECAR_SHUTDOWN_TIMEOUT_MS).unref();
    }
    process.on("SIGTERM", () => void gracefulShutdown("SIGTERM"));
    process.on("SIGINT", () => void gracefulShutdown("SIGINT"));
    process.on("uncaughtException", (err) => {
        console.error(`[sidecar] uncaught_exception ${JSON.stringify({
            uptimeMs: Date.now() - sidecarStartedAtMs,
            message: truncateForLog(err?.message || String(err)),
            stack: truncateForLog(err?.stack || ""),
            state: sidecarStateSnapshot(),
        })}`);
        process.exit(1);
    });
    process.on("unhandledRejection", (reason) => {
        console.error(`[sidecar] unhandled_rejection ${JSON.stringify({
            uptimeMs: Date.now() - sidecarStartedAtMs,
            reason: truncateForLog(reason instanceof Error ? reason.message : reason),
            stack: truncateForLog(reason instanceof Error ? reason.stack || "" : ""),
            state: sidecarStateSnapshot(),
        })}`);
    });
}
