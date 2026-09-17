/**
 * Automatic saving is opt-in, and OFF is the default (WALM-642).
 *
 * The thing being gated is narrow and worth naming: saving something the user
 * did not ask to have saved. A direct request ("remember that ...") is not
 * gated, and neither is recall — so these tests check both that the guidance
 * goes quiet when the opt-in is off AND that nothing else goes quiet with it.
 *
 * Both halves of the opt-in are covered, because they are two separate
 * implementations of the same rule: the TypeScript one the MCP server reads,
 * and the plain-`.mjs` one the plugin hooks read. The hooks are spawned by the
 * client, not by this package, so they cannot share the compiled module and a
 * divergence between the two would be invisible.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, statSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
    autoSaveStatus,
    isAutoSaveEnabled,
    parseBooleanSetting,
    setAutoSave,
    settingsPath,
    AUTO_SAVE_ENV,
} from "../dist/auto-save.js";
import * as hookAutoSave from "../plugin/scripts/lib/auto-save.mjs";
import { parseArgs, helpText } from "../dist/index.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCRIPTS = resolve(__dirname, "../plugin/scripts");

/** A fresh, empty `.memwal` directory, so no developer's real settings leak in. */
function freshCredsDir() {
    const dir = mkdtempSync(join(tmpdir(), "memwal-autosave-"));
    return dir;
}

function writeSettings(dir, value) {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "settings.json"), JSON.stringify(value));
}

/** Run one hook with a controlled environment and return its injected text. */
function runHook(script, input, env) {
    const result = spawnSync(process.execPath, [join(SCRIPTS, script)], {
        input: JSON.stringify(input),
        encoding: "utf8",
        env: { ...process.env, MEMWAL_AUTO_SAVE: "", ...env },
    });
    assert.equal(result.status, 0, result.stderr);
    if (!result.stdout.trim()) return "";
    return JSON.parse(result.stdout).hookSpecificOutput?.additionalContext ?? "";
}

/** Run `fn` with env vars set, restoring them afterwards. */
function withEnv(vars, fn) {
    const saved = {};
    for (const [k, v] of Object.entries(vars)) {
        saved[k] = process.env[k];
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
    }
    try {
        return fn();
    } finally {
        for (const [k, v] of Object.entries(saved)) {
            if (v === undefined) delete process.env[k];
            else process.env[k] = v;
        }
    }
}

// ── the resolver ────────────────────────────────────────────────────────────

test("the default is off", () => {
    const dir = freshCredsDir();
    withEnv({ MEMWAL_CREDS_DIR: dir, [AUTO_SAVE_ENV]: undefined }, () => {
        assert.equal(isAutoSaveEnabled(), false);
        assert.deepEqual(autoSaveStatus(), {
            enabled: false,
            source: "default",
            path: join(dir, "settings.json"),
        });
    });
    rmSync(dir, { recursive: true, force: true });
});

test("a persisted choice is read back, either way", () => {
    const dir = freshCredsDir();
    withEnv({ MEMWAL_CREDS_DIR: dir, [AUTO_SAVE_ENV]: undefined }, () => {
        setAutoSave(true);
        assert.equal(isAutoSaveEnabled(), true);
        assert.equal(autoSaveStatus().source, "settings");

        setAutoSave(false);
        assert.equal(isAutoSaveEnabled(), false);
        assert.equal(autoSaveStatus().source, "settings");
    });
    rmSync(dir, { recursive: true, force: true });
});

test("the settings file is not world-readable and keeps unrelated keys", () => {
    const dir = freshCredsDir();
    withEnv({ MEMWAL_CREDS_DIR: dir, [AUTO_SAVE_ENV]: undefined }, () => {
        writeSettings(dir, { somethingElse: "keep me" });
        setAutoSave(true);
        const path = settingsPath();
        assert.equal(statSync(path).mode & 0o777, 0o600);
        const parsed = JSON.parse(readFileSync(path, "utf8"));
        assert.equal(parsed.somethingElse, "keep me");
        assert.equal(parsed.autoSave, true);
    });
    rmSync(dir, { recursive: true, force: true });
});

