import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// The runtime tests in recall-created-at.test.mjs pass whether or not the
// TYPES declare these fields — `recall()` spreads the relayer's JSON straight
// through, and a .mjs test never sees a type error. But a TypeScript consumer
// writing `results[0].created_at` or `recall({ scoringWeights })` gets a
// compile error unless the declarations carry them, which is the whole point
// of WALM-383 ask #1 for SDK users.
//
// So assert against the emitted .d.ts — the artifact consumers actually
// resolve. Reading the declaration file keeps this in plain .mjs alongside
// every other test in this package, rather than pulling in a type-test
// toolchain for two fields.

const dts = readFileSync(
    fileURLToPath(new URL("../dist/types.d.ts", import.meta.url)),
    "utf8",
);

/** Body of `export interface <name> { ... }` from the emitted declarations. */
function declaredInterface(name) {
    const start = dts.indexOf(`interface ${name} {`);
    assert.notEqual(start, -1, `${name} is not declared in dist/types.d.ts`);
    const open = dts.indexOf("{", start);
    let depth = 0;
    for (let i = open; i < dts.length; i++) {
        if (dts[i] === "{") depth++;
        else if (dts[i] === "}" && --depth === 0) return dts.slice(open + 1, i);
    }
    throw new Error(`unterminated interface ${name}`);
}

test("RecallMemory declares created_at so consumers can read the write-time", () => {
    assert.match(declaredInterface("RecallMemory"), /created_at\?: string;/);
});

test("RecallOptions declares scoringWeights so consumers can request recency ranking", () => {
    assert.match(declaredInterface("RecallOptions"), /scoringWeights\?: ScoringWeights;/);
});

test("created_at is optional — older relayers omit it", () => {
    // If this ever becomes required, every consumer pointed at an older
    // relayer starts lying to itself about a field that isn't there.
    assert.match(declaredInterface("RecallMemory"), /created_at\?:/);
});
