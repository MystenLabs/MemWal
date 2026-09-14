import assert from "node:assert/strict";
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { MemWalManual } from "../dist/manual.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SRC = resolve(__dirname, "../src");
const DIST = resolve(__dirname, "../dist");

const WALRUS_IMPORT = /import\s*\(\s*["']@mysten\/walrus["']\s*\)/;

function filesWithExt(dir, ext) {
    const out = [];
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) out.push(...filesWithExt(full, ext));
        else if (entry.name.endsWith(ext)) out.push(full);
    }
    return out;
}

function manualConfig() {
    return {
        key: new Uint8Array(32).fill(1),
        walletSigner: {
            address: "0x4",
            signAndExecuteTransaction: async () => ({ digest: "unused" }),
            signPersonalMessage: async () => ({ signature: "unused" }),
        },
        embeddingApiKey: "test",
        packageId: "0x1",
        accountId: "0x2",
        registryId: "0x3",
        suiNetwork: "testnet",
    };
}

test("the SDK has no @mysten/walrus specifier", () => {
    assert.ok(existsSync(DIST), `dist/ missing — run build first (looked in ${DIST})`);

    const offenders = [];
    for (const file of [...filesWithExt(SRC, ".ts"), ...filesWithExt(DIST, ".js")]) {
        const src = readFileSync(file, "utf8");
        if (WALRUS_IMPORT.test(src) || src.includes('from "@mysten/walrus"')) {
            const root = file.startsWith(DIST) ? DIST : SRC;
            offenders.push(relative(root, file));
        }
    }

    assert.deepEqual(offenders, [], `SDK still imports @mysten/walrus:\n  ${offenders.join("\n  ")}`);
});

test("manual.ts dropped the dead Walrus WASM client", () => {
    const src = readFileSync(join(SRC, "manual.ts"), "utf8");
    assert.equal(src.includes("getWalrusClient"), false);
    assert.equal(src.includes("_walrusClient"), false);
    assert.equal(src.includes("walrusUpload"), false);
    assert.equal(src.includes("via @mysten/walrus"), false);
    assert.equal(src.includes("Walrus upload → register"), false);
    assert.match(src, /embed → SEAL encrypt → relayer upload/);
});

test("package.json does not advertise @mysten/walrus", () => {
    const pkg = JSON.parse(readFileSync(join(__dirname, "../package.json"), "utf8"));
    assert.equal(pkg.peerDependencies["@mysten/walrus"], undefined);
    assert.equal(pkg.peerDependenciesMeta?.["@mysten/walrus"], undefined);
});

test("MemWalManualConfig has no unused publisher or epochs knobs", () => {
    const src = readFileSync(join(SRC, "types.ts"), "utf8");
    assert.equal(src.includes("walrusEpochs"), false);
    assert.equal(src.includes("walrusPublisherUrl"), false);
    assert.equal(src.includes("walrusAggregatorUrl"), true);
});

test("walrusDownload fetches the aggregator over HTTP", async () => {
    const originalFetch = globalThis.fetch;
    const requested = [];
    globalThis.fetch = async (input) => {
        requested.push(String(input));
        return new Response(new Uint8Array([9, 8, 7]), { status: 200 });
    };
    try {
        const manual = MemWalManual.create(manualConfig());
        const bytes = await manual.walrusDownload("abc");
        assert.deepEqual([...bytes], [9, 8, 7]);
        assert.deepEqual(requested, [
            "https://aggregator.walrus-testnet.walrus.space/v1/blobs/abc",
        ]);
    } finally {
        globalThis.fetch = originalFetch;
    }
});

test("walrusDownload honors walrusAggregatorUrl", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (input) => {
        assert.equal(String(input), "https://agg.example/v1/blobs/blob-1");
        return new Response(new Uint8Array([1]), { status: 200 });
    };
    try {
        const manual = MemWalManual.create({
            ...manualConfig(),
            walrusAggregatorUrl: "https://agg.example",
        });
        await manual.walrusDownload("blob-1");
    } finally {
        globalThis.fetch = originalFetch;
    }
});