test("the environment overrides the file, in both directions", () => {
    const dir = freshCredsDir();
    withEnv({ MEMWAL_CREDS_DIR: dir, [AUTO_SAVE_ENV]: undefined }, () => {
        setAutoSave(false);
        withEnv({ [AUTO_SAVE_ENV]: "1" }, () => {
            assert.equal(isAutoSaveEnabled(), true);
            assert.equal(autoSaveStatus().source, "env");
        });
        setAutoSave(true);
        withEnv({ [AUTO_SAVE_ENV]: "0" }, () => {
            assert.equal(isAutoSaveEnabled(), false);
            assert.equal(autoSaveStatus().source, "env");
        });
    });
    rmSync(dir, { recursive: true, force: true });
});

test("an unreadable or unparseable value is not consent", () => {
    // Every one of these means "I could not tell", and the safe reading of
    // that is off — not on, and not a crash.
    for (const raw of [undefined, "", "   ", "maybe", "2", "ON!"]) {
        assert.equal(parseBooleanSetting(raw), null, `"${raw}" should be unparseable`);
    }
    assert.equal(parseBooleanSetting("yes"), true);
    assert.equal(parseBooleanSetting(" OFF "), false);

    const dir = freshCredsDir();
    withEnv({ MEMWAL_CREDS_DIR: dir, [AUTO_SAVE_ENV]: undefined }, () => {
        writeFileSync(join(dir, "settings.json"), "{ not json");
        assert.equal(isAutoSaveEnabled(), false);
        assert.equal(autoSaveStatus().source, "default");
    });
    rmSync(dir, { recursive: true, force: true });
});

test("the hook-side resolver answers identically to the compiled one", () => {
    const dir = freshCredsDir();
    withEnv({ MEMWAL_CREDS_DIR: dir, [AUTO_SAVE_ENV]: undefined }, () => {
        assert.equal(hookAutoSave.isAutoSaveEnabled(), isAutoSaveEnabled());
        assert.equal(hookAutoSave.settingsPath(), settingsPath());

        setAutoSave(true);
        assert.equal(hookAutoSave.isAutoSaveEnabled(), true);
        assert.equal(hookAutoSave.autoSaveStatus().source, "settings");

        withEnv({ [AUTO_SAVE_ENV]: "off" }, () => {
            assert.equal(hookAutoSave.isAutoSaveEnabled(), false);
            assert.equal(hookAutoSave.autoSaveStatus().source, "env");
        });
    });
    rmSync(dir, { recursive: true, force: true });
});

// ── the hooks ───────────────────────────────────────────────────────────────

test("SessionStart does not tell the agent to save until the user opts in", () => {
    const dir = freshCredsDir();
    const off = runHook("on_session_start.mjs", {}, { MEMWAL_CREDS_DIR: dir });

    assert.match(off, /Automatic memory is OFF/);
    assert.match(off, /Save ONLY what the user asks you to save/);
    // The unprompted-save instruction is the thing that must be gone.
    assert.doesNotMatch(off, /do not ask whether to save it/i);
    // ...and the things that must NOT be gone with it.
    assert.match(off, /memwal_recall/);
    assert.match(off, /memwal_restore/);
    assert.match(off, /auto-save on/);

    writeSettings(dir, { autoSave: true });
    const on = runHook("on_session_start.mjs", {}, { MEMWAL_CREDS_DIR: dir });
    assert.match(on, /Automatic memory is ON/);
    assert.match(on, /do not ask whether to save it/i);

    // The rules ride on both.
    for (const text of [off, on]) {
        assert.match(text, /NEVER save a credential/);
    }
    rmSync(dir, { recursive: true, force: true });
});

test("UserPromptSubmit injects a save-nothing rubric while the opt-in is off", () => {
    const dir = freshCredsDir();
    const prompt = "I always use pnpm and my staging canary is coral-fox-77.";

    const off = runHook(
        "on_user_prompt.mjs",
        { prompt, session_id: `off-${Math.random().toString(16).slice(2)}` },
        { MEMWAL_CREDS_DIR: dir },
    );
    assert.match(off, /Automatic saving is OFF/);
    assert.match(off, /save ONLY what they ask you to save/);
    assert.doesNotMatch(off, /call memwal_remember \(or memwal_remember_bulk for several\)/);
    // Recall stays on: it reads, it does not write.
    assert.match(off, /call memwal_recall first/);
    assert.match(off, /NEVER save a credential/);

    writeSettings(dir, { autoSave: true });
    const on = runHook(
        "on_user_prompt.mjs",
        { prompt, session_id: `on-${Math.random().toString(16).slice(2)}` },
        { MEMWAL_CREDS_DIR: dir },
    );
    assert.match(on, /call memwal_remember \(or memwal_remember_bulk for several\)/);
    assert.match(on, /NEVER save a credential/);
    rmSync(dir, { recursive: true, force: true });
});

