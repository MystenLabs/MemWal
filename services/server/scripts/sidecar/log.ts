/**
 * Structured logging + request-id helpers.
 */

import { randomUUID } from "crypto";
import type { Request } from "express";

export type RequestWithId = Request & { requestId?: string };

export function sanitizeRequestId(value: unknown): string | null {
    const raw = Array.isArray(value) ? value[0] : value;
    if (typeof raw !== "string") return null;
    const trimmed = raw.trim();
    if (!/^[A-Za-z0-9_.:-]{1,128}$/.test(trimmed)) return null;
    return trimmed;
}

export function requestIdFor(req: Request): string {
    return (req as RequestWithId).requestId
        ?? sanitizeRequestId(req.headers["x-request-id"])
        ?? randomUUID();
}

export function sidecarLog(
    level: "info" | "warn" | "error",
    event: string,
    fields: Record<string, unknown> = {},
): void {
    const line = JSON.stringify({
        ts: new Date().toISOString(),
        level,
        scope: "memwal-sidecar",
        event,
        ...fields,
    });
    if (level === "error") {
        console.error(line);
    } else if (level === "warn") {
        console.warn(line);
    } else {
        console.log(line);
    }
}
