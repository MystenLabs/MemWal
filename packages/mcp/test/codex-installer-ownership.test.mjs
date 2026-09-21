/**
 * WALM-643: the Codex hooks installer must remove its own hooks and nothing
 * else.
 *
 * Ownership used to be decided by substring — any command containing
 * `on_user_prompt.mjs` (or another of our generic hook filenames) counted as
 * ours — and the match then removed the whole hook group. A company's own
 * `/company/security/on_user_prompt.mjs` therefore disappeared on install and
 * on uninstall, and took its unrelated siblings in the same group with it.
 *
 * These tests drive the real installer against a ~/.codex/hooks.json seeded
 * with foreign hooks, across install, reinstall and uninstall.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = resolve(__dirname, "../plugin");
const INSTALLER = join(PLUGIN_ROOT, "scripts", "install_codex_hooks.mjs");
const TEMPLATE_FILE = join(PLUGIN_ROOT, "hooks", "codex-hooks.json");

const MARKER_KEY = "_memwal";

/** A foreign tool whose hook filename happens to collide with one of ours. */
const FOREIGN_PROMPT_HOOK = {
    type: "command",
    command: 'node "/company/security/on_user_prompt.mjs"',
    timeout: 30,
};
const FOREIGN_SIBLING_HOOK = {
    type: "command",
    command: 'node "/company/security/enforce-policy.mjs"',
    timeout: 30,
};
const FOREIGN_GROUP = {
    matcher: "*",
    statusMessage: "Running company policy checks...",
    hooks: [FOREIGN_PROMPT_HOOK, FOREIGN_SIBLING_HOOK],
};
const FOREIGN_CONFIG = {
    hooks: {
        UserPromptSubmit: [structuredClone(FOREIGN_GROUP)],
        SessionStart: [
            {
                matcher: "startup",
                hooks: [
                    {
                        type: "command",
                        command: 'node "/company/security/on_session_start.mjs"',
                    },
                ],
            },
        ],
    },
};

/**
 * The command a pre-WALM-643 build wrote for this plugin directory: raw
 * placeholder substitution over the template text.
 */
function legacyCommandFor(event) {
    const raw = readFileSync(TEMPLATE_FILE, "utf8").replaceAll("${PLUGIN_ROOT}", PLUGIN_ROOT);
    return JSON.parse(raw).hooks[event][0].hooks[0].command;
}

function makeHome(t, config) {
    const home = mkdtempSync(join(process.env.TMPDIR || tmpdir(), "codex-ownership-"));
    t.after(() => rmSync(home, { recursive: true, force: true }));
    mkdirSync(join(home, ".codex"), { recursive: true });
    if (config) {
        writeFileSync(join(home, ".codex", "hooks.json"), JSON.stringify(config, null, 2) + "\n");
    }
    return home;
}

function runInstaller(home, ...args) {
    const result = spawnSync(process.execPath, [INSTALLER, ...args], {
        env: { ...process.env, HOME: home, USERPROFILE: home },
        encoding: "utf8",
    });
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    return result;
}

function readHooks(home) {
    return JSON.parse(readFileSync(join(home, ".codex", "hooks.json"), "utf8"));
}

/** Groups in `event` that hold at least one hook this installer claims. */
function memwalGroups(config, event) {
    return (config.hooks[event] || []).filter((entry) =>
        (entry.hooks || []).some((hook) => hook[MARKER_KEY] !== undefined)
    );
}

function foreignGroups(config, event) {
    return (config.hooks[event] || []).filter((entry) =>
        (entry.hooks || []).every((hook) => hook[MARKER_KEY] === undefined)
    );
}

test("install keeps a foreign hook whose filename collides with ours", (t) => {
    const home = makeHome(t, FOREIGN_CONFIG);
    runInstaller(home);
    const config = readHooks(home);

    assert.deepEqual(foreignGroups(config, "UserPromptSubmit"), [FOREIGN_GROUP]);
    assert.deepEqual(foreignGroups(config, "SessionStart"), FOREIGN_CONFIG.hooks.SessionStart);
    assert.equal(memwalGroups(config, "UserPromptSubmit").length, 1);
    assert.equal(memwalGroups(config, "SessionStart").length, 1);
});

