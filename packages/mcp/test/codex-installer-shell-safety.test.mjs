/**
 * WALM-641: the Codex hooks installer must not let the install path reach a
 * shell as syntax.
 *
 * The installer substitutes its own directory into the hook commands it writes
 * to ~/.codex/hooks.json. That substitution used to run over the template
 * *text* before JSON.parse, so a plugin directory containing `$(...)`, a
 * backtick, quotes or a backslash landed unescaped in both the JSON document
 * and the generated shell command -- running the hook executed whatever the
 * path said.
 *
 * The end-to-end tests install from a deliberately hostile directory and run
 * the generated commands with a stub `node` that only prints its argv, so the
 * path is checked for round-trip fidelity without executing a real hook. The
 * substitution unit tests then cover paths Node itself cannot host, notably
 * backslashes (the ESM loader rejects any module specifier containing one).
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
    cpSync,
    existsSync,
    mkdirSync,
    mkdtempSync,
    readFileSync,
    realpathSync,
    rmSync,
    writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
    shellQuote,
    substituteHookPlaceholder,
} from "../plugin/scripts/lib/hook-template.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PLUGIN_SOURCE = resolve(__dirname, "../plugin");

/**
 * One path segment carrying every construct a shell acts on that a directory
 * name may legally contain *and* Node can still load a module from: a command
 * substitution, a backtick substitution, a command separator, a single quote, a
 * double quote and spaces. Both substitutions create a canary file, so an
 * escape leaves evidence even if its output goes nowhere.
 *
 * Backslashes are covered by the unit tests below instead: Node's ESM loader
 * refuses every module specifier containing one, so no plugin can be installed
 * from such a directory in the first place.
 */
const HOSTILE_SEGMENT = [
    "memwal",
    "$(touch subst-canary; echo PATH_SUBSTITUTION_EXECUTED)",
    "`touch backtick-canary; echo BACKTICK_EXECUTED`",
    "it's",
    '"quoted"',
    "end",
].join(" ");

const HOOK_SCRIPTS = ["on_session_start.mjs", "on_user_prompt.mjs", "on_post_tool.mjs"];

// The stub separates arguments with an ASCII record separator rather than a
// newline, so a value containing a newline is still read back exactly.
const RS = "\u001e";

const root = realpathSync(
    mkdtempSync(join(process.env.TMPDIR || tmpdir(), "codex-shell-safety-"))
);
after(() => rmSync(root, { recursive: true, force: true }));

const pluginRoot = join(root, HOSTILE_SEGMENT);
const home = join(root, "home");
const canaryDir = join(root, "canaries");
const fakeBin = join(root, "bin");

cpSync(PLUGIN_SOURCE, pluginRoot, { recursive: true });
for (const dir of [home, canaryDir, fakeBin]) mkdirSync(dir, { recursive: true });

// A stub `node` that prints its arguments instead of running a hook.
writeFileSync(
    join(fakeBin, "node"),
    '#!/bin/sh\nfor arg in "$@"; do printf "%s\\036" "$arg"; done\n',
    { mode: 0o755 }
);

const install = spawnSync(
    process.execPath,
    [join(pluginRoot, "scripts", "install_codex_hooks.mjs")],
    {
        env: { ...process.env, HOME: home, USERPROFILE: home },
        cwd: canaryDir,
        encoding: "utf8",
    }
);

/** Run a shell command with the stub node on PATH and read back its argv. */
function argvFor(command) {
    const result = spawnSync("/bin/sh", ["-c", command], {
        env: {
            ...process.env,
            HOME: home,
            USERPROFILE: home,
            PATH: `${fakeBin}:${process.env.PATH}`,
        },
        cwd: canaryDir,
        encoding: "utf8",
    });
    assert.equal(result.status, 0, `${command}\n${result.stderr}`);
    return result.stdout.split(RS).slice(0, -1);
}

/** Every `command` in a hooks file, in document order. */
function hookCommands(file = join(home, ".codex", "hooks.json")) {
    const config = JSON.parse(readFileSync(file, "utf8"));
    const commands = [];
    for (const entries of Object.values(config.hooks || {})) {
        for (const entry of entries) {
            for (const hook of entry.hooks || []) commands.push(hook.command);
        }
    }
    return commands;
}

