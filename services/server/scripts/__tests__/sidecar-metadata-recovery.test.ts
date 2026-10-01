import test from "node:test";
import assert from "node:assert/strict";
import { recoverMetadataBatch } from "../sidecar/metadata-recovery.js";

const target = `0x${"1".repeat(64)}`;
const signer = `0x${"2".repeat(64)}`;
const pkg = `0x${"a".repeat(64)}`;
const agent = "ab".repeat(32);

function receipt(owner: unknown, namespace = "bench") {
    return {
        owner,
        metadata: [
            { key: "memwal_namespace", value: namespace },
            { key: "memwal_owner", value: target },
            { key: "memwal_package_id", value: pkg },
            { key: "memwal_agent_id", value: agent },
        ],
    };
}

test("already-owned blob with matching metadata is not signed again", async () => {
    let submitted = 0;
    const result = await recoverMetadataBatch(
        [{ blobObjectId: "0xlanded", namespace: "bench" }],
        target,
        signer,
        pkg,
        agent,
        async () => receipt({ AddressOwner: target.toUpperCase() }),
        async () => {
            submitted += 1;
            return "digest";
        },
    );
    assert.equal(submitted, 0);
    assert.deepEqual(result, {
        transferred: 0,
        digest: null,
        transferStatus: "already_transferred",
    });
});

test("string owner encoding is the same receipt as AddressOwner", async () => {
    let submitted = 0;
    const result = await recoverMetadataBatch(
        [{ blobObjectId: "0xlanded", namespace: "bench" }],
        target,
        signer,
        pkg,
        agent,
        async () => receipt(target),
        async () => {
            submitted += 1;
            return "digest";
        },
    );
    assert.equal(submitted, 0);
    assert.equal(result.transferStatus, "already_transferred");
});

test("writer-owned blob is still transferred by the uploader", async () => {
    const pending: string[] = [];
    const result = await recoverMetadataBatch(
        [{ blobObjectId: "0xwriter", namespace: "bench" }],
        target,
        signer,
        pkg,
        agent,
        async () => receipt(signer),
        async (blobs) => {
            pending.push(...blobs.map((blob) => blob.blobObjectId));
            return "digest-new";
        },
    );
    assert.deepEqual(pending, ["0xwriter"]);
    assert.equal(result.transferred, 1);
    assert.equal(result.digest, "digest-new");
    assert.equal(result.transferStatus, "ok");
});

test("a third-party owner is not signed as the target", async () => {
    await assert.rejects(
        () => recoverMetadataBatch(
            [{ blobObjectId: "0xother", namespace: "bench" }],
            target,
            signer,
            pkg,
            agent,
            async () => receipt(`0x${"3".repeat(64)}`),
            async () => "nope",
        ),
        /BLOB_OWNER_MISMATCH: 0xother/,
    );
});

test("target ownership with different metadata is not treated as done", async () => {
    await assert.rejects(
        () => recoverMetadataBatch(
            [{ blobObjectId: "0xlanded", namespace: "other-ns" }],
            target,
            signer,
            pkg,
            agent,
            async () => receipt({ AddressOwner: target }),
            async () => "nope",
        ),
        /METADATA_RECEIPT_MISMATCH: 0xlanded/,
    );
});

test("owner-signed blob missing only the agent id is stamped", async () => {
    const pending: string[] = [];
    const metadata = receipt({ AddressOwner: target }).metadata
        .filter((entry) => entry.key !== "memwal_agent_id");
    const result = await recoverMetadataBatch(
        [
            { blobObjectId: "0xself", namespace: "bench" },
            { blobObjectId: "0xdone", namespace: "bench" },
        ],
        target,
        target,
        pkg,
        agent,
        async (id) => ({
            owner: { AddressOwner: target },
            metadata: id === "0xself" ? metadata : receipt(target).metadata,
        }),
        async (blobs) => {
            pending.push(...blobs.map((blob) => blob.blobObjectId));
            return "digest-stamp";
        },
    );
    assert.deepEqual(pending, ["0xself"]);
    assert.equal(result.transferred, 1);
    assert.equal(result.digest, "digest-stamp");
    assert.equal(result.transferStatus, "ok");
});

test("a different agent id is not overwritten", async () => {
    await assert.rejects(
        () => recoverMetadataBatch(
            [{ blobObjectId: "0xself", namespace: "bench" }],
            target,
            target,
            pkg,
            "other-agent",
            async () => receipt({ AddressOwner: target }),
            async () => "nope",
        ),
        /METADATA_RECEIPT_MISMATCH: 0xself/,
    );
});

test("a different signer cannot stamp a missing agent id", async () => {
    const metadata = receipt({ AddressOwner: target }).metadata
        .filter((entry) => entry.key !== "memwal_agent_id");
    await assert.rejects(
        () => recoverMetadataBatch(
            [{ blobObjectId: "0xlanded", namespace: "bench" }],
            target,
            signer,
            pkg,
            agent,
            async () => ({ owner: { AddressOwner: target }, metadata }),
            async () => "nope",
        ),
        /METADATA_RECEIPT_MISMATCH: 0xlanded/,
    );
});
