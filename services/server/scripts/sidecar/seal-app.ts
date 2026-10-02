/**
 * Seal-only Express app. It runs in its own process so Walrus upload CPU
 * and connection pressure on the main sidecar cannot stall decrypt.
 */

import express, { type Express } from "express";
import { requestIdMiddleware, sharedSecretAuthMiddleware, stripCorsMiddleware } from "./middleware.js";
import { registerHealthRoute } from "./routes/health.js";
import { registerSealRoutes } from "./routes/seal.js";

export function createSealApp(): Express {
    const app = express();
    app.use(requestIdMiddleware);
    app.use(stripCorsMiddleware);
    // Liveness only. /ready on this process would check upload identity,
    // which the seal process does not own.
    registerHealthRoute(app, false);
    app.use(sharedSecretAuthMiddleware);
    registerSealRoutes(app);
    return app;
}
