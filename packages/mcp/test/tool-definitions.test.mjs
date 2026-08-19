/**
 * Cold-start tool descriptions (served before the relayer session is up)
 * must match the sidecar's proactive wording. Claude Code often keeps the
 * first tools/list; "Call ONLY when the user explicitly asks" made the
 * model ignore SessionStart / UserPromptSubmit hooks.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { TOOL_DEFINITIONS } from "../dist/auth-required.js";

function desc(name) {
    const tool = TOOL_DEFINITIONS.find((t) => t.name === name);
    assert.ok(tool, `missing ${name}`);
    return tool.description;
}

test("memwal_remember cold-start description is proactive", () => {
    const d = desc("memwal_remember");
    assert.match(d, /PROACTIVELY/);
    assert.doesNotMatch(d, /Call ONLY when the user explicitly asks/);
});

test("memwal_recall cold-start description is proactive", () => {
    const d = desc("memwal_recall");
    assert.match(d, /PROACTIVELY/);
});
