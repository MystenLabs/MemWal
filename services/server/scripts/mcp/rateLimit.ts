/**
 * =============================================================================
 * MCP Rate Limit — IP-based caps applied BEFORE session creation
 * =============================================================================
 * resolveAuth() only checks the SHAPE of the bearer/account-id headers; an
 * unauthenticated caller can synthesize valid-looking values and open a
 * long-lived SSE / streamable transport, holding sidecar memory + relayer
 * proxy streams for hours. We bound that here:
 *
 *   - per-IP cap on concurrent active MCP sessions
 *   - per-IP sliding-window cap on new session opens per minute
 *   - global cap on total concurrent sessions
 *
 * Limits are intentionally generous (a single user with multiple MCP clients
 * — Claude Code + Claude.app + Cursor — must coexist) but tight enough to
 * stop a single source from exhausting sidecar memory.
 *
 * The relayer forwards the client IP via `x-forwarded-for`. On loopback /
 * tests, we fall back to the express `req.ip` (which will be `127.0.0.1`).
 * =============================================================================
 */
import type { Request } from "express";

export interface RateLimitConfig {
    /** Hard cap on total concurrent MCP sessions across all IPs. */
    maxTotalSessions: number;
    /** Concurrent active sessions allowed per source IP. */
    maxSessionsPerIp: number;
    /** New session opens allowed per source IP per minute. */
    maxNewSessionsPerIpPerMin: number;
}

export interface AcquireResult {
    ok: boolean;
    /** When ok=false, the reason code so callers can emit useful errors. */
    reason?: "global_cap" | "ip_active_cap" | "ip_burst_cap";
    retryAfterSeconds?: number;
}

const DEFAULTS: RateLimitConfig = {
    maxTotalSessions: 1000,
    maxSessionsPerIp: 16,
    maxNewSessionsPerIpPerMin: 30,
};

function parsePositiveInt(value: string | undefined, fallback: number): number {
    if (!value) return fallback;
    const n = Number.parseInt(value, 10);
    return Number.isFinite(n) && n > 0 ? n : fallback;
}

export function loadRateLimitConfigFromEnv(): RateLimitConfig {
    return {
        maxTotalSessions: parsePositiveInt(
            process.env.MCP_MAX_TOTAL_SESSIONS,
            DEFAULTS.maxTotalSessions
        ),
        maxSessionsPerIp: parsePositiveInt(
            process.env.MCP_MAX_SESSIONS_PER_IP,
            DEFAULTS.maxSessionsPerIp
        ),
        maxNewSessionsPerIpPerMin: parsePositiveInt(
            process.env.MCP_MAX_NEW_SESSIONS_PER_IP_PER_MIN,
            DEFAULTS.maxNewSessionsPerIpPerMin
        ),
    };
}

/**
 * Best-effort client IP. Honor the relayer's `x-forwarded-for` (first hop is
 * the original caller), fall back to express's `req.ip`. Returns "unknown"
 * if neither is available — counters still apply, just bucketed together.
 */
export function clientIpFromRequest(req: Request): string {
    const fwd = req.headers["x-forwarded-for"];
    const raw = Array.isArray(fwd) ? fwd[0] : fwd;
    if (typeof raw === "string" && raw.length > 0) {
        const first = raw.split(",")[0]?.trim();
        if (first) return first;
    }
    return req.ip ?? "unknown";
}

interface IpState {
    /** Currently-open session count for this IP. */
    active: number;
    /** Timestamps (ms since epoch) of session opens within the last minute. */
    opens: number[];
}

export class McpRateLimiter {
    private readonly config: RateLimitConfig;
    private readonly perIp = new Map<string, IpState>();
    private totalActive = 0;

    constructor(config: RateLimitConfig = loadRateLimitConfigFromEnv()) {
        this.config = config;
    }

    /**
     * Reserve a session slot for `ip`. Returns ok=true if the caller may
     * proceed to open a new MCP session; the caller MUST invoke `release(ip)`
     * (or `releaseFn()`) exactly once when the session closes.
     */
    acquire(ip: string): AcquireResult {
        if (this.totalActive >= this.config.maxTotalSessions) {
            return { ok: false, reason: "global_cap", retryAfterSeconds: 30 };
        }

        const now = Date.now();
        const state = this.perIp.get(ip) ?? { active: 0, opens: [] };

        // Drop opens older than 60s (sliding window).
        const cutoff = now - 60_000;
        if (state.opens.length > 0) {
            state.opens = state.opens.filter((t) => t > cutoff);
        }

        if (state.active >= this.config.maxSessionsPerIp) {
            return { ok: false, reason: "ip_active_cap", retryAfterSeconds: 30 };
        }

        if (state.opens.length >= this.config.maxNewSessionsPerIpPerMin) {
            // Suggest waiting until the oldest open ages out of the window.
            const oldest = state.opens[0] ?? now;
            const wait = Math.max(1, Math.ceil((oldest + 60_000 - now) / 1000));
            return { ok: false, reason: "ip_burst_cap", retryAfterSeconds: wait };
        }

        state.opens.push(now);
        state.active += 1;
        this.perIp.set(ip, state);
        this.totalActive += 1;

        return { ok: true };
    }

    /**
     * Release a previously-acquired slot for `ip`. Idempotent guard via the
     * `releaseFn()` helper — callers that take the helper closure get
     * at-most-once semantics for free.
     */
    release(ip: string): void {
        const state = this.perIp.get(ip);
        if (!state) return;
        state.active = Math.max(0, state.active - 1);
        this.totalActive = Math.max(0, this.totalActive - 1);
        if (state.active === 0 && state.opens.length === 0) {
            this.perIp.delete(ip);
        }
    }

    /**
     * Returns a one-shot release closure. Calling it twice is a no-op so
     * caller code can wire it to multiple cleanup paths (transport.onclose
     * AND res.on("close")) without double-counting.
     */
    releaseFn(ip: string): () => void {
        let released = false;
        return () => {
            if (released) return;
            released = true;
            this.release(ip);
        };
    }

    /** Snapshot for /healthz observability. */
    stats(): { totalActive: number; uniqueIps: number; config: RateLimitConfig } {
        return {
            totalActive: this.totalActive,
            uniqueIps: this.perIp.size,
            config: this.config,
        };
    }
}
