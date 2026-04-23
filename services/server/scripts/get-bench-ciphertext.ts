#!/usr/bin/env npx tsx
/**
 * get-bench-ciphertext.ts
 * Fetch a blob_id, download its ciphertext from the Walrus aggregator,
 * and print base64 output for use with bench-sidecar-concurrency.ts
 */

const WALRUS_AGGREGATOR = process.env.WALRUS_AGGREGATOR_URL ?? "https://aggregator.walrus-mainnet.walrus.space";

// Simple pg query via spawning psql-like or using a tiny fetch to sidecar
// Actually let's just use the walrus endpoint on sidecar to get blob IDs
const SIDECAR_TOKEN = process.env.SIDECAR_AUTH_TOKEN ?? "";
const OWNER = process.argv[2] ?? "";

async function main() {
    if (!SIDECAR_TOKEN) {
        console.error("Set SIDECAR_AUTH_TOKEN env var");
        process.exit(1);
    }
    if (!OWNER) {
        console.error("Usage: npx tsx get-bench-ciphertext.ts <owner_address>");
        process.exit(1);
    }

    const SIDECAR_URL = process.env.SIDECAR_URL ?? "http://localhost:9000";
    const PACKAGE_ID = process.env.MEMWAL_PACKAGE_ID ?? "";

    console.log(`Querying blobs for owner=${OWNER.slice(0,10)}...`);
    const resp = await fetch(`${SIDECAR_URL}/walrus/query-blobs`, {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            "Authorization": `Bearer ${SIDECAR_TOKEN}`,
        },
        body: JSON.stringify({ owner: OWNER, namespace: "default", packageId: PACKAGE_ID }),
    });

    if (!resp.ok) {
        const t = await resp.text();
        console.error("query-blobs failed:", t);
        process.exit(1);
    }

    const data = await resp.json() as { blobs: {blobId: string}[]; total: number };
    console.log(`Found ${data.total} blobs`);

    if (data.blobs.length === 0) {
        console.error("No blobs found. Make sure you have remembered at least one memory.");
        process.exit(1);
    }

    const blobId = data.blobs[0].blobId;
    console.log(`Using blob_id: ${blobId}`);
    console.log(`Downloading from Walrus aggregator...`);

    const dlResp = await fetch(`${WALRUS_AGGREGATOR}/v1/blobs/${blobId}`);
    if (!dlResp.ok) {
        console.error(`Download failed: HTTP ${dlResp.status}`);
        process.exit(1);
    }

    const bytes = await dlResp.arrayBuffer();
    const b64 = Buffer.from(bytes).toString("base64");
    console.log(`\nCiphertext (${bytes.byteLength} bytes) in base64:\n`);
    console.log(b64);
    console.log(`\n\nExport for bench:`);
    console.log(`export BENCH_CIPHERTEXT='${b64}'`);
    console.log(`export BENCH_BLOB_ID='${blobId}'`);
}

main().catch(e => { console.error(e); process.exit(1); });
