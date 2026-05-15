/// <reference path="./k6.d.ts" />

import http from "k6/http";
import exec from "k6/execution";
import { check, fail, sleep } from "k6";
import { Counter, Rate, Trend } from "k6/metrics";
import * as ed from "@noble/ed25519";
import { sha256, sha512 } from "@noble/hashes/sha2.js";
import { bech32 } from "bech32";

declare const __ENV: Record<string, string | undefined>;

ed.etc.sha512Sync = (...messages: Uint8Array[]) => sha512(ed.etc.concatBytes(...messages));

type Json = Record<string, unknown>;
type Profile = "smoke" | "load" | "stress" | "spike" | "health";

const serverUrl = trimTrailingSlash(
    env("MEMWAL_SERVER_URL", "SERVER_URL", "BENCH_SERVER_URL") ?? "http://localhost:8000",
);
const accountId = env("MEMWAL_ACCOUNT_ID", "BENCH_ACCOUNT_ID") ?? "";
const delegateKeyRaw = env("MEMWAL_DELEGATE_KEY", "BENCH_DELEGATE_KEY") ?? "";
const namespace = __ENV.MEMWAL_NAMESPACE ?? __ENV.NAMESPACE ?? "k6";
const query = __ENV.MEMWAL_QUERY ?? __ENV.QUERY ?? "benchmark memory";
const rememberText = __ENV.MEMWAL_REMEMBER_TEXT ?? __ENV.REMEMBER_TEXT ?? "benchmark memory";
const limit = intEnv("MEMWAL_LIMIT", 5);
const requestTimeout = __ENV.MEMWAL_REQUEST_TIMEOUT ?? "60s";
const rememberPollTimeoutMs = intEnv("MEMWAL_REMEMBER_POLL_TIMEOUT_MS", 180_000);
const rememberPollIntervalMs = intEnv("MEMWAL_REMEMBER_POLL_INTERVAL_MS", 1_000);
const healthSampleRate = numberEnv("MEMWAL_HEALTH_SAMPLE_RATE", 0.05);
const recallWeight = numberEnv("MEMWAL_RECALL_WEIGHT", 0.75);
const rememberWeight = numberEnv("MEMWAL_REMEMBER_WEIGHT", 0.25);
const askWeight = numberEnv("MEMWAL_ASK_WEIGHT", 0);
const restoreWeight = numberEnv("MEMWAL_RESTORE_WEIGHT", 0);
const profile = (env("K6_PROFILE", "MEMWAL_K6_PROFILE") ?? "smoke") as Profile;

let secretKey: Uint8Array | null = null;
let publicKeyHex = "";
if (profile !== "health") {
    if (!accountId) fail("MEMWAL_ACCOUNT_ID or BENCH_ACCOUNT_ID is required");
    if (!delegateKeyRaw) fail("MEMWAL_DELEGATE_KEY or BENCH_DELEGATE_KEY is required");
    secretKey = decodeDelegateKey(delegateKeyRaw);
    publicKeyHex = bytesToHex(ed.getPublicKey(secretKey));
}

export const options = buildOptions(profile);

const httpErrors = new Counter("memwal_http_errors");
const requestTimeouts = new Rate("memwal_timeout_rate");
const rememberEnqueueDuration = new Trend("memwal_remember_enqueue_duration", true);
const rememberWorkerDuration = new Trend("memwal_remember_worker_duration", true);
const recallDuration = new Trend("memwal_recall_duration", true);
const askDuration = new Trend("memwal_ask_duration", true);
const restoreDuration = new Trend("memwal_restore_duration", true);
const jobFailures = new Rate("memwal_remember_job_failed_rate");

export function setup() {
    const health = http.get(`${serverUrl}/health`, {
        tags: { endpoint: "health", flow: "setup" },
        timeout: "10s",
    });
    check(health, { "setup health is 200": (r) => r.status === 200 });
    if (health.status !== 200) {
        fail(`GET /health returned ${health.status}`);
    }
    return { baseUrl: serverUrl, namespace };
}

export function healthOnly() {
    const res = http.get(`${serverUrl}/health`, {
        tags: { endpoint: "health", flow: "health" },
        timeout: "10s",
    });
    recordHttpResult(res.status, "health");
    check(res, { "health is 200": (r) => r.status === 200 });
}

