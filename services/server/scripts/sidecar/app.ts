/**
 * Express app assembly.
 *
 * Registration order is load-bearing:
 *   1. request-id + CORS-strip middleware run for every request.
 *   2. /health, MCP routes and /metrics/wallet are mounted BEFORE the
 *      shared-secret middleware — they must stay reachable without the
 *      sidecar token (probes, scrapers, and MCP traffic that carries the
 *      end-user's own Bearer token instead).
 *   3. Everything registered after sharedSecretAuthMiddleware requires
 *      Authorization: Bearer <SIDECAR_AUTH_TOKEN>.
 */

import express, { type Express } from "express";
import { mountMcpRoutes } from "../mcp/index.js";
import {
    requestIdMiddleware,
    sharedSecretAuthMiddleware,
    stripCorsMiddleware,
} from "./middleware.js";
import { registerHealthRoute, registerWalletMetricsRoute } from "./routes/health.js";
import { registerSealRoutes } from "./routes/seal.js";
import { registerSponsorRoutes } from "./routes/sponsor.js";
import { registerWalrusMetadataRoutes } from "./routes/walrus-metadata.js";
import { registerWalrusQueryRoute } from "./routes/walrus-query.js";
import { registerWalrusUploadRoute } from "./routes/walrus-upload.js";

export function createSidecarApp(): Express {
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
    mountMcpRoutes(app, {
        relayerUrl: process.env.MEMWAL_RELAYER_URL ?? "http://localhost:3001",
    });

    // Wallet-execution metrics — placed before auth so operators / scrapers
    // don't need a token.
    registerWalletMetricsRoute(app);

    app.use(sharedSecretAuthMiddleware);

    registerSealRoutes(app);
    registerWalrusUploadRoute(app);
    registerWalrusMetadataRoutes(app);
    registerWalrusQueryRoute(app);
    registerSponsorRoutes(app);

    return app;
}
