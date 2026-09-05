import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { Transaction } from "@mysten/sui/transactions";

const srcDir = join(dirname(fileURLToPath(import.meta.url)), "../src");

// WALM-465 / GH #799: @mysten/sui >= 2.5 treats tx.pure("vector<u8>", value)
// as a Pure argument whose *value* is the type string, not a typed vector.
function source(name) {
    return readFileSync(join(srcDir, name), "utf8");
}

test("account.ts and manual.ts do not use the two-argument tx.pure(type, value) form", () => {
    for (const file of ["account.ts", "manual.ts"]) {
        const text = source(file);
        assert.equal(
            text.includes('tx.pure("vector<u8>"'),
            false,
            `${file} still passes "vector<u8>" as a tx.pure type string`
        );
        assert.equal(
            text.includes('tx.pure("string"'),
            false,
            `${file} still passes "string" as a tx.pure type string`
        );
    }
    const account = source("account.ts");
    assert.match(account, /tx\.pure\.vector\(\s*"u8"/);
    assert.match(account, /tx\.pure\.string\(/);
    assert.match(source("manual.ts"), /tx\.pure\.vector\(\s*"u8"/);
});

test("typed pure helpers construct a PTB without treating the Move type as the value", () => {
    const tx = new Transaction();
    tx.moveCall({
        target: "0x1::account::add_delegate_key",
        arguments: [
            tx.object("0x2"),
            tx.object("0x3"),
            tx.pure.vector("u8", Array.from(new Uint8Array(32))),
            tx.pure.string("My Laptop"),
            tx.object("0x6"),
        ],
    });
    const inputs = tx.getData().inputs;
    // Two-arg tx.pure("vector<u8>", bytes) used to serialize the type name as
    // the pure value. Typed helpers must produce Pure inputs, not a string
    // argument equal to "vector<u8>".
    for (const input of inputs) {
        const pure = input.Pure?.bytes ?? input.Pure;
        const decoded = typeof pure === "string" ? pure : undefined;
        assert.notEqual(decoded, "vector<u8>");
        assert.notEqual(decoded, "string");
    }
    assert.ok(inputs.length >= 2);
});
