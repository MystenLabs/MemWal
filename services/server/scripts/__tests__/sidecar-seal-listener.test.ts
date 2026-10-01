import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";
import { Worker } from "node:worker_threads";

process.env.SIDECAR_AUTH_TOKEN = process.env.SIDECAR_AUTH_TOKEN || "seal-listener-test-token";
process.env.SIDECAR_ROUTE_MODE = "full";
process.env.SIDECAR_SEAL_PORT = "0";
process.env.SIDECAR_SEAL_HOST = "127.0.0.1";
process.env.SUI_NETWORK = process.env.SUI_NETWORK || "testnet";

const { startSealListener } = await import("../sidecar/seal-listener.js");

const probeSource = `
const { parentPort, workerData } = require("node:worker_threads");
const flag = new Int32Array(workerData.sab);
parentPort.postMessage({ ready: true });
while (Atomics.load(flag, 0) === 0) {}
fetch(workerData.url).then(async (res) => {
    parentPort.postMessage({ answeredAt: Date.now(), status: res.status });
}).catch((err) => {
    parentPort.postMessage({ error: String(err && err.message || err) });
});
`;

type ProbeResult = { answeredAt: number; status: number };

// Absolute timestamps, not durations measured inside the worker: a worker that
// starts late on a slow runner must not shorten how long the block "looked".
function probe(url: string, sab: SharedArrayBuffer): {
    ready: Promise<void>;
    result: Promise<ProbeResult>;
    stop: () => Promise<void>;
} {
    const worker = new Worker(probeSource, { eval: true, workerData: { url, sab } });
    let markReady: () => void = () => {};
    const ready = new Promise<void>((resolve) => {
        markReady = resolve;
    });
    const result = new Promise<ProbeResult>((resolve, reject) => {
        worker.on("message", (message: { ready?: boolean; answeredAt?: number; status?: number; error?: string }) => {
            if (message.ready) return markReady();
            if (message.error) reject(new Error(message.error));
            else resolve({ answeredAt: message.answeredAt ?? 0, status: message.status ?? 0 });
        });
        worker.once("error", reject);
    });
    return {
        ready,
        result,
        stop: async () => {
            await worker.terminate();
        },
    };
}

test("seal listener answers while the upload process event loop is blocked", { timeout: 30_000 }, async () => {
    const seal = await startSealListener();
    assert.ok(seal.port);
    const main = http.createServer((_req, res) => {
        res.end("ok");
    });
    await new Promise<void>((resolve) => main.listen(0, "127.0.0.1", () => resolve()));
    const address = main.address();
    assert.ok(address && typeof address !== "string");

    const sab = new SharedArrayBuffer(4);
    const flag = new Int32Array(sab);
    const sealProbe = probe(`http://127.0.0.1:${seal.port}/health`, sab);
    const mainProbe = probe(`http://127.0.0.1:${address.port}/health`, sab);
    try {
        // Both probe threads are running and spinning on the flag before the
        // upload process blocks, so start-up time cannot eat into the window.
        await Promise.all([sealProbe.ready, mainProbe.ready]);
        const blockedMs = 800;
        const blockStart = Date.now();
        const blockEnd = blockStart + blockedMs;
        Atomics.store(flag, 0, 1);
        while (Date.now() < blockEnd) {}

        const [sealResult, mainResult] = await Promise.all([sealProbe.result, mainProbe.result]);
        assert.equal(sealResult.status, 200);
        assert.equal(mainResult.status, 200);
        assert.ok(
            sealResult.answeredAt < blockEnd,
            `seal health answered ${sealResult.answeredAt - blockEnd}ms after the ${blockedMs}ms block ended`
        );
        assert.ok(
            mainResult.answeredAt >= blockEnd,
            `upload process answered ${blockEnd - mainResult.answeredAt}ms before its blocked event loop was released`
        );
    } finally {
        main.close();
        await Promise.all([sealProbe.stop(), mainProbe.stop(), seal.stop()]);
    }
});