test("installing from a hostile path succeeds and writes parseable JSON", () => {
    assert.equal(install.status, 0, `${install.stdout}\n${install.stderr}`);
    const commands = hookCommands();
    assert.equal(commands.length, HOOK_SCRIPTS.length);
    for (const script of HOOK_SCRIPTS) {
        assert.ok(
            commands.some((command) => command.includes(script)),
            `no hook command references ${script}: ${JSON.stringify(commands)}`
        );
    }
});

test("generated hook commands do not execute anything the path spells out", () => {
    for (const command of hookCommands()) {
        const argv = argvFor(command);
        assert.equal(argv.length, 1, `expected one argument, got ${JSON.stringify(argv)}`);
        // The substitutions arrive as inert text, not as their output.
        assert.ok(argv[0].includes("$(touch subst-canary;"), argv[0]);
        assert.ok(argv[0].includes("`touch backtick-canary;"), argv[0]);
    }
    assert.ok(!existsSync(join(canaryDir, "subst-canary")), "command substitution ran");
    assert.ok(!existsSync(join(canaryDir, "backtick-canary")), "backtick substitution ran");
});

test("the hostile path survives the round trip verbatim as a single argument", () => {
    const seen = new Set();
    for (const command of hookCommands()) {
        const argv = argvFor(command);
        assert.equal(argv.length, 1, `expected one argument, got ${JSON.stringify(argv)}`);
        assert.equal(dirname(dirname(argv[0])), pluginRoot);
        seen.add(argv[0]);
    }
    assert.deepEqual(
        [...seen].sort(),
        HOOK_SCRIPTS.map((script) => join(pluginRoot, "scripts", script)).sort()
    );
});

test("shellQuote survives every shell metacharacter, backslashes included", () => {
    const values = [
        "/plain/path",
        "/with space/dir",
        "/with/$(echo SUBST)",
        "/with/`echo TICK`",
        "/with/it's",
        '/with/"double"',
        "/with/back\\slash",
        "/with/back\\\\slash",
        "/with/$HOME and ${HOME}",
        "/with/;rm -rf .;",
        "/with/new\nline",
        "/with/'''",
        "/with/*?[a-z]",
        'C:\\Program Files\\mem"wal\\$(x)',
    ];
    for (const value of values) {
        assert.deepEqual(argvFor(`printf '%s\\036' ${shellQuote(value)}`), [value]);
    }
});

test("substitution quotes the plugin root into commands and leaves JSON intact", () => {
    const template = JSON.parse(
        readFileSync(join(PLUGIN_SOURCE, "hooks", "codex-hooks.json"), "utf8")
    );
    const hostileRoot = 'C:\\mem"wal\\$(touch pwned)\\`id`\\it\'s here';
    const substituted = substituteHookPlaceholder(template, "${PLUGIN_ROOT}", hostileRoot);

    // A path full of JSON escapes survives a write/read cycle unchanged.
    const file = join(root, "substituted.json");
    writeFileSync(file, JSON.stringify(substituted, null, 2) + "\n");
    assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), substituted);

    const commands = hookCommands(file);
    assert.equal(commands.length, HOOK_SCRIPTS.length);
    for (const command of commands) {
        const argv = argvFor(command);
        assert.equal(argv.length, 1, `expected one argument, got ${JSON.stringify(argv)}`);
        assert.ok(argv[0].startsWith(`${hostileRoot}/scripts/`), argv[0]);
    }
    assert.ok(!existsSync(join(canaryDir, "pwned")), "command substitution ran");
});

test("an argv array under `command` is substituted literally, not quoted", () => {
    const substituted = substituteHookPlaceholder(
        { hooks: { E: [{ hooks: [{ command: ["node", "${PLUGIN_ROOT}/x.mjs"] }] }] } },
        "${PLUGIN_ROOT}",
        "/it's here"
    );
    assert.deepEqual(substituted.hooks.E[0].hooks[0].command, ["node", "/it's here/x.mjs"]);
});
