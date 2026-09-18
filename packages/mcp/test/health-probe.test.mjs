/**
 * `probeRelayerHealth` / `describeHealthProbe` (WALM-396).
 *
 * When a sent call's reply never arrives, the bridge asks the relayer's
 * `/health` before answering, so the message can say whether the relayer is
 * down, unhealthy, unreachable from this machine, or up with this one call
 * stuck — the difference between "retry", "wait", and "fix your config".
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import {
    describeHealthProbe,
    probeRelayerHealth,
    resolveHealthProbeMs,
} from "../dist/health-probe.js";

async function fakeRelayer(respond) {
    const server = http.createServer((req, res) => {
        if (req.url === "/health") respond(res);
        else res.writeHead(404).end();
    });
    await new Promise((r) => server.listen(0, "127.0.0.1", r));
    const { port } = server.address();
    return {
        url: `http://127.0.0.1:${port}`,
        close: () =>
            new Promise((r) => {
                server.closeAllConnections();
                server.close(() => r());
            }),
    };
}

async function closedPortUrl() {
    const relayer = await fakeRelayer(() => {});
    await relayer.close();
    return relayer.url;
}

const healthy = (res) =>
    res
        .writeHead(200, { "content-type": "application/json" })
        .end(JSON.stringify({ status: "ok", version: "1.4.2" }));

test("a healthy relayer is reported with its version", async (t) => {
    const relayer = await fakeRelayer(healthy);
    t.after(relayer.close);
    const probe = await probeRelayerHealth(`${relayer.url}/`, 2000);
    assert.equal(probe.kind, "ok");
    assert.equal(probe.version, "1.4.2");
    const { health, reachable } = describeHealthProbe(probe, relayer.url);
    assert.equal(reachable, true);
    assert.match(health, /^ok \(\d+ms, v1\.4\.2\)$/);
});

test("an unhealthy relayer is reported by status", async (t) => {
    const relayer = await fakeRelayer((res) => res.writeHead(503).end());
    t.after(relayer.close);
    const probe = await probeRelayerHealth(relayer.url, 2000);
    assert.equal(probe.kind, "http");
    assert.equal(probe.status, 503);
    const { health, verdict, reachable } = describeHealthProbe(probe, relayer.url);
    assert.equal(reachable, false);
    assert.match(health, /HTTP 503/);
    assert.match(verdict, /not healthy/);
});

test("a relayer that never answers is a timeout, reported on time", async (t) => {
    const relayer = await fakeRelayer(() => {});
    t.after(relayer.close);
    const started = Date.now();
    const probe = await probeRelayerHealth(relayer.url, 200);
    assert.equal(probe.kind, "timeout");
    assert.ok(Date.now() - started < 2000, "the probe must not outlive its budget");
    assert.match(describeHealthProbe(probe, relayer.url).verdict, /down|overloaded|not reachable/);
});

test("a refused connection is unreachable, and says the relayer may be down", async () => {
    const url = await closedPortUrl();
    const probe = await probeRelayerHealth(url, 2000);
    assert.equal(probe.kind, "unreachable");
    assert.equal(probe.code, "ECONNREFUSED");
    const { health, verdict } = describeHealthProbe(probe, url);
    assert.match(health, /unreachable \(ECONNREFUSED\)/);
    assert.match(verdict, /down or not reachable/);
    assert.ok(verdict.includes(url), "the verdict names the address it tried");
});

test("an unresolvable host points at the configured relayer URL", () => {
    // A typo'd --relayer is the one cause the user can fix on their side.
    const { verdict } = describeHealthProbe(
        { kind: "unreachable", ms: 5, code: "ENOTFOUND" },
        "https://relayer.memroy.walrus.xyz",
    );
    assert.match(verdict, /MEMWAL_SERVER_URL/);
    assert.match(verdict, /--relayer/);
});

test("the probe budget has a default and an override", () => {
    const saved = process.env.MEMWAL_MCP_HEALTH_PROBE_MS;
    try {
        delete process.env.MEMWAL_MCP_HEALTH_PROBE_MS;
        assert.equal(resolveHealthProbeMs(), 3000);
        process.env.MEMWAL_MCP_HEALTH_PROBE_MS = "750";
        assert.equal(resolveHealthProbeMs(), 750);
        process.env.MEMWAL_MCP_HEALTH_PROBE_MS = "nonsense";
        assert.equal(resolveHealthProbeMs(), 3000);
    } finally {
        if (saved === undefined) delete process.env.MEMWAL_MCP_HEALTH_PROBE_MS;
        else process.env.MEMWAL_MCP_HEALTH_PROBE_MS = saved;
    }
});
