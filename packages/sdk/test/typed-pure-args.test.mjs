import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

// WALM-442 / GH #799: account.ts and manual.ts used the legacy two-arg
// `tx.pure("vector<u8>", …)` form. Modern `@mysten/sui` documents the typed
// helpers (`tx.pure.vector("u8", …)`, `tx.pure.string(…)`). Pin the call
// sites so the legacy form cannot land again.

const FILES = ["account.ts", "manual.ts"];

test("account.ts and manual.ts use typed tx.pure helpers, not legacy two-arg form", () => {
    for (const file of FILES) {
        const src = readFileSync(new URL(`../src/${file}`, import.meta.url), "utf8");
        assert.equal(
            src.includes('tx.pure("'),
            false,
            `${file} still contains legacy tx.pure("type", value)`,
        );
        assert.equal(
            src.includes("tx.pure('"),
            false,
            `${file} still contains legacy tx.pure('type', value)`,
        );
        assert.match(
            src,
            /tx\.pure\.vector\(\s*["']u8["']/,
            `${file} must pass vector<u8> via tx.pure.vector`,
        );
    }
});

test("addDelegateKey / removeDelegateKey labels use tx.pure.string", () => {
    const src = readFileSync(new URL("../src/account.ts", import.meta.url), "utf8");
    assert.match(src, /tx\.pure\.string\(\s*opts\.label\s*\)/);
});
