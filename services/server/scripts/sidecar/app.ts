/**
 * Express app assembly.
 *
 * Registration order is load-bearing:
 *   1. request-id + CORS-strip middleware run for every request.
 *   2. /health, /ready, /metrics/wallet, and full-mode MCP routes are mounted BEFORE
 *      the shared-secret middleware — they must stay reachable without the
 *      sidecar token (probes, scrapers, and MCP traffic that carries the
 *      end-user's own Bearer token instead).
 *   3. Everything registered after sharedSecretAuthMiddleware requires
 *      Authorization: Bearer <SIDECAR_AUTH_TOKEN>.
 */

import express, { type Express } from "express";
import { mountMcpRoutes } from "../mcp/index.js";
import { SIDECAR_ROUTE_MODE } from "./config.js";
import {
    requestIdMiddleware,
    sharedSecretAuthMiddleware,
    stripCorsMiddleware,
} from "./middleware.js";
import { registerHealthRoute, registerWalletMetricsRoute } from "./routes/health.js";
import { registerSealRoutes } from "./routes/seal.js";
import { registerV2Routes } from "./routes/v2.js";
import { registerSponsorRoutes } from "./routes/sponsor.js";
import {
    registerWalrusMetadataRoute,
    registerWalrusMetadataRoutes,
} from "./routes/walrus-metadata.js";
import { registerWalrusQueryRoute } from "./routes/walrus-query.js";
import { registerWalrusUploadRoute } from "./routes/walrus-upload.js";
import { registerWalrusUploadJournalRoute } from "./routes/walrus-upload-journal.js";

export function createSidecarApp(mode: "full" | "writer" = SIDECAR_ROUTE_MODE): Express {
    const app = express();

    app.use(requestIdMiddleware);
    app.use(stripCorsMiddleware);

    // Health check — placed before auth middleware so it is always reachable.
    registerHealthRoute(app);

    // MCP routes — `/mcp/sse` + `/mcp/messages`. Mounted BEFORE the shared-secret
    // middleware: MCP traffic is forwarded by the Rust relayer with the end-user's
    // own delegate-key Bearer token in `Authorization`, NOT the sidecar's shared
    // secret. The MCP layer does its own auth (parse delegate key + account id
    // from request headers). These routes are reachable only from the relayer
    // over localhost — same trust boundary as the rest of the sidecar.
    if (mode === "full") {
        mountMcpRoutes(app, {
            relayerUrl: process.env.MEMWAL_RELAYER_URL ?? "http://localhost:3001",
        });
    }

    // Wallet-execution metrics — placed before auth so operators / scrapers
    // don't need a token.
    registerWalletMetricsRoute(app);

    app.use(sharedSecretAuthMiddleware);

    if (mode === "writer") {
        registerWalrusUploadJournalRoute(app);
        registerWalrusMetadataRoute(app, true);
        registerV2Routes(app);
        return app;
    }

    registerSealRoutes(app);
    registerV2Routes(app);
    registerWalrusUploadJournalRoute(app);
    registerWalrusUploadRoute(app);
    registerWalrusMetadataRoutes(app);
    registerWalrusQueryRoute(app);
    registerSponsorRoutes(app);

    return app;
}
