import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const pkgJsonPath = path.join(__dirname, "..", "package.json");
const pkg = JSON.parse(fs.readFileSync(pkgJsonPath, "utf8"));

test("exports map declares types first, import, and default fallback (Fixes #1143, WALM-721)", () => {
    assert.ok(pkg.exports, "package.json must define exports map");

    const expectedSubpaths = [".", "./account", "./manual", "./ai"];
    for (const subpath of expectedSubpaths) {
        const entry = pkg.exports[subpath];
        assert.ok(entry, `exports["${subpath}"] must be defined`);

        const keys = Object.keys(entry);
        assert.equal(
            keys[0],
            "types",
            `exports["${subpath}"] must specify "types" condition first for TypeScript nodenext resolution`,
        );

        assert.ok(
            entry.import,
            `exports["${subpath}"] must specify "import" condition for ESM imports`,
        );

        assert.ok(
            entry.default,
            `exports["${subpath}"] must specify "default" condition for bundlers (Next.js/Turbopack) and Node 22 require(esm)`,
        );

        assert.equal(
            entry.default,
            entry.import,
            `exports["${subpath}"].default must match exports["${subpath}"].import`,
        );
    }
});

test("all exported entry points resolve via ESM import.meta.resolve", async () => {
    // Verify that the entrypoints resolve
    const rootExport = await import.meta.resolve("@mysten-incubation/memwal", import.meta.url);
    assert.ok(rootExport.endsWith("/dist/index.js"));

    const accountExport = await import.meta.resolve("@mysten-incubation/memwal/account", import.meta.url);
    assert.ok(accountExport.endsWith("/dist/account-entry.js"));

    const manualExport = await import.meta.resolve("@mysten-incubation/memwal/manual", import.meta.url);
    assert.ok(manualExport.endsWith("/dist/manual-entry.js"));

    const aiExport = await import.meta.resolve("@mysten-incubation/memwal/ai", import.meta.url);
    assert.ok(aiExport.endsWith("/dist/ai/index.js"));
});