export function smoke() {
    healthOnly();
    const job = remember();
    if (job) {
        pollRememberJob(job.jobId, job.startedAt);
    }
    recall();
}

export function mixedFlow() {
    sampleHealth("mixed");
    const total = recallWeight + rememberWeight + askWeight + restoreWeight;
    if (total <= 0) {
        recall();
        return;
    }

    const r = Math.random() * total;
    if (r < recallWeight) {
        recall();
    } else if (r < recallWeight + rememberWeight) {
        const job = remember();
        if (job && shouldPollRemember()) {
            pollRememberJob(job.jobId, job.startedAt);
        }
    } else if (r < recallWeight + rememberWeight + askWeight) {
        ask();
    } else {
        restore();
    }
}

export function recallOnly() {
    sampleHealth("recall");
    recall();
}

export function rememberOnly() {
    sampleHealth("remember");
    const job = remember();
    if (job && shouldPollRemember()) {
        pollRememberJob(job.jobId, job.startedAt);
    }
}

export function askOnly() {
    sampleHealth("ask");
    ask();
}

export function restoreOnly() {
    sampleHealth("restore");
    restore();
}

function remember(): { jobId: string; startedAt: number } | null {
    const startedAt = Date.now();
    const body = {
        text: `${rememberText} vu=${exec.vu.idInTest} iter=${exec.scenario.iterationInTest} ts=${startedAt}`,
        namespace,
    };
    const res = signedRequest("POST", "/api/remember", body, "remember_enqueue");
    rememberEnqueueDuration.add(res.durationMs);

    const ok = check(res, {
        "remember accepted": (r) => r.status === 202,
        "remember returned job_id": (r) => typeof r.json?.job_id === "string",
    });
    if (!ok) return null;

    return { jobId: res.json!.job_id as string, startedAt };
}

function pollRememberJob(jobId: string, startedAt: number): boolean {
    const path = `/api/remember/${jobId}`;
    while (Date.now() - startedAt < rememberPollTimeoutMs) {
        const res = signedRequest("GET", path, undefined, "remember_status");
        if (res.status !== 200) {
            sleep(rememberPollIntervalMs / 1000);
            continue;
        }

        const status = res.json?.status;
        if (status === "done") {
            rememberWorkerDuration.add(Date.now() - startedAt);
            jobFailures.add(false);
            return true;
        }
        if (status === "failed") {
            rememberWorkerDuration.add(Date.now() - startedAt);
            jobFailures.add(true);
            return false;
        }
        sleep(rememberPollIntervalMs / 1000);
    }

    requestTimeouts.add(true, { endpoint: "remember_worker" });
    jobFailures.add(true);
    return false;
}

function recall() {
    const res = signedRequest("POST", "/api/recall", { query, namespace, limit }, "recall");
    recallDuration.add(res.durationMs);
    check(res, {
        "recall is 200": (r) => r.status === 200,
        "recall has results array": (r) => Array.isArray(r.json?.results),
    });
}

function ask() {
    const res = signedRequest(
        "POST",
        "/api/ask",
        { question: query, namespace, limit },
        "ask",
    );
    askDuration.add(res.durationMs);
    check(res, {
        "ask is 200": (r) => r.status === 200,
        "ask has answer": (r) => typeof r.json?.answer === "string",
    });
}

function restore() {
    const res = signedRequest("POST", "/api/restore", { namespace, limit }, "restore");
    restoreDuration.add(res.durationMs);
    check(res, {
        "restore is 200": (r) => r.status === 200,
        "restore reports totals": (r) => typeof r.json?.total === "number",
    });
}

function signedRequest(
    method: "GET" | "POST",
    path: string,
    body: Json | undefined,
    endpoint: string,
): { status: number; durationMs: number; json?: Json } {
    if (!secretKey) fail("signedRequest called without a delegate key");

    const bodyStr = method === "GET" ? "" : JSON.stringify(body ?? {});
    const timestamp = Math.floor(Date.now() / 1000).toString();
    const nonce = randomUuid();
    const bodyHash = bytesToHex(sha256(utf8(bodyStr)));
    const message = `${timestamp}.${method}.${path}.${bodyHash}.${nonce}.${accountId}`;
    const signature = ed.sign(utf8(message), secretKey);

    try {
        const res = http.request(method, `${serverUrl}${path}`, method === "GET" ? null : bodyStr, {
            headers: {
                "Content-Type": "application/json",
                "x-public-key": publicKeyHex,
                "x-signature": bytesToHex(signature),
                "x-timestamp": timestamp,
                "x-nonce": nonce,
                "x-account-id": accountId,
                "x-delegate-key": normalizeDelegateKeyForHeader(delegateKeyRaw),
            },
            tags: { endpoint },
            timeout: requestTimeout,
        });

        recordHttpResult(res.status, endpoint);
        return {
            status: res.status,
            durationMs: res.timings.duration,
            json: parseJson(res.body),
        };
    } catch (err) {
        httpErrors.add(1, { endpoint });
        requestTimeouts.add(String(err).toLowerCase().includes("timeout"), { endpoint });
        return { status: 0, durationMs: 0 };
    }
}

