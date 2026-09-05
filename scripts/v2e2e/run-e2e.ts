/**
 * Live testnet + local Oyster/relayer E2E for the V2 vertical slice.
 * Loads scripts/v2e2e/.env.local (gitignored). Does not print secrets.
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { SuiGrpcClient } from "@mysten/sui/grpc";
import { MemWal } from "../../packages/sdk/src/memwal.ts";
import {
    createNamespace,
    generateAndWrapNamespaceDek,
    grantAccess,
    initializeKey,
} from "../../packages/sdk/src/namespace.ts";
import { addDelegateKey, generateDelegateKey } from "../../packages/sdk/src/account.ts";

const ROOT = resolve(import.meta.dirname, "../..");
const ENV_PATH = resolve(ROOT, "scripts/v2e2e/.env.local");
const ARTIFACT = resolve(ROOT, "scripts/v2e2e/.secrets/e2e-run.json");

function loadEnv(path: string): Record<string, string> {
    const out: Record<string, string> = {};
    for (const line of readFileSync(path, "utf8").split("\n")) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith("#")) continue;
        const eq = trimmed.indexOf("=");
        if (eq < 1) continue;
        const key = trimmed.slice(0, eq).trim();
        let value = trimmed.slice(eq + 1).trim();
        if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
            value = value.slice(1, -1);
        }
        out[key] = value;
    }
    return out;
}

function req(env: Record<string, string>, key: string): string {
    const v = env[key];
    if (!v) throw new Error(`missing ${key} in ${ENV_PATH}`);
    return v;
}

function pass(name: string, extra = "") {
    console.log(`PASS  ${name}${extra ? `  ${extra}` : ""}`);
}

function fail(name: string, err: unknown): never {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`FAIL  ${name}: ${msg}`);
    throw err instanceof Error ? err : new Error(msg);
}

async function withRetry<T>(name: string, fn: () => Promise<T>, attempts = 4): Promise<T> {
    let last: unknown;
    for (let i = 1; i <= attempts; i++) {
        try {
            return await fn();
        } catch (e) {
            last = e;
            const msg = e instanceof Error ? e.message : String(e);
            console.warn(`retry ${name} ${i}/${attempts}: ${msg.slice(0, 180)}`);
            await new Promise((r) => setTimeout(r, 1500 * i));
        }
    }
    fail(name, last);
}

async function waitFor(url: string, label: string, timeoutMs = 120_000) {
    const start = Date.now();
    let last = "";
    while (Date.now() - start < timeoutMs) {
        try {
            const res = await fetch(url);
            if (res.ok) {
                pass(`health ${label}`, `${res.status} ${url}`);
                return;
            }
            last = `${res.status}`;
        } catch (e) {
            last = e instanceof Error ? e.message : String(e);
        }
        await new Promise((r) => setTimeout(r, 1500));
    }
    fail(`health ${label}`, new Error(`timeout waiting for ${url}: ${last}`));
}

async function main() {
    const resumeOnly = process.argv.includes("--resume");
    const recallOnly = process.argv.includes("--recall-only");
    const env = loadEnv(ENV_PATH);
    const packageId = req(env, "MEMWAL_V2_PACKAGE_ID");
    const accountRegistryId = req(env, "MEMWAL_V2_REGISTRY_ID");
    const namespaceRegistryId = req(env, "MEMWAL_V2_NAMESPACE_REGISTRY_ID");
    const accountId = req(env, "MEMWAL_ACCOUNT_ID");
    const suiPrivateKey = req(env, "SERVER_SUI_PRIVATE_KEY");
    const writer = req(env, "MEMWAL_V2_WRITER_ADDRESSES").split(",")[0]!;
    const oysterBase = req(env, "OYSTER_BASE_URL");
    const oysterKey = req(env, "OYSTER_API_KEY");
    const oysterBucket = env.OYSTER_BUCKET || "v2e2e-ns";
    const relayer = env.SIDECAR_URL ? "http://127.0.0.1:8000" : "http://127.0.0.1:8000";
    const sealConfigs = JSON.parse(req(env, "SEAL_SERVER_CONFIGS")) as Array<{
        objectId: string;
        weight?: number;
        aggregatorUrl?: string;
    }>;
    const threshold = Number(env.SEAL_THRESHOLD || "1");
    const ducnmm = "0x3103b5ddad293bb00cf9b54061684293a829f2a65a7c560925e954f6e14a781f";
    const label = `e2e-live-${Date.now()}`;
    const memoryText = `v2 e2e peanut allergy ${label}`;

    const suiClient = new SuiGrpcClient({
        network: "testnet",
        baseUrl: env.SUI_GRPC_URL || "https://fullnode.testnet.sui.io:443",
    });

    // 1. Oyster API is up (list buckets). Do not GET the old Walrus-backed
    // spike blob — that path downloads a 66MB encoded unit and hangs.
    {
        const res = await fetch(`${oysterBase}/buckets`, {
            headers: { Authorization: `Bearer ${oysterKey}` },
        });
        const body = await res.text();
        if (!res.ok) fail("oyster list buckets", new Error(`${res.status} ${body.slice(0, 200)}`));
        if (!body.includes(oysterBucket) && !body.includes("bucket")) {
            pass("oyster list buckets", `status=${res.status} body=${body.slice(0, 120)}`);
        } else {
            pass("oyster list buckets", `status=${res.status}`);
        }
        void oysterBucket;
    }

    await waitFor("http://127.0.0.1:8000/health", "relayer");
    const version = await (await fetch("http://127.0.0.1:8000/version")).json() as {
        featureFlags?: Record<string, boolean>;
    };
    if (!version.featureFlags?.["runtime.v2WriteFence"]) {
        fail("relayer v2 flags", new Error(`flags=${JSON.stringify(version.featureFlags)}`));
    }
    pass("relayer v2 flags", JSON.stringify(version.featureFlags));

    if (recallOnly || resumeOnly) {
        const saved = JSON.parse(readFileSync(ARTIFACT, "utf8")) as {
            label: string;
            namespaceId: string;
            accountId: string;
            delegatePrivateKeyHex: string;
            memoryText: string;
        };
        const memwal = MemWal.create({
            key: saved.delegatePrivateKeyHex,
            accountId: saved.accountId,
            serverUrl: relayer,
            namespace: saved.label,
        });
        if (!recallOnly) {
            const accepted = await memwal.remember(saved.memoryText);
            pass("remember accepted", accepted.job_id);
            const done = await memwal.waitForRememberJob(accepted.job_id, { timeoutMs: 600_000 });
            pass("remember done", `blob=${done.blob_id}`);
        }
        const recalled = await memwal.recall({ query: "peanut allergy", limit: 5 });
        const hit = recalled.results.find((r) => r.text.includes(saved.label));
        if (!hit) fail("recall", new Error(`no matching hit in ${JSON.stringify(recalled)}`));
        pass("recall decrypt", `text=${hit!.text.slice(0, 80)}`);
        console.log("ALL_E2E_PASS", JSON.stringify({ label: saved.label, namespaceId: saved.namespaceId }));
        return;
    }

    const txBase = {
        packageId,
        namespaceRegistryId,
        accountRegistryId,
        accountId,
        suiPrivateKey,
        suiClient,
        suiNetwork: "testnet" as const,
    };

    const delegate = await generateDelegateKey();
    pass("generateDelegateKey", `sui=${delegate.suiAddress.slice(0, 10)}…`);

    const added = await withRetry("addDelegateKey", () =>
        addDelegateKey({
            packageId,
            registryId: accountRegistryId,
            accountId,
            publicKey: delegate.publicKey,
            label: `e2e-agent-${label.slice(-6)}`,
            suiPrivateKey,
            suiClient,
            suiNetwork: "testnet",
        }),
    );
    pass("addDelegateKey", added.digest);

    const created = await withRetry("createNamespace", () =>
        createNamespace({ ...txBase, label }),
    );
    const namespaceId = created.namespaceId;
    pass("createNamespace", `${label} ${namespaceId} ${created.digest}`);

    const wrapped = await withRetry("generateAndWrapNamespaceDek", () =>
        generateAndWrapNamespaceDek({
            packageId,
            namespaceId,
            keyVersion: 0n,
            threshold,
            sealServerConfigs: sealConfigs,
            suiClient,
            suiNetwork: "testnet",
        }),
    );
    const wrappedDek = wrapped.wrappedDek;
    pass("generateAndWrapNamespaceDek", `wrapped=${wrappedDek.length}b`);

    const init = await withRetry("initializeKey", () =>
        initializeKey({ ...txBase, namespaceId, wrappedDek }),
    );
    pass("initializeKey", init.digest);

    const grantAgent = await withRetry("grantAccess HTTP agent WRITE", () =>
        grantAccess({
            ...txBase,
            namespaceId,
            principal: delegate.suiAddress,
            canRead: true,
            canWrite: true,
            canShare: false,
        }),
    );
    pass("grantAccess HTTP agent WRITE", grantAgent.digest);

    const grantB = await withRetry("grantAccess wallet B READ", () =>
        grantAccess({
            ...txBase,
            namespaceId,
            principal: ducnmm,
            canRead: true,
            canWrite: false,
            canShare: false,
        }),
    );
    pass("grantAccess wallet B READ", grantB.digest);

    mkdirSync(resolve(ROOT, "scripts/v2e2e/.secrets"), { recursive: true });
    writeFileSync(
        ARTIFACT,
        JSON.stringify(
            {
                label,
                namespaceId,
                accountId,
                delegateSuiAddress: delegate.suiAddress,
                delegatePrivateKeyHex: delegate.privateKey,
                memoryText,
            },
            null,
            2,
        ),
    );

    const memwal = MemWal.create({
        key: delegate.privateKey,
        accountId,
        serverUrl: relayer,
        namespace: label,
    });

    let jobId = "";
    try {
        const accepted = await memwal.remember(memoryText);
        jobId = accepted.job_id;
        pass("remember accepted", jobId);
        const done = await memwal.waitForRememberJob(accepted.job_id, { timeoutMs: 180_000 });
        pass("remember done", `blob=${done.blob_id}`);
    } catch (e) {
        fail("remember", e);
    }

    try {
        const recalled = await memwal.recall({ query: "peanut allergy", limit: 5 });
        const hit = recalled.results.find((r) => r.text.includes("peanut allergy") && r.text.includes(label));
        if (!hit) {
            fail("recall", new Error(`no matching hit in ${JSON.stringify(recalled)}`));
        }
        pass("recall decrypt", `text=${hit!.text.slice(0, 80)}`);
    } catch (e) {
        fail("recall", e);
    }

    console.log("ALL_E2E_PASS", JSON.stringify({ label, namespaceId, jobId }));
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
