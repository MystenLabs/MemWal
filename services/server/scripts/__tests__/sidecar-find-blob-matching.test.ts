import test from "node:test";
import assert from "node:assert/strict";

// P1: the actual matching logic of findBlobObjectByJob (GH #477 reconcile). We
// stub the module-level suiClient's listOwnedObjects + getDynamicField so we can
// drive real fixtures through the scan/tag-match without a chain. This is the
// funds-critical part: a wrong match (or a swallowed metadata error) → the
// relayer either re-mints or adopts the wrong user's blob.

const { Ed25519Keypair } = await import("@mysten/sui/keypairs/ed25519");
const serverKey = new Ed25519Keypair();
const serverAddr = serverKey.toSuiAddress();
process.env.SERVER_SUI_PRIVATE_KEYS = serverKey.getSecretKey();
process.env.SUI_NETWORK = "testnet";
process.env.SUI_GRPC_URL = "https://match.testnet.example";
process.env.WALRUS_PACKAGE_ID = `0x${"a".repeat(64)}`;

const { bcs } = await import("@mysten/sui/bcs");
const { normalizeSuiAddress } = await import("@mysten/sui/utils");
const { suiClient } = await import("../sidecar/clients.js");
const { findBlobObjectByJob } = await import("../sidecar/routes/walrus-query.js");

const METADATA_BCS = bcs.struct("Metadata", { metadata: bcs.map(bcs.string(), bcs.string()) });
const USER = normalizeSuiAddress(`0x${"1".repeat(64)}`);

// blob_id on chain is a U256 decimal; use a value the sidecar can convert.
function makeBlob(objectId: string, rawBlobId: string) {
    return { objectId, json: { blob_id: rawBlobId } };
}

// tags: Map of key→value → BCS bytes the getDynamicField mock returns.
function metadataField(tags: Record<string, string>) {
    const map = new Map(Object.entries(tags));
    const value = METADATA_BCS.serialize({ metadata: map }).toBytes();
    return { dynamicField: { value: { bcs: value } } };
}

// Install stubs; each test sets these two closures.
let ownedByAddr: (owner: string) => any[];
let metaByObject: (objectId: string) => any;
(suiClient as any).listOwnedObjects = async ({ owner }: { owner: string }) => ({
    objects: ownedByAddr(owner),
    hasNextPage: false,
    cursor: null,
});
(suiClient as any).getDynamicField = async ({ parentId }: { parentId: string }) => metaByObject(parentId);

const BLOB_RAW = "123456789012345678901234"; // long decimal → treated as U256

test("found: a server-wallet blob tagged with this job AND owner → found", async () => {
    ownedByAddr = (o) => (o === serverAddr ? [makeBlob("0xobjA", BLOB_RAW)] : []);
    metaByObject = () => metadataField({ memwal_job_id: "job-1", memwal_owner: USER });
    const r = await findBlobObjectByJob(USER, "job-1");
    assert.equal(r.status, "found");
    if (r.status === "found") assert.equal(r.objectId, "0xobjA");
});

test("not_found: a blob with the job tag but a DIFFERENT owner is never adopted", async () => {
    const otherUser = normalizeSuiAddress(`0x${"2".repeat(64)}`);
    ownedByAddr = (o) => (o === serverAddr ? [makeBlob("0xobjB", BLOB_RAW)] : []);
    metaByObject = () => metadataField({ memwal_job_id: "job-1", memwal_owner: otherUser });
    const r = await findBlobObjectByJob(USER, "job-1");
    assert.equal(r.status, "not_found", "job tag alone must NOT match another user's blob");
});

test("not_found: no blob carries the job tag → not_found (caller uploads)", async () => {
    ownedByAddr = () => [];
    metaByObject = () => metadataField({});
    const r = await findBlobObjectByJob(USER, "job-1");
    assert.equal(r.status, "not_found");
});

test("a throwing per-blob metadata read PROPAGATES (fail-closed), not swallowed", async () => {
    ownedByAddr = (o) => (o === serverAddr ? [makeBlob("0xobjC", BLOB_RAW)] : []);
    metaByObject = () => {
        throw new Error("gRPC getDynamicField transport error");
    };
    await assert.rejects(
        findBlobObjectByJob(USER, "job-1"),
        /getDynamicField|transport/,
        "a metadata read failure must reject → route 500 → relayer fails closed"
    );
});