function sampleHealth(flow: string) {
    if (healthSampleRate <= 0 || Math.random() > healthSampleRate) return;
    const res = http.get(`${serverUrl}/health`, {
        tags: { endpoint: "health", flow },
        timeout: "10s",
    });
    recordHttpResult(res.status, "health");
}

function shouldPollRemember(): boolean {
    const raw = __ENV.MEMWAL_POLL_REMEMBER ?? "true";
    return raw !== "0" && raw.toLowerCase() !== "false";
}

function recordHttpResult(status: number, endpoint: string) {
    if (status === 0 || status >= 400) {
        httpErrors.add(1, { endpoint });
    }
    requestTimeouts.add(status === 0, { endpoint });
}

function parseJson(body: unknown): Json | undefined {
    if (typeof body !== "string" || body.length === 0) return undefined;
    try {
        return JSON.parse(body) as Json;
    } catch {
        return undefined;
    }
}

function buildOptions(selectedProfile: Profile) {
    const thresholds = {
        http_req_failed: ["rate<0.05"],
        "http_req_duration{endpoint:health}": ["p(95)<500", "p(99)<1000"],
        memwal_timeout_rate: ["rate<0.02"],
        memwal_remember_job_failed_rate: ["rate<0.05"],
        memwal_recall_duration: ["p(95)<5000", "p(99)<10000"],
        memwal_remember_enqueue_duration: ["p(95)<2000", "p(99)<5000"],
    };

    if (selectedProfile === "health") {
        return {
            scenarios: {
                health: {
                    executor: "constant-arrival-rate",
                    rate: intEnv("K6_HEALTH_RATE", 10),
                    timeUnit: "1s",
                    duration: __ENV.K6_DURATION ?? "2m",
                    preAllocatedVUs: intEnv("K6_PRE_ALLOCATED_VUS", 20),
                    exec: "healthOnly",
                },
            },
            thresholds,
        };
    }

    if (selectedProfile === "load") {
        return {
            scenarios: {
                load: {
                    executor: "constant-arrival-rate",
                    rate: intEnv("K6_RATE", 1),
                    timeUnit: "1s",
                    duration: __ENV.K6_DURATION ?? "5m",
                    preAllocatedVUs: intEnv("K6_PRE_ALLOCATED_VUS", 20),
                    maxVUs: intEnv("K6_MAX_VUS", 100),
                    exec: __ENV.K6_EXEC ?? "mixedFlow",
                },
            },
            thresholds,
        };
    }

    if (selectedProfile === "stress") {
        return {
            scenarios: {
                stress: {
                    executor: "ramping-arrival-rate",
                    startRate: 1,
                    timeUnit: "1s",
                    preAllocatedVUs: intEnv("K6_PRE_ALLOCATED_VUS", 30),
                    maxVUs: intEnv("K6_MAX_VUS", 200),
                    exec: __ENV.K6_EXEC ?? "mixedFlow",
                    stages: [
                        { target: intEnv("K6_STRESS_STAGE_1_RATE", 2), duration: __ENV.K6_STRESS_STAGE_1_DURATION ?? "2m" },
                        { target: intEnv("K6_STRESS_STAGE_2_RATE", 5), duration: __ENV.K6_STRESS_STAGE_2_DURATION ?? "5m" },
                        { target: intEnv("K6_STRESS_STAGE_3_RATE", 10), duration: __ENV.K6_STRESS_STAGE_3_DURATION ?? "5m" },
                        { target: 0, duration: __ENV.K6_STRESS_COOLDOWN ?? "1m" },
                    ],
                },
            },
            thresholds,
        };
    }

    if (selectedProfile === "spike") {
        return {
            scenarios: {
                spike: {
                    executor: "ramping-arrival-rate",
                    startRate: intEnv("K6_SPIKE_BASE_RATE", 1),
                    timeUnit: "1s",
                    preAllocatedVUs: intEnv("K6_PRE_ALLOCATED_VUS", 50),
                    maxVUs: intEnv("K6_MAX_VUS", 300),
                    exec: __ENV.K6_EXEC ?? "mixedFlow",
                    stages: [
                        { target: intEnv("K6_SPIKE_BASE_RATE", 1), duration: "30s" },
                        { target: intEnv("K6_SPIKE_RATE", 30), duration: "15s" },
                        { target: intEnv("K6_SPIKE_RATE", 30), duration: "45s" },
                        { target: intEnv("K6_SPIKE_BASE_RATE", 1), duration: "1m" },
                    ],
                },
            },
            thresholds,
        };
    }

    return {
        scenarios: {
            smoke: {
                executor: "shared-iterations",
                vus: 1,
                iterations: 1,
                maxDuration: "5m",
                exec: "smoke",
            },
        },
        thresholds,
    };
}

