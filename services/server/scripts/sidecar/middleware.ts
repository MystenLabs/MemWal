/**
 * App-level middleware: request-id propagation, CORS stripping, and the
 * shared-secret auth gate.
 */

import { randomUUID, timingSafeEqual } from "crypto";
import type { NextFunction, Request, Response as ExpressResponse } from "express";
import { sanitizeRequestId, type RequestWithId } from "./log.js";

export function requestIdMiddleware(req: RequestWithId, res: ExpressResponse, next: NextFunction): void {
    const requestId = sanitizeRequestId(req.headers["x-request-id"])
        ?? sanitizeRequestId(req.headers["x-correlation-id"])
        ?? randomUUID();
    req.requestId = requestId;
    res.setHeader("x-request-id", requestId);
    next();
}

// CORS — sidecar is called only by the co-located Rust server, never by browsers.
// Remove all CORS headers so no cross-origin access is granted.
export function stripCorsMiddleware(req: Request, res: ExpressResponse, next: NextFunction): void {
    res.removeHeader("Access-Control-Allow-Origin");
    res.removeHeader("Access-Control-Allow-Methods");
    res.removeHeader("Access-Control-Allow-Headers");
    if (req.method === "OPTIONS") {
        res.sendStatus(204);
        return;
    }
    next();
}

// Shared-secret authentication — protects all routes registered after this
// middleware. Set SIDECAR_AUTH_TOKEN in the environment; callers must send it
// as Authorization: Bearer <token>.
// Sidecar refuses to start if SIDECAR_AUTH_TOKEN is not set.
const SIDECAR_AUTH_TOKEN = process.env.SIDECAR_AUTH_TOKEN;
if (!SIDECAR_AUTH_TOKEN) {
    console.error("[sidecar] FATAL: SIDECAR_AUTH_TOKEN not set. Refusing to start without auth.");
    process.exit(1);
}

export function sharedSecretAuthMiddleware(req: Request, res: ExpressResponse, next: NextFunction): void {
    const token = req.headers.authorization?.replace("Bearer ", "");
    const secretBuf = Buffer.from(SIDECAR_AUTH_TOKEN!);
    const providedBuf = Buffer.from(typeof token === "string" ? token : "");
    // timingSafeEqual prevents timing side-channel attacks on the token comparison.
    // Buffers must be same length — if lengths differ it's already a mismatch.
    const valid = providedBuf.length === secretBuf.length &&
        timingSafeEqual(providedBuf, secretBuf);
    if (!valid) {
        res.status(401).json({ error: "Unauthorized" });
        return;
    }
    next();
}
