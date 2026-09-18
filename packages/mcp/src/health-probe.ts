/**
 * Ask the relayer's public `/health` why a call went unanswered (WALM-396).
 *
 * A sent call whose reply never arrives says nothing on its own about why:
 * the relayer may be down, unreachable from this machine, configured wrong,
 * or up with this one call stuck inside it. Each wants a different response —
 * wait, check the network, fix `--relayer`, or just retry — so the bridge
 * probes before it answers.
 */

export type HealthProbe =
    | { kind: "ok"; ms: number; version?: string }
    | { kind: "http"; ms: number; status: number }
    | { kind: "unreachable"; ms: number; code: string }
    | { kind: "timeout"; ms: number };

const DEFAULT_HEALTH_PROBE_MS = 3_000;
const MIN_HEALTH_PROBE_MS = 100;

/** Override via `MEMWAL_MCP_HEALTH_PROBE_MS`, mostly for tests. */
export function resolveHealthProbeMs(): number {
    const raw = process.env.MEMWAL_MCP_HEALTH_PROBE_MS;
    if (!raw) return DEFAULT_HEALTH_PROBE_MS;
    const n = Number(raw);
    if (!Number.isFinite(n) || n < MIN_HEALTH_PROBE_MS) return DEFAULT_HEALTH_PROBE_MS;
    return n;
}

/** `GET {baseUrl}/health`, bounded by `timeoutMs`. Never rejects: a probe
 * that fails is itself the answer. */
export async function probeRelayerHealth(
    baseUrl: string,
    timeoutMs: number,
): Promise<HealthProbe> {
    const started = Date.now();
    const signal = AbortSignal.timeout(timeoutMs);
    try {
        const res = await fetch(`${baseUrl.replace(/\/+$/, "")}/health`, { signal });
        const ms = Date.now() - started;
        if (!res.ok) {
            await res.body?.cancel();
            return { kind: "http", ms, status: res.status };
        }
        const body = (await res.json().catch(() => null)) as { version?: unknown } | null;
        const version = typeof body?.version === "string" ? body.version : undefined;
        return { kind: "ok", ms, version };
    } catch (err) {
        const ms = Date.now() - started;
        if (signal.aborted) return { kind: "timeout", ms };
        const code = (err as { cause?: { code?: unknown } } | null)?.cause?.code;
        return { kind: "unreachable", ms, code: typeof code === "string" ? code : "unknown" };
    }
}

/** DNS could not find the host: the one cause a user fixes on their side. */
const UNRESOLVED_CODES = new Set(["ENOTFOUND", "EAI_AGAIN"]);

/** `health` is the value for a `Relayer health:` line; `verdict` says what
 * it means for the call; `reachable` is whether a plain retry can help. */
export function describeHealthProbe(
    probe: HealthProbe,
    relayerUrl: string,
): { health: string; verdict: string; reachable: boolean } {
    switch (probe.kind) {
        case "ok":
            return {
                health: `ok (${probe.ms}ms${probe.version ? `, v${probe.version}` : ""})`,
                verdict:
                    "The relayer is up, so this call stalled inside it or its reply was lost on the way back.",
                reachable: true,
            };
        case "http":
            return {
                health: `HTTP ${probe.status} (${probe.ms}ms)`,
                verdict: "The relayer answered but is not healthy.",
                reachable: false,
            };
        case "timeout":
            return {
                health: `no answer within ${(probe.ms / 1000).toFixed(1)}s`,
                verdict: `The relayer at ${relayerUrl} is down, overloaded, or not reachable from this machine.`,
                reachable: false,
            };
        case "unreachable":
            return {
                health: `unreachable (${probe.code})`,
                verdict: UNRESOLVED_CODES.has(probe.code)
                    ? `The relayer host in ${relayerUrl} could not be resolved. Check the relayer URL ` +
                      "(MEMWAL_SERVER_URL or --relayer) and this machine's network."
                    : `The relayer at ${relayerUrl} is down or not reachable from this machine.`,
                reachable: false,
            };
    }
}