function decodeDelegateKey(key: string): Uint8Array {
    if (key.startsWith("suiprivkey")) {
        const decoded = bech32.decode(key, 1_000);
        if (decoded.prefix !== "suiprivkey") {
            throw new Error(`unexpected Sui private key prefix: ${decoded.prefix}`);
        }
        const bytes = Uint8Array.from(bech32.fromWords(decoded.words));
        if (bytes[0] !== 0) {
            throw new Error("k6 relayer tests require an Ed25519 Sui delegate key");
        }
        if (bytes.length !== 33) {
            throw new Error(`expected 33 Sui private key bytes, got ${bytes.length}`);
        }
        return bytes.slice(1);
    }

    const hex = stripHexPrefix(key);
    if (!/^[0-9a-fA-F]{64}$/.test(hex)) {
        throw new Error("delegate key must be 64-char hex, 0x-prefixed hex, or suiprivkey");
    }
    return hexToBytes(hex);
}

function normalizeDelegateKeyForHeader(key: string): string {
    return key.startsWith("0x") && key.length === 66 ? key.slice(2) : key;
}

function randomUuid(): string {
    const hex = `${randomHex(8)}${randomHex(8)}${randomHex(8)}${randomHex(8)}`.split("");
    hex[12] = "4";
    hex[16] = ((parseInt(hex[16], 16) & 0x3) | 0x8).toString(16);
    return `${hex.slice(0, 8).join("")}-${hex.slice(8, 12).join("")}-${hex
        .slice(12, 16)
        .join("")}-${hex.slice(16, 20).join("")}-${hex.slice(20, 32).join("")}`;
}

function randomHex(chars: number): string {
    let out = "";
    while (out.length < chars) {
        out += Math.floor(Math.random() * 0xffffffff)
            .toString(16)
            .padStart(8, "0");
    }
    return out.slice(0, chars);
}

function utf8(input: string): Uint8Array {
    return new TextEncoder().encode(input);
}

function bytesToHex(bytes: Uint8Array): string {
    let out = "";
    for (const b of bytes) {
        out += b.toString(16).padStart(2, "0");
    }
    return out;
}

function hexToBytes(hex: string): Uint8Array {
    const bytes = new Uint8Array(hex.length / 2);
    for (let i = 0; i < bytes.length; i += 1) {
        bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
    }
    return bytes;
}

function stripHexPrefix(value: string): string {
    return value.startsWith("0x") ? value.slice(2) : value;
}

function trimTrailingSlash(value: string): string {
    return value.replace(/\/+$/, "");
}

function env(...names: string[]): string | undefined {
    for (const name of names) {
        const value = __ENV[name];
        if (value !== undefined && value !== "") return value;
    }
    return undefined;
}

function intEnv(name: string, fallback: number): number {
    const value = __ENV[name];
    if (!value) return fallback;
    const parsed = Number.parseInt(value, 10);
    return Number.isFinite(parsed) ? parsed : fallback;
}

function numberEnv(name: string, fallback: number): number {
    const value = __ENV[name];
    if (!value) return fallback;
    const parsed = Number.parseFloat(value);
    return Number.isFinite(parsed) ? parsed : fallback;
}