test("PostToolUse stops nudging a save after an error while the opt-in is off", () => {
    const dir = freshCredsDir();
    // Must trip `detectError` in lib/signals.mjs (a strong marker) and clear
    // the hook's 50-character minimum, or the hook stays silent for reasons
    // that have nothing to do with the opt-in.
    const errorOutput =
        "fatal: could not read from remote repository — please make sure you " +
        "have the correct access rights and the repository exists.";
    const input = { tool_name: "Bash", tool_response: { stdout: "", stderr: errorOutput } };

    const off = runHook("on_post_tool.mjs", input, { MEMWAL_CREDS_DIR: dir });
    assert.match(off, /memwal_recall/);
    assert.match(off, /Automatic saving is OFF/);
    assert.doesNotMatch(off, /save the fix with memwal_remember/);

    writeSettings(dir, { autoSave: true });
    const on = runHook("on_post_tool.mjs", input, { MEMWAL_CREDS_DIR: dir });
    assert.match(on, /save the fix with memwal_remember/);
    // Error output is where a credential most often is; say so at the nudge.
    assert.match(on, /Never save passwords, keys, tokens/);
    rmSync(dir, { recursive: true, force: true });
});

test("a hook with the opt-in off still exits 0 and never blocks the session", () => {
    const dir = freshCredsDir();
    for (const script of ["on_session_start.mjs", "on_user_prompt.mjs", "on_post_tool.mjs"]) {
        const result = spawnSync(process.execPath, [join(SCRIPTS, script)], {
            input: JSON.stringify({ prompt: "a reasonably long prompt about pnpm" }),
            encoding: "utf8",
            env: { ...process.env, MEMWAL_CREDS_DIR: dir, MEMWAL_AUTO_SAVE: "" },
        });
        assert.equal(result.status, 0, `${script}: ${result.stderr}`);
    }
    rmSync(dir, { recursive: true, force: true });
});

// ── the surface a user actually turns it on from ────────────────────────────

test("`auto-save` parses as a subcommand, and a bare one only reports", () => {
    // A bare `auto-save` must not be read as consent to turn it ON — the
    // difference between reporting a setting and changing one.
    assert.equal(parseArgs(["auto-save"]).autoSave, "status");
    assert.equal(parseArgs(["auto-save", "on"]).autoSave, "on");
    assert.equal(parseArgs(["auto-save", "off"]).autoSave, "off");
    assert.equal(parseArgs(["auto-save", "status"]).autoSave, "status");
    assert.equal(parseArgs(["--auto-save", "on"]).autoSave, "on");

    // Not a flag, so it must not be reported as an unrecognised one.
    assert.deepEqual(parseArgs(["auto-save", "on"]).unknown, []);
    // ...and it must not collide with the other subcommand.
    assert.equal(parseArgs(["login"]).autoSave, undefined);
    assert.equal(parseArgs(["auto-save", "on"]).forceLogin, false);
});

test("a typo'd flag does not swallow the subcommand or its value", () => {
    // `--typo` consumes one following token as its value — unless that token
    // is a command. Without the exemption `memwal-mcp --typo auto-save on`
    // would silently run the server instead.
    const parsed = parseArgs(["--typo", "auto-save", "on"]);
    assert.deepEqual(parsed.unknown, ["--typo"]);
    assert.equal(parsed.autoSave, "on");
});

test("--help tells the user the setting exists and that it is off by default", () => {
    // The plugin install path never shows a terminal, so --help and the
    // post-login summary are where the choice reaches a person.
    const help = helpText();
    assert.match(help, /auto-save on\|off/);
    assert.match(help, /OFF by default/);
    assert.match(help, /MEMWAL_AUTO_SAVE/);
    // And that credentials are excluded regardless of which way it is set.
    assert.match(help, /Credentials/);
});
