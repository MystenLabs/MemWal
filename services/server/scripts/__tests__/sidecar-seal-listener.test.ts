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
while (Atomics.load(flag, 0) === 0) {}
const started = Date.now();
fetch(workerData.url).then(async (res) => {
    parentPort.postMessage({ ms: Date.now() - started, status: res.status });
}).catch((err) => {
    parentPort.postMessage({ error: String(err && err.message || err) });
});
`;

function probe(url: string, sab: SharedArrayBuffer): { result: Promise<{ ms: number; status: number }>; stop: () => Promise<void> } {
    const worker = new Worker(probeSource, { eval: true, workerData: { url, sab } });
    const result = new Promise<{ ms: number; status: number }>((resolve, reject) => {
        worker.once("message", (message: { ms?: number; status?: number; error?: string }) => {
            if (message.error) reject(new Error(message.error));
            else resolve({ ms: message.ms ?? -1, status: message.status ?? 0 });
        });
        worker.once("error", reject);
    });
    return {
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
        const blockedMs = 800;
        const until = Date.now() + blockedMs;
        let armed = false;
        while (Date.now() < until) {
            // Release the probes only after this thread is already spinning.
            if (!armed) {
                Atomics.store(flag, 0, 1);
                armed = true;
            }
        }

        const [sealResult, mainResult] = await Promise.all([sealProbe.result, mainProbe.result]);
        assert.equal(sealResult.status, 200);
        assert.equal(mainResult.status, 200);
        assert.ok(
            sealResult.ms < blockedMs / 2,
            `seal health took ${sealResult.ms}ms while the upload process was blocked for ${blockedMs}ms`
        );
        assert.ok(
            mainResult.ms >= blockedMs - 50,
            `upload process answered in ${mainResult.ms}ms; the event loop was not actually blocked`
        );
    } finally {
        main.close();
        await Promise.all([sealProbe.stop(), mainProbe.stop(), seal.stop()]);
    }
});