test("install marks its own hooks", (t) => {
    const home = makeHome(t);
    runInstaller(home);
    const config = readHooks(home);
    for (const event of ["SessionStart", "UserPromptSubmit", "PostToolUse"]) {
        const groups = config.hooks[event];
        assert.equal(groups.length, 1, event);
        for (const hook of groups[0].hooks) assert.equal(hook[MARKER_KEY], "memwal-plugin-hooks");
    }
});

test("reinstalling is idempotent and leaves foreign hooks alone", (t) => {
    const home = makeHome(t, FOREIGN_CONFIG);
    runInstaller(home);
    const first = readHooks(home);
    runInstaller(home);
    const second = readHooks(home);

    assert.deepEqual(second, first);
    for (const event of ["SessionStart", "UserPromptSubmit", "PostToolUse"]) {
        assert.equal(memwalGroups(second, event).length, 1, `duplicate MemWal group in ${event}`);
    }
    assert.deepEqual(foreignGroups(second, "UserPromptSubmit"), [FOREIGN_GROUP]);
});

test("uninstall removes only our hooks and restores the file to its old state", (t) => {
    const home = makeHome(t, FOREIGN_CONFIG);
    runInstaller(home);
    runInstaller(home, "--uninstall");
    assert.deepEqual(readHooks(home), FOREIGN_CONFIG);
});

test("a foreign sibling survives when our hook is removed from its group", (t) => {
    // A group holding a foreign hook, our hook, and another foreign hook. Only
    // the middle one is ours; the group and its settings must survive.
    const ours = {
        type: "command",
        command: legacyCommandFor("UserPromptSubmit"),
        timeout: 12,
    };
    const shared = {
        matcher: "*",
        statusMessage: "Running company policy checks...",
        hooks: [FOREIGN_PROMPT_HOOK, ours, FOREIGN_SIBLING_HOOK],
    };
    const home = makeHome(t, { hooks: { UserPromptSubmit: [shared] } });

    runInstaller(home, "--uninstall");
    const config = readHooks(home);
    assert.deepEqual(config.hooks.UserPromptSubmit, [
        {
            matcher: "*",
            statusMessage: "Running company policy checks...",
            hooks: [FOREIGN_PROMPT_HOOK, FOREIGN_SIBLING_HOOK],
        },
    ]);
});

test("an install predating the ownership marker is still replaced, not duplicated", (t) => {
    const legacy = {
        hooks: {
            UserPromptSubmit: [
                {
                    hooks: [
                        {
                            type: "command",
                            command: legacyCommandFor("UserPromptSubmit"),
                            timeout: 12,
                        },
                    ],
                },
            ],
        },
    };
    const home = makeHome(t, legacy);

    runInstaller(home);
    const config = readHooks(home);
    assert.equal(config.hooks.UserPromptSubmit.length, 1);
    assert.equal(config.hooks.UserPromptSubmit[0].hooks.length, 1);
    assert.equal(
        config.hooks.UserPromptSubmit[0].hooks[0][MARKER_KEY],
        "memwal-plugin-hooks"
    );

    runInstaller(home, "--uninstall");
    assert.deepEqual(readHooks(home), { hooks: {} });
});

test("an emptied group is dropped, but an event keeping foreign groups is not", (t) => {
    const home = makeHome(t, FOREIGN_CONFIG);
    runInstaller(home);
    runInstaller(home, "--uninstall");
    const config = readHooks(home);

    assert.deepEqual(Object.keys(config.hooks).sort(), ["SessionStart", "UserPromptSubmit"]);
    // PostToolUse held only our group, so the event is gone entirely.
    assert.equal(config.hooks.PostToolUse, undefined);
});
