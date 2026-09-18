/**
 * Why a tool call failed, in words an agent can act on. Every message carries
 * the same three lines — `Cause`, `Relayer health`, `Next step` — because the
 * agent only reads text.
 */

export type HealthProbe =
    | { kind: "ok"; ms: number; version?: string; writesUnavailable?: boolean }
    | { kind: "http"; ms: number; status: number }
    | { kind: "unreachable"; ms: number; code: string }
    | { kind: "timeout"; ms: number };

export type ToolFailure =
    | { kind: "recall_timeout"; stage: string | null; elapsedMs: number | null }
    | { kind: "timeout" }
    | { kind: "unreachable"; code: string; host: string | null }
    | { kind: "other" };

/** Tools whose call may already have stored something by the time it fails.
 * Mirrors the bridge's `MUTATING_TOOLS`: a retry of one of these can mint a
 * second paid blob, so none is ever told a retry is safe. */
export const WRITE_TOOLS: ReadonlySet<string> = new Set([
    "memwal_remember",
    "memwal_remember_bulk",
    "memwal_analyze",
]);

/** How the SDK says it gave up waiting: 0.1.7 aborts recall with a bare
 * `AbortError`, 0.1.8 throws its own `MemWalRequestTimeout`. */
const TIMEOUT_NAMES = new Set(["AbortError", "TimeoutError", "MemWalRequestTimeout"]);

export function classifyToolError(err: unknown): ToolFailure {
    if (err == null || typeof err !== "object") return { kind: "other" };
    const e = err as { name?: unknown; message?: unknown; serverCode?: unknown; cause?: unknown };
    if (e.serverCode === "RECALL_TIMEOUT") {
        // The SDK keeps the raw body on `cause`; the stage is only there.
        const body = parseObject(e.cause);
        return {
            kind: "recall_timeout",
            stage: typeof body?.stage === "string" ? body.stage : null,
            elapsedMs: typeof body?.elapsed_ms === "number" ? body.elapsed_ms : null,
        };
    }
    if (typeof e.name === "string" && TIMEOUT_NAMES.has(e.name)) return { kind: "timeout" };
    if (e.message === "fetch failed") {
        return { kind: "unreachable", code: codeOf(e.cause), host: hostOf(e.cause) };
    }
    return { kind: "other" };
}

/** `GET {baseUrl}/health`, bounded by `timeoutMs`. Never rejects: a probe
 * that fails is itself the answer. */
export async function probeRelayerHealth(
    baseUrl: string,
    timeoutMs: number,
): Promise<HealthProbe> {
    const started = Date.now();
    let signal: AbortSignal | undefined;
    try {
        // Inside the `try`: `AbortSignal.timeout` throws on a value it
        // cannot take, and this function must not reject.
        signal = AbortSignal.timeout(timeoutMs);
        const res = await fetch(`${baseUrl.replace(/\/+$/, "")}/health`, { signal });
        const ms = Date.now() - started;
        if (!res.ok) {
            await res.body?.cancel();
            return { kind: "http", ms, status: res.status };
        }
        const body = (await res.json().catch(() => null)) as {
            version?: unknown;
            write_ready?: unknown;
            writes?: unknown;
        } | null;
        const version = typeof body?.version === "string" ? body.version : undefined;
        // `/health` answers 200 while writes are paused or Postgres is
        // full; "ok" alone would hide the cause of a failed write.
        const writesUnavailable = body?.write_ready === false || body?.writes === "paused";
        return { kind: "ok", ms, version, ...(writesUnavailable ? { writesUnavailable } : {}) };
    } catch (err) {
        const ms = Date.now() - started;
        if (signal?.aborted) return { kind: "timeout", ms };
        return { kind: "unreachable", ms, code: codeOf((err as { cause?: unknown })?.cause) };
    }
}

const STAGES: Record<string, { doing: string; next: string }> = {
    embed: {
        doing: "turning the query into an embedding",
        next: "The embedding provider is slow. Wait a minute, then retry.",
    },
    vector_search: {
        doing: "searching the memory index",
        next: "The memory database is slow. Wait a minute, then retry.",
    },
    walrus_download: {
        doing: "downloading memories from Walrus",
        next:
            "Walrus is slow to return memories. Retry once; if it happens again, " +
            "lower `limit` so fewer memories are downloaded.",
    },
    seal_decrypt: {
        doing: "decrypting memories with SEAL",
        next: "The SEAL key servers are slow. Wait a minute, then retry.",
    },
    auth: {
        doing: "checking credentials, before the recall could start",
        next:
            "Checking the delegate key used up the whole deadline. Retry once; if it " +
            "happens again, report it with the time of the call.",
    },
};

