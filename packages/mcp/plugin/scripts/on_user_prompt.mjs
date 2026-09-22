/**
 * UserPromptSubmit hook — remind the agent that it chooses remember vs
 * recall from meaning. No keyword classify, no fetch, no network.
 *
 * The agent has the conversation and understands any language or spelling;
 * a regex cannot. This only injects a decision rubric.
 *
 * WALM-642: which rubric depends on the user's automatic-save opt-in, read
 * from the same place the MCP server reads it. With the opt-in off — the
 * default — the injected text tells the agent to save only what the user asks
 * for, so this hook can no longer be the thing that drives an unasked-for save.
 */
import { readStdin, emitContext, firstTime } from "./lib/hook-io.mjs";
import {
    buildDecisionRubric,
    buildDecisionRubricNudge,
} from "./lib/decision-rubric.mjs";
import { isAutoSaveEnabled } from "./lib/auto-save.mjs";

const input = readStdin();
const prompt = (input.prompt || "").toString();
const sessionId = input.session_id || "default";

// 8 chars lets terse preferences through ("Tui thích pnpm" is 14).
// Acks like "ok" / "yes" stay quiet. Deliberate: not a keyword gate.
if (prompt.trim().length < 8) process.exit(0);

const autoSave = isAutoSaveEnabled();
const text = firstTime("rubric", sessionId)
    ? buildDecisionRubric({ autoSave })
    : buildDecisionRubricNudge({ autoSave });
emitContext("UserPromptSubmit", text);
process.exit(0);
