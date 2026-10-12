import test from "node:test";
import assert from "node:assert/strict";
import { recoverMetadataBatch } from "../sidecar/metadata-recovery.js";
const owner = `0x${"1".repeat(64)}`, signer = `0x${"2".repeat(64)}`, pkg = `0x${"3".repeat(64)}`;
const blobs = [{ blobObjectId: "0x4", namespace: "burst" }];
const metadata = [{ key: "memwal_namespace", value: "burst" }, { key: "memwal_owner", value: owner }, { key: "memwal_package_id", value: pkg }, { key: "memwal_agent_id", value: "agent" }];
test("lost response after committed transfer retries without a second transaction", async () => {
 let transferred = false, submissions = 0;
 const run = () => recoverMetadataBatch(blobs, owner, signer, pkg, "agent",
  async () => ({ owner: { AddressOwner: transferred ? owner : signer }, metadata }),
  async () => { submissions++; transferred = true; throw new Error("connection dropped after execution"); });
 await assert.rejects(run(), /connection dropped/);
 assert.deepEqual(await run(), { transferred: 0, digest: null, transferStatus: "already_transferred" });
 assert.equal(submissions, 1);
});
test("mixed batch submits only writer-owned blobs", async () => {
 const result = await recoverMetadataBatch([...blobs, { ...blobs[0], blobObjectId: "0x5" }], owner, signer, pkg, "agent",
  async id => ({ owner: { AddressOwner: id === "0x4" ? owner : signer }, metadata }),
  async pending => { assert.deepEqual(pending.map(x => x.blobObjectId), ["0x5"]); return "digest"; });
 assert.equal(result.transferred, 1);
});
test("recipient ownership alone is insufficient; metadata mismatch fails closed", async () => {
 for (const key of metadata.map(x => x.key)) await assert.rejects(recoverMetadataBatch(blobs, owner, signer, pkg, "agent",
  async () => ({ owner: { AddressOwner: owner }, metadata: metadata.filter(x => x.key !== key) }),
  async () => { assert.fail("must not resubmit"); }), /METADATA_RECEIPT_MISMATCH/);
});
test("foreign or object ownership never counts as successful transfer", async () => {
 for (const wrongOwner of [{ AddressOwner: pkg }, { ObjectOwner: owner }, null]) await assert.rejects(recoverMetadataBatch(blobs, owner, signer, pkg, "agent",
  async () => ({ owner: wrongOwner, metadata }), async () => { assert.fail("must not submit"); }), /BLOB_OWNER_MISMATCH/);
});
test("RPC failure does not submit a replacement transaction", async () => {
 await assert.rejects(recoverMetadataBatch(blobs, owner, signer, pkg, "agent",
  async () => { throw new Error("RPC unavailable"); }, async () => { assert.fail("must not submit"); }), /RPC unavailable/);
});