export function describeFailure(
    tool: string,
    failure: Exclude<ToolFailure, { kind: "other" }>,
    probe: HealthProbe | null,
): string {
    if (failure.kind === "recall_timeout") {
        const known = failure.stage === null ? undefined : STAGES[failure.stage];
        const doing = known?.doing ?? (failure.stage ? `at step "${failure.stage}"` : "");
        const after =
            failure.elapsedMs === null ? "" : ` after ${(failure.elapsedMs / 1000).toFixed(1)}s`;
        return lines(
            "❌ Walrus Memory recall timed out.",
            `the relayer stopped${after}${doing ? ` while ${doing}` : ""}.`,
            "up (it answered this call).",
            known?.next ?? "Retry once.",
        );
    }

    // Before a recall reaches the relayer, the SDK builds a SEAL session on
    // the Sui fullnode, and on 0.1.7 its 15s clock is already running. So a
    // timeout or a failed request is only the relayer's when the relayer's
    // own `/health` also fails; otherwise say what is actually known.
    const healthy = probe?.kind === "ok";
    let headline: string;
    let cause: string;
    if (failure.kind === "timeout") {
        headline = `❌ Walrus Memory ${tool} timed out.`;
        cause = healthy
            ? "no answer within the SDK's time limit. The relayer answered its health check, " +
              "so the time went on this call: inside the relayer, or on a service it waits " +
              "on first (such as the Sui fullnode)."
            : "no answer within the SDK's time limit, and the relayer is not healthy.";
    } else if (healthy) {
        const where = failure.host ? ` to ${failure.host}` : "";
        headline = `❌ Walrus Memory ${tool} could not complete a network request.`;
        cause =
            `a request this call depends on failed${where} (${failure.code}). The relayer ` +
            "answered its health check, so the failure is on the way to another service " +
            "this call needs (such as the Sui fullnode), or it was brief.";
    } else {
        headline = `❌ Walrus Memory ${tool} could not reach the relayer.`;
        cause = `the connection to the relayer failed (${failure.code}).`;
    }

    // Not "this call only reads": `memwal_restore` re-indexes. What makes a
    // retry safe is that none of these can store a duplicate.
    let next: string;
    if (WRITE_TOOLS.has(tool)) {
        next =
            "this call writes, so it may already be stored. Check with `memwal_recall` " +
            "before saving it again." +
            (healthy ? "" : " The relayer is not healthy right now, so wait a minute first.");
    } else if (healthy) {
        next =
            "repeating this call cannot store a duplicate, so it is safe to retry once. If " +
            "it keeps happening, report it with the time of the call.";
    } else {
        next =
            "repeating this call cannot store a duplicate, so it is safe to retry, but " +
            "wait a minute first: the relayer is not healthy right now.";
    }
    return lines(headline, cause, healthLine(probe), capitalize(next));
}

function healthLine(probe: HealthProbe | null): string {
    if (probe === null) return "not checked.";
    switch (probe.kind) {
        case "ok":
            return (
                `ok (${probe.ms}ms${probe.version ? `, v${probe.version}` : ""}` +
                `${probe.writesUnavailable ? ", writes unavailable" : ""}).`
            );
        case "http":
            return `HTTP ${probe.status} (${probe.ms}ms) — up, but not healthy.`;
        case "unreachable":
            return `unreachable (${probe.code}).`;
        case "timeout":
            return `no answer within ${(probe.ms / 1000).toFixed(1)}s.`;
    }
}

function lines(headline: string, cause: string, health: string, next: string): string {
    return [
        headline,
        `Cause: ${capitalize(cause)}`,
        `Relayer health: ${health}`,
        `Next step: ${next}`,
    ].join("\n");
}

function capitalize(text: string): string {
    return text.charAt(0).toUpperCase() + text.slice(1);
}

function parseObject(raw: unknown): Record<string, unknown> | null {
    if (typeof raw !== "string") return null;
    try {
        const parsed = JSON.parse(raw);
        return parsed && typeof parsed === "object" ? parsed : null;
    } catch {
        return null;
    }
}

/** The host a failed connect was for, when Node says (`getaddrinfo` names
 * the hostname, a refused connect the address). */
function hostOf(cause: unknown): string | null {
    const c = cause as { hostname?: unknown; address?: unknown } | null;
    if (typeof c?.hostname === "string") return c.hostname;
    if (typeof c?.address === "string") return c.address;
    return null;
}

function codeOf(cause: unknown): string {
    const code = (cause as { code?: unknown } | null)?.code;
    return typeof code === "string" ? code : "unknown";
}
