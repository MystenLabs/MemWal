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
import {
    registerHealthRoute,
    registerInternalWalletBalancesRoute,
    registerWalletMetricsRoute,
} from "./routes/health.js";
import { registerSealRoutes } from "./routes/seal.js";
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
    registerHealthRoute(app, mode === "full");

    // MCP routes — `/mcp/sse` + `/mcp/messages`. Mounted BEFORE the shared-secret
    // middleware: MCP traffic is forwarded by the Rust relayer with the end-user's
    // own delegate-key Bearer token in `Authorization`, NOT the sidecar's shared
    // secret. The MCP layer does its own auth (parse delegate key + account id
    // from request headers).
    //
    // Skipping the middleware does NOT mean these routes are unauthenticated:
    // `resolveAuth` requires the sidecar shared secret in
    // `x-memwal-internal-sidecar-token` before it will honour any
    // `x-memwal-internal-*` header, so localhost reachability alone is not
    // enough to claim relayer-issued privileges (GH #685).
    if (mode === "full") {
        mountMcpRoutes(app, {
            relayerUrl: process.env.MEMWAL_RELAYER_URL ?? "http://localhost:3001",
        });
    }

    // Wallet-execution metrics — placed before auth so operators / scrapers
    // don't need a token.
    registerWalletMetricsRoute(app);

    app.use(sharedSecretAuthMiddleware);

    // Full wallet addresses and per-wallet balances are operationally sensitive.
    registerInternalWalletBalancesRoute(app);

    if (mode === "writer") {
        registerWalrusUploadJournalRoute(app);
        registerWalrusMetadataRoute(app, true);
        return app;
    }

    registerSealRoutes(app);
    registerWalrusUploadJournalRoute(app);
    registerWalrusUploadRoute(app);
    registerWalrusMetadataRoutes(app);
    registerWalrusQueryRoute(app);
    registerSponsorRoutes(app);

    return app;
}
