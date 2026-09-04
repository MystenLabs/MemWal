import test from "node:test";
import assert from "node:assert/strict";
import { Transaction } from "@mysten/sui/transactions";
import { normalizeSuiAddress } from "@mysten/sui/utils";
import { appendV2WriteFence } from "../sidecar/blob-metadata.js";
import { namespaceSealKeyId } from "../sidecar/v2-envelope.js";

const PKG = `0x${"d".repeat(64)}`;
const NS_REG = `0x${"1".repeat(64)}`;
const ACC_REG = `0x${"2".repeat(64)}`;
const ACC = `0x${"3".repeat(64)}`;
const NS = `0x${"4".repeat(64)}`;
const CLOCK = "0x6";

test("appendV2WriteFence argument order is id, nsRegistry, accountRegistry, account, namespace, commitment, clock", () => {
    const tx = new Transaction();
    const idBytes = Array.from(namespaceSealKeyId(NS, 0n));
    const commitment = Array.from({ length: 32 }, (_, i) => i);
    appendV2WriteFence(tx, {
        packageId: PKG,
        idBytes,
        nsRegistryId: NS_REG,
        accountRegistryId: ACC_REG,
        accountId: ACC,
        namespaceId: NS,
        commitment,
        clockId: CLOCK,
    });
    const data = tx.getData();
    const calls = data.commands.filter((c) => (c as any).$kind === "MoveCall" || (c as any).MoveCall);
    assert.equal(calls.length, 1);
    const mc = (calls[0] as any).MoveCall ?? (calls[0] as any);
    assert.equal(normalizeSuiAddress(mc.package), normalizeSuiAddress(PKG));
    assert.equal(mc.module, "namespace");
    assert.equal(mc.function, "write_fence");
    assert.equal(mc.arguments.length, 7);

    const inputs = mc.arguments.map((a: any) => data.inputs[a.Input]);
    assert.equal(inputs[0].$kind, "Pure", "arg 0 is Seal id bytes");
    assert.equal(inputs[1].$kind, "UnresolvedObject");
    assert.equal(normalizeSuiAddress(inputs[1].UnresolvedObject.objectId), normalizeSuiAddress(NS_REG));
    assert.equal(inputs[2].$kind, "UnresolvedObject");
    assert.equal(normalizeSuiAddress(inputs[2].UnresolvedObject.objectId), normalizeSuiAddress(ACC_REG));
    assert.equal(inputs[3].$kind, "UnresolvedObject");
    assert.equal(normalizeSuiAddress(inputs[3].UnresolvedObject.objectId), normalizeSuiAddress(ACC));
    assert.equal(inputs[4].$kind, "UnresolvedObject");
    assert.equal(normalizeSuiAddress(inputs[4].UnresolvedObject.objectId), normalizeSuiAddress(NS));
    assert.equal(inputs[5].$kind, "Pure", "arg 5 is commitment");
    assert.equal(inputs[6].$kind, "UnresolvedObject");
    assert.equal(normalizeSuiAddress(inputs[6].UnresolvedObject.objectId), normalizeSuiAddress(CLOCK));
});
