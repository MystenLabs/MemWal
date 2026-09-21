import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const SCRIPT = fileURLToPath(new URL("./build-claude-plugin.mjs", import.meta.url));
const ROOT = fileURLToPath(new URL("..", import.meta.url));

function listing(dir) {
    const found = [];
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) found.push(...listing(full).map((child) => `${entry.name}/${child}`));
        else found.push(entry.name);
    }
    return found.sort();
}

function generate(outDir) {
    const result = spawnSync(process.execPath, [SCRIPT, "--out", outDir], {
        cwd: ROOT,
        encoding: "utf8",
    });
    assert.equal(result.status, 0, result.stderr);
    return listing(outDir);
}

test("the generated plugin tree is deterministic, complete and free of placeholders", () => {
    const workspace = mkdtempSync(path.join(tmpdir(), "memwal-plugin-"));
    try {
        const first = path.join(workspace, "first");
        const second = path.join(workspace, "second");
        const paths = generate(first);
        assert.deepEqual(generate(second), paths);

        for (const target of paths) {
            assert.deepEqual(
                readFileSync(path.join(first, target)),
                readFileSync(path.join(second, target)),
                `${target} is not reproducible`,
            );
        }

        for (const target of [
            ".claude-plugin/plugin.json",
            ".github/workflows/ci.yml",
            "LICENSE",
            "README.md",
            "commands/remember.md",
            "hooks/hooks.json",
            "plugin.json",
            "scripts/on_user_prompt.mjs",
            "skills/setup/SKILL.md",
            "test/signals.test.mjs",
        ]) {
            assert.ok(paths.includes(target), `${target} is not in the generated tree`);
        }

        assert.ok(!paths.includes(".github/CODEOWNERS"), "CODEOWNERS belongs to the published repository");

        for (const target of paths.filter((name) => name.endsWith(".md"))) {
            assert.doesNotMatch(
                readFileSync(path.join(first, target), "utf8"),
                /__MEMWAL_[A-Z_]+__/,
                `${target} still carries a generator placeholder`,
            );
        }

        const check = spawnSync(process.execPath, [SCRIPT, "--check", "--against", first], {
            cwd: ROOT,
            encoding: "utf8",
        });
        assert.equal(check.status, 0, check.stderr);
    } finally {
        rmSync(workspace, { recursive: true, force: true });
    }
});
