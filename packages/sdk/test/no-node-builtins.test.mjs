/**
 * WALM-136 (GH #322) — the SDK must not pull Node builtins into a browser bundle.
 *
 * The reported failure is a quiet one: Vite externalises an imported Node
 * builtin without warning, the app builds cleanly, and the browser crashes at
 * runtime when the code path is finally taken. A green build proves nothing,
 * so the guard has to be on what the package actually ships.
 *
 * `sha256hex` was the last such import — a `crypto` fallback that could never
 * help a browser anyway (if `crypto.subtle` is missing because the page is not
 * a secure context, `node:crypto` is not there either) and only served Node
 * <19, which is EOL. It sits on the signed-request path, so every remember and
 * recall reached it.
 *
 * The first test is the regression guard, and it covers the whole class rather
 * than one line: any future `fs`/`path`/`crypto` import in the SDK fails it.
 * The second is a correctness companion — it passed before the swap too (Node
 * resolved the fallback happily), so it is not the guard, it just proves the
 * hash itself stayed right once the branch was removed.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { builtinModules } from "node:module";
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join, dirname, resolve, relative } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DIST = resolve(__dirname, "../dist");

const BUILTINS = new Set(builtinModules);

/** `from "x"`, `import("x")`, `require("x")` — the three ways a specifier can
 * reach a bundler. Deliberately does NOT match `globalThis.crypto`, which is a
 * global read and has nothing to resolve. */
const SPECIFIER = /(?:\bfrom\s*|\bimport\s*\(\s*|\brequire\s*\(\s*)["']([^"']+)["']/g;

function jsFiles(dir) {
    const out = [];
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) out.push(...jsFiles(full));
        else if (entry.name.endsWith(".js")) out.push(full);
    }
    return out;
}

test("the built SDK imports no Node builtins", () => {
    assert.ok(existsSync(DIST), `dist/ missing — run \`pnpm run build\` first (looked in ${DIST})`);

    const offenders = [];
    for (const file of jsFiles(DIST)) {
        const src = readFileSync(file, "utf8");
        for (const [, spec] of src.matchAll(SPECIFIER)) {
            const bare = spec.startsWith("node:") ? spec.slice("node:".length) : spec;
            if (BUILTINS.has(bare)) {
                offenders.push(`${relative(DIST, file)} imports "${spec}"`);
            }
        }
    }

    assert.deepEqual(
        offenders,
        [],
        `SDK ships Node builtin imports; a browser bundler will externalise these ` +
            `silently and the page crashes when the path runs:\n  ${offenders.join("\n  ")}`,
    );
});

test("sha256hex hashes correctly without globalThis.crypto", async () => {
    const original = Object.getOwnPropertyDescriptor(globalThis, "crypto");
    // Simulate a browser that is not a secure context: `crypto.subtle` is
    // undefined there, which is exactly when the old fallback fired.
    Object.defineProperty(globalThis, "crypto", { value: undefined, configurable: true });
    try {
        const { sha256hex } = await import("../dist/utils.js");
        // Known-answer vectors, so a wrong-but-plausible digest cannot pass.
        assert.equal(
            await sha256hex("hello"),
            "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824",
        );
        assert.equal(
            await sha256hex(""),
            "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
        );
    } finally {
        if (original) Object.defineProperty(globalThis, "crypto", original);
        else delete globalThis.crypto;
    }
});
