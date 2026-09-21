/**
 * Hook state must not be redirectable through a symlink (WALM-644).
 *
 * The old `existsSync(marker) ? skip : writeFileSync(marker, "1")` pair let a
 * dangling symlink planted at a marker path pass the existence check and then
 * absorb the write, creating a file outside the state directory. Markers are
 * now created exclusively (O_CREAT|O_EXCL, plus O_NOFOLLOW where it exists),
 * so an occupied path is refused rather than followed — and the directory
 * itself is private and verified before use.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
    mkdtempSync,
    mkdirSync,
    rmSync,
    symlinkSync,
    lstatSync,
    existsSync,
    readdirSync,
    readFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const HOOK = resolve(__dirname, "../plugin/scripts/on_user_prompt.mjs");
const HOOK_IO = "../plugin/scripts/lib/hook-io.mjs";

// Windows needs a privilege or developer mode to create symlinks at all, and
// has no O_NOFOLLOW; the attack this guards is a POSIX temp-dir one.
const skipOnWindows =
    process.platform === "win32" ? "symlink creation needs privileges on Windows" : false;

/** A throwaway TMPDIR plus an "elsewhere" directory a symlink could point into. */
function sandbox(t) {
    const root = mkdtempSync(join(tmpdir(), "memwal-hookstate-"));
    const temp = join(root, "tmp");
    const elsewhere = join(root, "elsewhere");
    mkdirSync(temp);
    mkdirSync(elsewhere);
    const previous = process.env.TMPDIR;
    process.env.TMPDIR = temp;
    t.after(() => {
        if (previous === undefined) delete process.env.TMPDIR;
        else process.env.TMPDIR = previous;
        rmSync(root, { recursive: true, force: true });
    });
    return {
        root,
        temp,
        elsewhere,
        stateDir: join(temp, "memwal-hooks"),
        target: join(elsewhere, "pwned"),
    };
}

/** Every file under `dir`, relative to it — used to prove nothing escaped. */
function treeOf(dir) {
    return readdirSync(dir, { recursive: true, withFileTypes: true })
        .filter((entry) => !entry.isDirectory())
        .map((entry) => entry.name)
        .sort();
}

test("a dangling symlink at a marker path cannot create the target", { skip: skipOnWindows }, async (t) => {
    const box = sandbox(t);
    const { firstTime, stateDir } = await import(HOOK_IO);

    assert.equal(stateDir(), box.stateDir);
    const marker = join(box.stateDir, "rubric_walm644");
    symlinkSync(box.target, marker);
    assert.equal(existsSync(box.target), false, "precondition: the target is dangling");

    // The reproduction: the marker "does not exist" by existsSync, so the old
    // code wrote through it. An occupied path now reports not-first-time.
    assert.equal(firstTime("rubric", "walm644"), false);

    assert.equal(existsSync(box.target), false, "symlink target must stay uncreated");
    assert.ok(lstatSync(marker).isSymbolicLink(), "the planted symlink is left alone");
    assert.deepEqual(treeOf(box.elsewhere), [], "nothing was written outside the state dir");
});

test("bumpCounter refuses a symlinked counter path", { skip: skipOnWindows }, async (t) => {
    const box = sandbox(t);
    const { bumpCounter, stateDir } = await import(HOOK_IO);

    assert.equal(stateDir(), box.stateDir);
    const counter = join(box.stateDir, "count_nudge_walm644");
    symlinkSync(box.target, counter);

    // Still answers, still never throws — it just keeps the count in memory.
    assert.equal(bumpCounter("nudge", "walm644"), 1);
    assert.equal(bumpCounter("nudge", "walm644"), 2);

    assert.equal(existsSync(box.target), false, "symlink target must stay uncreated");
    assert.ok(lstatSync(counter).isSymbolicLink());
    assert.deepEqual(treeOf(box.elsewhere), []);
});

test("normal session markers still work", { skip: skipOnWindows }, async (t) => {
    const box = sandbox(t);
    const { firstTime, bumpCounter, stateDir } = await import(HOOK_IO);

    assert.equal(firstTime("rubric", "session-a"), true);
    assert.equal(firstTime("rubric", "session-a"), false);
    assert.equal(firstTime("rubric", "session-a"), false);
    // A different session is unaffected by the first one's marker.
    assert.equal(firstTime("rubric", "session-b"), true);

    const marker = join(stateDir(), "rubric_session-a");
    assert.ok(lstatSync(marker).isFile(), "the marker is a plain file, not a link");
    assert.equal(readFileSync(marker, "utf8"), "1");

    assert.equal(bumpCounter("turns", "session-a"), 1);
    assert.equal(bumpCounter("turns", "session-a"), 2);
    assert.equal(bumpCounter("turns", "session-a"), 3);
    assert.equal(readFileSync(join(stateDir(), "count_turns_session-a"), "utf8"), "3");

    assert.deepEqual(treeOf(box.elsewhere), []);
});

test("the state directory is private, and a symlinked one is refused", { skip: skipOnWindows }, async (t) => {
    const box = sandbox(t);
    const { firstTime, stateDir } = await import(HOOK_IO);

    const dir = stateDir();
    assert.equal(dir, box.stateDir);
    const st = lstatSync(dir);
    assert.ok(st.isDirectory());
    assert.equal(st.mode & 0o077, 0, "state dir must not be group/world accessible");

    // Now stand a symlink where the state directory would be: the helper must
    // refuse it outright instead of writing through it.
    const hijacked = mkdtempSync(join(tmpdir(), "memwal-hookstate-hijack-"));
    const decoy = join(hijacked, "tmp");
    mkdirSync(decoy);
    symlinkSync(box.elsewhere, join(decoy, "memwal-hooks"));
    process.env.TMPDIR = decoy;
    t.after(() => rmSync(hijacked, { recursive: true, force: true }));

    assert.equal(stateDir(), null, "a symlinked state dir is not usable");
    // Degrades to in-process state: still answers, still writes nothing.
    assert.equal(firstTime("rubric", "hijacked"), true);
    assert.equal(firstTime("rubric", "hijacked"), false);
    assert.deepEqual(treeOf(box.elsewhere), []);
});

test("the real prompt hook does not write through a planted symlink", { skip: skipOnWindows }, (t) => {
    const box = sandbox(t);
    mkdirSync(box.stateDir, { recursive: true, mode: 0o700 });
    const sessionId = "walm644-e2e";
    symlinkSync(box.target, join(box.stateDir, `rubric_${sessionId}`));

    const result = spawnSync(process.execPath, [HOOK], {
        input: JSON.stringify({
            prompt: "Remember that I always use pnpm and my canary is cedar-wren-11.",
            session_id: sessionId,
        }),
        encoding: "utf8",
        env: { ...process.env, TMPDIR: box.temp },
    });

    assert.equal(result.status, 0, result.stderr);
    assert.ok(result.stdout.trim(), "the hook still emits its directive");
    JSON.parse(result.stdout); // well-formed, so the session is never blocked
    assert.equal(existsSync(box.target), false, "symlink target must stay uncreated");
    assert.deepEqual(treeOf(box.elsewhere), []);
});
